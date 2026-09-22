import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { collapseWhitespace } from '../../util/text.js';
import { parseHtml } from '../dom.js';
import type { Locator, LocatedMeta } from './types.js';

/**
 * Step 1: hand-written rules per site, in the FiveFilters / ftr-site-config format
 * (https://github.com/fivefilters/ftr-site-config), so that whole collection can be
 * dropped into a rules directory as-is. See site-rules/README.md.
 *
 * Supported directives: body, title, author, date, strip, strip_id_or_class,
 * strip_image_src, find_string / replace_string, replace_string(find).
 * Everything else (prune, tidy, single_page_link, http_header, test_url, ...) is ignored.
 */

export interface SiteRule {
  source: string;
  body: string[];
  title: string[];
  author: string[];
  date: string[];
  strip: string[];
  stripIdOrClass: string[];
  stripImageSrc: string[];
  replacements: [find: string, replace: string][];
}

export function parseSiteRule(text: string, source: string): SiteRule {
  const rule: SiteRule = {
    source,
    body: [],
    title: [],
    author: [],
    date: [],
    strip: [],
    stripIdOrClass: [],
    stripImageSrc: [],
    replacements: [],
  };
  const finds: string[] = [];
  const replaces: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Split at the first colon, as the reference implementation does.
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const rawKey = line.slice(0, separator).trim();
    const key = rawKey.toLowerCase();
    const value = line.slice(separator + 1).trim();

    const inlineReplace = /^replace_string\((.*)\)$/i.exec(rawKey);
    if (inlineReplace) {
      rule.replacements.push([inlineReplace[1]!, value]);
      continue;
    }
    if (value === '') continue;

    switch (key) {
      case 'body': rule.body.push(value); break;
      case 'title': rule.title.push(value); break;
      case 'author': rule.author.push(value); break;
      case 'date': rule.date.push(value); break;
      case 'strip': rule.strip.push(value); break;
      case 'strip_id_or_class': rule.stripIdOrClass.push(value); break;
      case 'strip_image_src': rule.stripImageSrc.push(value); break;
      case 'find_string': finds.push(value); break;
      case 'replace_string': replaces.push(value); break;
      default: break;
    }
  }

  // find_string / replace_string lines pair up in order.
  for (let i = 0; i < Math.min(finds.length, replaces.length); i += 1) {
    rule.replacements.push([finds[i]!, replaces[i]!]);
  }
  return rule;
}

/**
 * Rule files are named after the host: `example.com.txt` matches example.com and
 * www.example.com; `.example.com.txt` matches any subdomain. The most specific name
 * wins, and for the same name the earlier directory in SITE_RULES_DIRS wins.
 */
export function ruleFileNames(hostname: string): string[] {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+$/.test(host)) return [];
  const labels = host.split('.');
  const names = [host];
  for (let i = 0; i < labels.length - 1; i += 1) {
    names.push(`.${labels.slice(i).join('.')}`);
  }
  return names;
}

export async function findSiteRule(url: string): Promise<SiteRule | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  for (const name of ruleFileNames(hostname)) {
    for (const directory of config.extract.siteRulesDirs) {
      const file = path.join(directory, `${name}.txt`);
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      return parseSiteRule(text, file);
    }
  }
  return null;
}

const ORDERED_NODE_SNAPSHOT_TYPE = 7;
const ANY_TYPE = 0;
const NUMBER_TYPE = 1;
const STRING_TYPE = 2;
const BOOLEAN_TYPE = 3;

function selectElements(doc: Document, xpath: string, source: string): Element[] {
  try {
    const result = doc.evaluate(xpath, doc, null, ORDERED_NODE_SNAPSHOT_TYPE, null);
    const elements: Element[] = [];
    for (let i = 0; i < result.snapshotLength; i += 1) {
      const node = result.snapshotItem(i);
      if (node && node.nodeType === 1) elements.push(node as Element);
    }
    return elements;
  } catch (error) {
    log.debug('site rule xpath failed', { source, xpath, error: String(error) });
    return [];
  }
}

/** title/author/date expressions may select nodes or compute a string, e.g. `string(//h1)`. */
function selectText(doc: Document, xpaths: string[], source: string): string | null {
  for (const xpath of xpaths) {
    let value = '';
    try {
      const result = doc.evaluate(xpath, doc, null, ANY_TYPE, null);
      if (result.resultType === STRING_TYPE) value = result.stringValue;
      else if (result.resultType === NUMBER_TYPE) value = String(result.numberValue);
      else if (result.resultType === BOOLEAN_TYPE) value = '';
      else {
        const node = result.iterateNext();
        value = (node as Element | null)?.getAttribute?.('content') ?? node?.textContent ?? '';
      }
    } catch (error) {
      log.debug('site rule xpath failed', { source, xpath, error: String(error) });
      continue;
    }
    const clean = collapseWhitespace(value);
    if (clean.length > 0) return clean;
  }
  return null;
}

/** An XPath string literal for arbitrary text (XPath 1.0 has no escape character). */
function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.split("'").join(`', "'", '`)}')`;
}

function removeAll(elements: Element[]): void {
  for (const element of elements) element.remove();
}

export const siteRulesLocator: Locator = {
  name: 'site-rules',
  async locate(ctx) {
    const rule = await findSiteRule(ctx.url);
    // TODO: a rule with only strip directives could clean the page for the later locators.
    if (!rule || rule.body.length === 0) return null;

    let doc: Document;
    let dispose: (() => void) | undefined;
    if (rule.replacements.length > 0) {
      let html = ctx.html;
      for (const [find, replace] of rule.replacements) html = html.split(find).join(replace);
      const dom = parseHtml(html, ctx.url);
      doc = dom.window.document;
      dispose = () => dom.window.close();
    } else {
      doc = ctx.doc.cloneNode(true) as Document;
    }

    // Metadata first: strip rules may remove the elements it lives in.
    const overrides: LocatedMeta = {
      title: selectText(doc, rule.title, rule.source),
      byline: selectText(doc, rule.author, rule.source),
      publishedAt: selectText(doc, rule.date, rule.source),
    };

    for (const xpath of rule.strip) removeAll(selectElements(doc, xpath, rule.source));
    for (const token of rule.stripIdOrClass) {
      const literal = xpathLiteral(token);
      removeAll(selectElements(doc, `//*[contains(@class, ${literal}) or contains(@id, ${literal})]`, rule.source));
    }
    for (const token of rule.stripImageSrc) {
      removeAll(selectElements(doc, `//img[contains(@src, ${xpathLiteral(token)})]`, rule.source));
    }

    for (const xpath of rule.body) {
      const all = selectElements(doc, xpath, rule.source);
      // A match nested inside another match is already part of it.
      const matches = all.filter((match) => !all.some((other) => other !== match && other.contains(match)));
      if (matches.length === 0) continue;

      let content: Element;
      if (matches.length === 1) {
        content = matches[0]!;
      } else {
        // Several matches (e.g. one per paragraph block) are joined in document order.
        content = doc.createElement('div');
        for (const match of matches) content.appendChild(match);
      }
      content.remove();
      log.debug('site rule matched', { source: rule.source, xpath });
      return { content, overrides, dispose };
    }

    log.info('site rule body did not match', { source: rule.source, url: ctx.url });
    dispose?.();
    return null;
  },
};
