import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import type { ArticleRow } from '../db.js';
import {
  countArticles,
  listArticles,
  listSites,
  listTags,
  tagsForArticles,
  type ArticleScope,
} from '../store.js';
import { parsePage, resolveBase } from '../util/base.js';
import { collapseWhitespace } from '../util/text.js';
import {
  ACQUISITION_TYPE,
  NAVIGATION_TYPE,
  OPENSEARCH_TYPE,
  acquisitionFeed,
  navigationFeed,
  openSearchDescription,
  type NavigationEntry,
} from './feed.js';

export const opdsRoutes = new Hono({ strict: false });

// Every page here is behind Basic auth and changes underneath the reader. Without this a
// browser will happily serve yesterday's /prospects on refresh — Firefox did exactly that,
// showing rows the server had already skipped.
opdsRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

function recentSince(): string {
  return new Date(Date.now() - config.feed.recentDays * 24 * 60 * 60 * 1000).toISOString();
}

function feedResponse(body: string, type: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': `${type};charset=utf-8`,
      // Catalogues change whenever an article lands; never let a proxy pin an old one.
      'Cache-Control': 'no-cache, must-revalidate',
    },
  });
}

interface AcquisitionOptions {
  scope: ArticleScope;
  id: string;
  title: string;
  selfHref: string;
  upHref: string;
  page: number;
  base: string;
}

function renderAcquisition(options: AcquisitionOptions): Response {
  const pageSize = config.feed.pageSize;
  const total = countArticles(options.scope);
  const articles = listArticles({
    scope: options.scope,
    limit: pageSize,
    offset: (options.page - 1) * pageSize,
  });

  const tagMap = tagsForArticles(articles.map((article) => article.id));

  const xml = acquisitionFeed({
    base: options.base,
    id: options.id,
    title: options.title,
    selfHref: options.selfHref,
    upHref: options.upHref,
    articles,
    tagsFor: (article: ArticleRow) => tagMap.get(article.id) ?? [],
    page: options.page,
    pageSize,
    total,
  });

  return feedResponse(xml, ACQUISITION_TYPE);
}

const rootFeed = (c: Context) => {
  const base = resolveBase(c);
  const since = recentSince();

  const entries: NavigationEntry[] = [
    {
      id: `${base}/opds/new`,
      title: 'Latest',
      summary: `Articles added in the last ${config.feed.recentDays} days (${countArticles({
        kind: 'recent',
        sinceIso: since,
      })})`,
      href: `${base}/opds/new`,
      type: ACQUISITION_TYPE,
    },
    {
      id: `${base}/opds/unread`,
      title: 'Not yet downloaded',
      summary: `Articles this catalogue has never served (${countArticles({ kind: 'unread' })})`,
      href: `${base}/opds/unread`,
      type: ACQUISITION_TYPE,
    },
    {
      id: `${base}/opds/all`,
      title: 'All articles',
      summary: `Everything, newest first (${countArticles({ kind: 'all' })})`,
      href: `${base}/opds/all`,
      type: ACQUISITION_TYPE,
    },
    {
      id: `${base}/opds/sites`,
      title: 'By site',
      summary: 'Browse by publication',
      href: `${base}/opds/sites`,
      type: NAVIGATION_TYPE,
    },
  ];

  if (listTags().length > 0) {
    entries.push({
      id: `${base}/opds/tags`,
      title: 'By tag',
      summary: 'Browse by tag',
      href: `${base}/opds/tags`,
      type: NAVIGATION_TYPE,
    });
  }

  const xml = navigationFeed({
    base,
    id: `${base}/opds`,
    title: config.catalogTitle,
    selfHref: `${base}/opds`,
    entries,
  });

  return feedResponse(xml, NAVIGATION_TYPE);
};

// Small readers fail the whole catalogue on any non-200, and this route is the one a
// person types by hand. So the root answers however it is written: with a trailing
// slash, and at /opds/opds — which CrossPoint firmware before 0.16 requested by
// appending /opds to whatever URL was entered.
opdsRoutes.get('/', rootFeed);
opdsRoutes.get('/opds', rootFeed);

opdsRoutes.get('/search.xml', (c) =>
  new Response(openSearchDescription(resolveBase(c)), {
    status: 200,
    headers: { 'Content-Type': `${OPENSEARCH_TYPE};charset=utf-8` },
  }),
);

