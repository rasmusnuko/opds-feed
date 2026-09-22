import { errorFields, log } from '../logger.js';
import { collapseWhitespace, countWords, truncate } from '../util/text.js';
import { cleanUrl, hostLabel } from '../util/url.js';
import { parseHtml } from './dom.js';
import { LOCATORS, type Located, type LocateContext } from './locate/index.js';

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  language: string | null;
  publishedAt: string | null;
  canonicalUrl: string;
  leadImageUrl: string | null;
  textContent: string;
  wordCount: number;
  /** Name of the locator that found the body (see locate/index.ts). */
  extractor: string;
  /** Sanitised article body. Images still point at their remote URLs. */
  content: Element;
  /** Keeps the owning window alive; call when the DOM is no longer needed. */
  dispose: () => void;
}

/** Elements whose content is never useful in an EPUB. */
const DROP_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'select', 'textarea', 'button', 'label', 'canvas', 'svg', 'math', 'video',
  'audio', 'source', 'track', 'map', 'area', 'link', 'meta', 'base', 'template', 'dialog',
]);

/** Elements we keep, with the attributes allowed to survive on each. */
const ALLOWED_ELEMENTS = new Map<string, Set<string>>([
  ['p', new Set()],
  ['br', new Set()],
  ['hr', new Set()],
  ['h1', new Set()], ['h2', new Set()], ['h3', new Set()],
  ['h4', new Set()], ['h5', new Set()], ['h6', new Set()],
  ['ul', new Set()], ['ol', new Set()], ['li', new Set()],
  ['dl', new Set()], ['dt', new Set()], ['dd', new Set()],
  ['blockquote', new Set()], ['pre', new Set()], ['code', new Set()],
  ['em', new Set()], ['strong', new Set()], ['i', new Set()], ['b', new Set()],
  ['u', new Set()], ['s', new Set()], ['sub', new Set()], ['sup', new Set()],
  ['small', new Set()], ['mark', new Set()], ['cite', new Set()], ['q', new Set()],
  ['abbr', new Set()], ['time', new Set()], ['span', new Set()], ['div', new Set()],
  ['figure', new Set()], ['figcaption', new Set()],
  ['a', new Set(['href'])],
  ['img', new Set(['src', 'alt'])],
  ['table', new Set()], ['caption', new Set()],
  ['thead', new Set()], ['tbody', new Set()], ['tfoot', new Set()],
  ['tr', new Set()],
  ['th', new Set(['colspan', 'rowspan'])],
  ['td', new Set(['colspan', 'rowspan'])],
]);

/** Block-level tags that are safe to unwrap into a plain div. */
const UNWRAP_TO_DIV = new Set(['section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'details', 'summary']);

function firstMeta(doc: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    const value = element?.getAttribute('content') ?? element?.getAttribute('datetime') ?? element?.textContent;
    if (value) {
      const clean = collapseWhitespace(value);
      if (clean.length > 0) return clean;
    }
  }
  return null;
}

interface JsonLdNode {
  '@type'?: unknown;
  '@graph'?: unknown;
  author?: unknown;
  name?: unknown;
  datePublished?: unknown;
  dateCreated?: unknown;
  headline?: unknown;
  publisher?: unknown;
  [key: string]: unknown;
}

const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting', 'Report', 'TechArticle', 'ScholarlyArticle']);

function collectJsonLd(doc: Document): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Malformed JSON-LD is extremely common; just skip it.
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const item = queue.pop();
      if (Array.isArray(item)) {
        queue.push(...item);
      } else if (item && typeof item === 'object') {
        const node = item as JsonLdNode;
        nodes.push(node);
        if (node['@graph']) queue.push(node['@graph']);
      }
    }
  }
  return nodes;
}

function jsonLdArticle(nodes: JsonLdNode[]): JsonLdNode | null {
  for (const node of nodes) {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((candidate) => typeof candidate === 'string' && ARTICLE_TYPES.has(candidate))) {
      return node;
    }
  }
  return null;
}

function jsonLdAuthor(node: JsonLdNode | null): string | null {
  if (!node) return null;
  const author = node.author;
  const names: string[] = [];
  const candidates = Array.isArray(author) ? author : [author];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      names.push(candidate);
    } else if (candidate && typeof candidate === 'object') {
      const name = (candidate as JsonLdNode).name;
      if (typeof name === 'string') names.push(name);
    }
  }
  const joined = collapseWhitespace(names.join(', '));
  return joined.length > 0 ? joined : null;
}

function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against obviously bogus dates from malformed metadata.
  const year = parsed.getUTCFullYear();
  if (year < 1900 || year > 2200) return null;
  return parsed.toISOString();
}

function pickFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0] ?? '';
      const descriptor = parts[1] ?? '';
      const width = /^(\d+)w$/.exec(descriptor);
      const density = /^([\d.]+)x$/.exec(descriptor);
      const score = width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1;
      return { url, score };
    })
    .filter((candidate) => candidate.url.length > 0);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.url;
}

const LAZY_SRC_ATTRIBUTES = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-hi-res-src'];

function resolveImageSource(img: Element, baseUrl: string): string | null {
  let candidate = img.getAttribute('src');

  // Lazy-loading markup usually leaves a placeholder in src and the real file elsewhere.
  if (!candidate || candidate.startsWith('data:image/gif') || /^\s*$/.test(candidate)) {
    for (const attribute of LAZY_SRC_ATTRIBUTES) {
      const lazy = img.getAttribute(attribute);
      if (lazy) {
        candidate = lazy;
        break;
      }
    }
  }

  const srcset = img.getAttribute('srcset') ?? img.getAttribute('data-srcset');
  if ((!candidate || candidate.startsWith('data:')) && srcset) {
    const best = pickFromSrcset(srcset);
    if (best) candidate = best;
  }

  if (!candidate) return null;
  if (candidate.startsWith('data:')) return candidate;

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function sanitize(root: Element, baseUrl: string): void {
  const doc = root.ownerDocument;

  const walk = (node: Element): void => {
    // Snapshot children: the loop rewrites the tree as it goes.
    for (const child of [...node.children]) walk(child);

    const tag = node.tagName.toLowerCase();

    if (DROP_ELEMENTS.has(tag)) {
      node.remove();
      return;
    }

    if (tag === 'img') {
      const src = resolveImageSource(node, baseUrl);
      if (!src) {
        node.remove();
        return;
      }
      const alt = node.getAttribute('alt') ?? '';
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
      node.setAttribute('src', src);
      node.setAttribute('alt', collapseWhitespace(alt).slice(0, 300));
      return;
    }

    if (!ALLOWED_ELEMENTS.has(tag)) {
      const replacement = doc.createElement(UNWRAP_TO_DIV.has(tag) ? 'div' : 'span');
      while (node.firstChild) replacement.appendChild(node.firstChild);
      node.replaceWith(replacement);
      // The replacement holds already-sanitised children, so it needs no second pass.
      return;
    }

    const allowedAttributes = ALLOWED_ELEMENTS.get(tag)!;
    for (const attribute of [...node.attributes]) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) {
        node.removeAttribute(attribute.name);
      }
    }

    if (tag === 'a') {
      const href = node.getAttribute('href');
      if (!href) {
        node.removeAttribute('href');
        return;
      }
      let absolute: string | null = null;
      try {
        absolute = new URL(href, baseUrl).toString();
      } catch {
        absolute = null;
      }
      // Only plain web links survive; javascript: and friends become plain text.
      if (absolute && /^https?:/i.test(absolute)) {
        node.setAttribute('href', absolute);
      } else {
        node.removeAttribute('href');
      }
    }
  };

  walk(root);

  // Drop containers that ended up empty after sanitising.
  for (const element of [...root.querySelectorAll('p, div, span, li, figure, figcaption')]) {
    if (element.querySelector('img') !== null) continue;
    if (collapseWhitespace(element.textContent ?? '').length === 0) element.remove();
  }
}

/**
 * Readability usually keeps the page's own <h1>. We print the title ourselves in the EPUB,
 * so a leading heading that repeats it would show up twice.
 */
function dropDuplicateHeading(root: Element, title: string | null): void {
  if (!title) return;

  const normalise = (value: string): string =>
    collapseWhitespace(value).toLowerCase().replace(/[\s\p{P}]+/gu, '');

  const target = normalise(title);
  if (target.length === 0) return;

  const heading = root.querySelector('h1, h2');
  if (!heading) return;

  // Only strip it when it is genuinely at the top of the article body.
  const firstBlock = root.querySelector('h1, h2, h3, p, ul, ol, blockquote, figure, table, img');
  if (firstBlock !== heading) return;

  const headingText = normalise(heading.textContent ?? '');
  if (headingText.length > 0 && (headingText === target || target.startsWith(headingText) || headingText.startsWith(target))) {
    heading.remove();
  }
}

export interface ExtractOptions {
  /** HTML of the part of the page the user selected in their browser. */
  selection?: string | null;
}

function hasArticleText(content: Element): boolean {
  const text = collapseWhitespace(content.textContent ?? '');
  return text.length >= 120 || content.querySelector('img') !== null;
}

