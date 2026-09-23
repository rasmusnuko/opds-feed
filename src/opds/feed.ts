import { config } from '../config.js';
import type { ArticleRow } from '../db.js';
import { escapeXml, formatBytes, stripControlChars, truncate } from '../util/text.js';

export const NAVIGATION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const ACQUISITION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const OPENSEARCH_TYPE = 'application/opensearchdescription+xml';
export const ACQUISITION_REL = 'http://opds-spec.org/acquisition';
export const IMAGE_REL = 'http://opds-spec.org/image';
export const THUMBNAIL_REL = 'http://opds-spec.org/image/thumbnail';

export interface Link {
  rel: string;
  href: string;
  type: string;
  title?: string;
  length?: number;
}

function renderLink(link: Link): string {
  const parts = [
    `rel="${escapeXml(link.rel)}"`,
    `href="${escapeXml(link.href)}"`,
    `type="${escapeXml(link.type)}"`,
  ];
  if (link.title) parts.push(`title="${escapeXml(link.title)}"`);
  if (link.length !== undefined) parts.push(`length="${link.length}"`);
  return `  <link ${parts.join(' ')}/>`;
}

function isoOrNow(value: string | null | undefined): string {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

export interface NavigationEntry {
  id: string;
  title: string;
  summary: string;
  href: string;
  type: string;
  updated?: string;
}

interface FeedShell {
  id: string;
  title: string;
  updated: string;
  links: Link[];
  body: string;
  /** OpenSearch paging hints, included on acquisition feeds only. */
  paging?: { total: number; itemsPerPage: number; startIndex: number };
}

function renderFeed(shell: FeedShell): string {
  const paging = shell.paging
    ? `  <opensearch:totalResults>${shell.paging.total}</opensearch:totalResults>\n` +
      `  <opensearch:itemsPerPage>${shell.paging.itemsPerPage}</opensearch:itemsPerPage>\n` +
      `  <opensearch:startIndex>${shell.paging.startIndex}</opensearch:startIndex>\n`
    : '';

  return stripControlChars(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:dc="http://purl.org/dc/terms/"
      xmlns:opds="http://opds-spec.org/2010/catalog"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>${escapeXml(shell.id)}</id>
  <title>${escapeXml(shell.title)}</title>
  <updated>${shell.updated}</updated>
  <author>
    <name>${escapeXml(config.catalogAuthor)}</name>
  </author>
${paging}${shell.links.map(renderLink).join('\n')}
${shell.body}
</feed>
`);
}

export function navigationFeed(options: {
  base: string;
  id: string;
  title: string;
  selfHref: string;
  upHref?: string;
  entries: NavigationEntry[];
}): string {
  const updated = new Date().toISOString();

  const links: Link[] = [
    { rel: 'self', href: options.selfHref, type: NAVIGATION_TYPE },
    { rel: 'start', href: `${options.base}/opds`, type: NAVIGATION_TYPE, title: config.catalogTitle },
    { rel: 'search', href: `${options.base}/opds/search.xml`, type: OPENSEARCH_TYPE, title: 'Search articles' },
  ];
  if (options.upHref) {
    links.push({ rel: 'up', href: options.upHref, type: NAVIGATION_TYPE });
  }

  const body = options.entries
    .map(
      (entry) => `  <entry>
    <id>${escapeXml(entry.id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${entry.updated ?? updated}</updated>
    <content type="text">${escapeXml(entry.summary)}</content>
    <link rel="subsection" href="${escapeXml(entry.href)}" type="${escapeXml(entry.type)}"/>
  </entry>`,
    )
    .join('\n');

  return renderFeed({ id: options.id, title: options.title, updated, links, body });
}

function articleEntry(article: ArticleRow, base: string, tags: string[]): string {
  const updated = isoOrNow(article.updated_at);
  const published = isoOrNow(article.published_at ?? article.added_at);

  const summaryBits = [
    article.site,
    article.reading_minutes > 0 ? `${article.reading_minutes} min read` : null,
    article.epub_size ? formatBytes(article.epub_size) : null,
    article.paywall ? '⚠ paywall stub' : null,
  ].filter((bit): bit is string => Boolean(bit && bit.length > 0));

  const summary = [summaryBits.join(' · '), article.excerpt ?? '']
    .filter((part) => part.length > 0)
    .join(' — ');

  const links: Link[] = [
    {
      rel: ACQUISITION_REL,
      href: `${base}/download/${article.id}.epub`,
      type: 'application/epub+zip',
      title: 'Download EPUB',
      length: article.epub_size ?? undefined,
    },
  ];

  if (article.cover_path) {
    links.push({ rel: IMAGE_REL, href: `${base}/covers/${article.id}.jpg`, type: 'image/jpeg' });
  }
  if (article.thumb_path) {
    links.push({ rel: THUMBNAIL_REL, href: `${base}/covers/${article.id}-thumb.jpg`, type: 'image/jpeg' });
  }

  const author = article.author ?? article.site;
  const categories = tags
    .map((tag) => `    <category term="${escapeXml(tag)}" label="${escapeXml(tag)}"/>`)
    .join('\n');

  return `  <entry>
    <id>urn:opds-feed:article:${escapeXml(article.id)}</id>
    <title>${escapeXml(article.title)}</title>
    <updated>${updated}</updated>
    <published>${published}</published>
${author ? `    <author><name>${escapeXml(author)}</name></author>\n` : ''}${
    article.site ? `    <dc:publisher>${escapeXml(article.site)}</dc:publisher>\n` : ''
  }${article.language ? `    <dc:language>${escapeXml(article.language)}</dc:language>\n` : ''}    <dc:issued>${published}</dc:issued>
    <dc:source>${escapeXml(article.canonical_url ?? article.url)}</dc:source>
${categories}${categories ? '\n' : ''}    <summary type="text">${escapeXml(truncate(summary, 500))}</summary>
${links.map((link) => `  ${renderLink(link)}`).join('\n')}
  </entry>`;
}

export interface AcquisitionFeedOptions {
  base: string;
  id: string;
  title: string;
  selfHref: string;
  upHref: string;
  articles: ArticleRow[];
  tagsFor: (article: ArticleRow) => string[];
  page: number;
  pageSize: number;
  total: number;
}

function withPage(href: string, page: number): string {
  const separator = href.includes('?') ? '&' : '?';
  return page <= 1 ? href : `${href}${separator}page=${page}`;
}

export function acquisitionFeed(options: AcquisitionFeedOptions): string {
  const updated =
    options.articles.length > 0 ? isoOrNow(options.articles[0]!.updated_at) : new Date().toISOString();

  const lastPage = Math.max(1, Math.ceil(options.total / options.pageSize));

  const links: Link[] = [
    { rel: 'self', href: withPage(options.selfHref, options.page), type: ACQUISITION_TYPE },
    { rel: 'start', href: `${options.base}/opds`, type: NAVIGATION_TYPE, title: config.catalogTitle },
    { rel: 'up', href: options.upHref, type: NAVIGATION_TYPE },
    { rel: 'search', href: `${options.base}/opds/search.xml`, type: OPENSEARCH_TYPE, title: 'Search articles' },
  ];

  // Readers page through the catalogue with these; without them they only ever see page one.
  if (options.page > 1) {
    links.push({ rel: 'first', href: withPage(options.selfHref, 1), type: ACQUISITION_TYPE });
    links.push({ rel: 'previous', href: withPage(options.selfHref, options.page - 1), type: ACQUISITION_TYPE });
  }
  if (options.page < lastPage) {
    links.push({ rel: 'next', href: withPage(options.selfHref, options.page + 1), type: ACQUISITION_TYPE });
    links.push({ rel: 'last', href: withPage(options.selfHref, lastPage), type: ACQUISITION_TYPE });
  }

  const body = options.articles
    .map((article) => articleEntry(article, options.base, options.tagsFor(article)))
    .join('\n');

  return renderFeed({
    id: options.id,
    title: options.title,
    updated,
    links,
    body,
    paging: {
      total: options.total,
      itemsPerPage: options.pageSize,
      startIndex: (options.page - 1) * options.pageSize + 1,
    },
  });
}

export function openSearchDescription(base: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${escapeXml(truncate(config.catalogTitle, 16))}</ShortName>
  <Description>Search ${escapeXml(config.catalogTitle)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${ACQUISITION_TYPE}" template="${escapeXml(base)}/opds/search?q={searchTerms}"/>
</OpenSearchDescription>
`;
}