opdsRoutes.get('/new', (c) => {
  const base = resolveBase(c);
  return renderAcquisition({
    scope: { kind: 'recent', sinceIso: recentSince() },
    id: `${base}/opds/new`,
    title: `${config.catalogTitle}: Latest`,
    selfHref: `${base}/opds/new`,
    upHref: `${base}/opds`,
    page: parsePage(c.req.query('page')),
    base,
  });
});

opdsRoutes.get('/all', (c) => {
  const base = resolveBase(c);
  return renderAcquisition({
    scope: { kind: 'all' },
    id: `${base}/opds/all`,
    title: `${config.catalogTitle}: All articles`,
    selfHref: `${base}/opds/all`,
    upHref: `${base}/opds`,
    page: parsePage(c.req.query('page')),
    base,
  });
});

opdsRoutes.get('/unread', (c) => {
  const base = resolveBase(c);
  return renderAcquisition({
    scope: { kind: 'unread' },
    id: `${base}/opds/unread`,
    title: `${config.catalogTitle}: Not yet downloaded`,
    selfHref: `${base}/opds/unread`,
    upHref: `${base}/opds`,
    page: parsePage(c.req.query('page')),
    base,
  });
});

opdsRoutes.get('/sites', (c) => {
  const base = resolveBase(c);
  const entries: NavigationEntry[] = listSites().map((site) => ({
    id: `${base}/opds/sites/${encodeURIComponent(site.site)}`,
    title: site.site,
    summary: `${site.count} article${site.count === 1 ? '' : 's'}`,
    href: `${base}/opds/sites/${encodeURIComponent(site.site)}`,
    type: ACQUISITION_TYPE,
  }));

  const xml = navigationFeed({
    base,
    id: `${base}/opds/sites`,
    title: `${config.catalogTitle}: By site`,
    selfHref: `${base}/opds/sites`,
    upHref: `${base}/opds`,
    entries,
  });

  return feedResponse(xml, NAVIGATION_TYPE);
});

opdsRoutes.get('/sites/:site', (c) => {
  const base = resolveBase(c);
  const site = c.req.param('site');
  return renderAcquisition({
    scope: { kind: 'site', site },
    id: `${base}/opds/sites/${encodeURIComponent(site)}`,
    title: `${config.catalogTitle}: ${site}`,
    selfHref: `${base}/opds/sites/${encodeURIComponent(site)}`,
    upHref: `${base}/opds/sites`,
    page: parsePage(c.req.query('page')),
    base,
  });
});

opdsRoutes.get('/tags', (c) => {
  const base = resolveBase(c);
  const entries: NavigationEntry[] = listTags().map((tag) => ({
    id: `${base}/opds/tags/${encodeURIComponent(tag.tag)}`,
    title: tag.tag,
    summary: `${tag.count} article${tag.count === 1 ? '' : 's'}`,
    href: `${base}/opds/tags/${encodeURIComponent(tag.tag)}`,
    type: ACQUISITION_TYPE,
  }));

  const xml = navigationFeed({
    base,
    id: `${base}/opds/tags`,
    title: `${config.catalogTitle}: By tag`,
    selfHref: `${base}/opds/tags`,
    upHref: `${base}/opds`,
    entries,
  });

  return feedResponse(xml, NAVIGATION_TYPE);
});

opdsRoutes.get('/tags/:tag', (c) => {
  const base = resolveBase(c);
  const tag = c.req.param('tag');
  return renderAcquisition({
    scope: { kind: 'tag', tag },
    id: `${base}/opds/tags/${encodeURIComponent(tag)}`,
    title: `${config.catalogTitle}: ${tag}`,
    selfHref: `${base}/opds/tags/${encodeURIComponent(tag)}`,
    upHref: `${base}/opds/tags`,
    page: parsePage(c.req.query('page')),
    base,
  });
});

opdsRoutes.get('/search', (c) => {
  const base = resolveBase(c);
  // Readers send either ?q= (our OpenSearch template) or ?query= / ?search= in the wild.
  const raw = c.req.query('q') ?? c.req.query('query') ?? c.req.query('search') ?? '';
  const query = collapseWhitespace(raw).slice(0, 200);
  const selfHref = `${base}/opds/search?q=${encodeURIComponent(query)}`;

  return renderAcquisition({
    scope: query.length > 0 ? { kind: 'search', query } : { kind: 'all' },
    id: selfHref,
    title: query.length > 0 ? `Search: ${query}` : `${config.catalogTitle}: All articles`,
    selfHref,
    upHref: `${base}/opds`,
    page: parsePage(c.req.query('page')),
    base,
  });
});