export async function extractArticle(html: string, url: string, options: ExtractOptions = {}): Promise<ExtractedArticle> {
  const dom = parseHtml(html, url);
  const doc = dom.window.document;

  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  let canonicalUrl = url;
  if (canonicalHref) {
    try {
      canonicalUrl = cleanUrl(new URL(canonicalHref, url).toString());
    } catch {
      canonicalUrl = url;
    }
  }

  const jsonLdNodes = collectJsonLd(doc);
  const jsonLd = jsonLdArticle(jsonLdNodes);

  const metaTitle = firstMeta(doc, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
  ]);
  const metaByline = firstMeta(doc, [
    'meta[property="article:author"]',
    'meta[name="author"]',
    'meta[property="book:author"]',
    'meta[name="parsely-author"]',
    'meta[name="byl"]',
    '[rel="author"]',
  ]);
  const metaSite = firstMeta(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const metaPublished = firstMeta(doc, [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[itemprop="datePublished"]',
    'meta[name="date"]',
    'meta[name="parsely-pub-date"]',
    'time[datetime]',
  ]);
  const metaImage = firstMeta(doc, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  const metaDescription = firstMeta(doc, [
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ]);

  const htmlLang = doc.documentElement.getAttribute('lang');
  const headline = typeof jsonLd?.headline === 'string' ? collapseWhitespace(jsonLd.headline) : null;

  // Walk the fallback chain. Locators never touch `doc`, so each one sees the page as fetched.
  const ctx: LocateContext = { doc, html, url, selection: options.selection ?? null };
  let located: Located | null = null;
  let extractor = '';
  for (const locator of LOCATORS) {
    let candidate: Located | null;
    try {
      candidate = await locator.locate(ctx);
    } catch (error) {
      log.warn('locator failed', { locator: locator.name, url, ...errorFields(error) });
      continue;
    }
    if (!candidate) continue;

    // Relative links and images resolve against the document we actually fetched, not the
    // canonical link, which may sit on a different path.
    sanitize(candidate.content, url);
    const candidateTitle = candidate.overrides?.title ?? metaTitle ?? headline ?? candidate.fallbacks?.title ?? null;
    dropDuplicateHeading(candidate.content, candidateTitle);

    if (hasArticleText(candidate.content)) {
      located = candidate;
      extractor = locator.name;
      break;
    }
    log.debug('locator result was empty', { locator: locator.name, url });
    candidate.dispose?.();
  }

  if (!located) {
    dom.window.close();
    throw new Error('Could not find any article text on the page (paywall, JavaScript-only page, or bot wall?)');
  }

  const { content, overrides = {}, fallbacks = {} } = located;
  const textContent = collapseWhitespace(content.textContent ?? '');

  const title =
    overrides.title ??
    metaTitle ??
    headline ??
    fallbacks.title ??
    collapseWhitespace(doc.querySelector('h1')?.textContent ?? '') ??
    '';

  const publisher =
    jsonLd?.publisher && typeof jsonLd.publisher === 'object'
      ? (jsonLd.publisher as JsonLdNode).name
      : undefined;

  const excerptSource = metaDescription ?? fallbacks.excerpt ?? textContent;

  const publishedAt =
    normaliseDate(overrides.publishedAt ?? null) ??
    normaliseDate(metaPublished) ??
    normaliseDate(typeof jsonLd?.datePublished === 'string' ? jsonLd.datePublished : null) ??
    normaliseDate(typeof jsonLd?.dateCreated === 'string' ? jsonLd.dateCreated : null);

  let leadImageUrl: string | null = null;
  if (metaImage) {
    try {
      leadImageUrl = new URL(metaImage, canonicalUrl).toString();
    } catch {
      leadImageUrl = null;
    }
  }

  const words = countWords(textContent);

  return {
    title: truncate(title.length > 0 ? title : (hostLabel(canonicalUrl) ?? 'Untitled'), 300),
    byline:
      overrides.byline ??
      metaByline ??
      jsonLdAuthor(jsonLd) ??
      (fallbacks.byline ? collapseWhitespace(fallbacks.byline) : null),
    siteName:
      metaSite ??
      (typeof publisher === 'string' ? collapseWhitespace(publisher) : null) ??
      fallbacks.siteName ??
      hostLabel(canonicalUrl),
    excerpt: excerptSource ? truncate(excerptSource, 400) : null,
    language: htmlLang ? htmlLang.split(',')[0]!.trim().slice(0, 10) : null,
    publishedAt,
    canonicalUrl,
    leadImageUrl,
    textContent,
    wordCount: words,
    extractor,
    content,
    dispose: () => {
      located.dispose?.();
      dom.window.close();
    },
  };
}
