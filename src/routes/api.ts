import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from '../config.js';
import { pollAllFeeds, fetchFeed } from '../ingest/rss.js';
import { submitUrl } from '../ingest/submit.js';
import { errorFields, log } from '../logger.js';
import {
  addFeed,
  deleteArticle,
  deleteFeed,
  getArticle,
  getTags,
  listArticles,
  listFeeds,
  resetAttempts,
  setFeedEnabled,
  statusCounts,
  type ArticleScope,
} from '../store.js';
import { removeArticleFiles, removeSnapshot } from '../storage.js';
import { tick } from '../ingest/queue.js';
import { resolveBase } from '../util/base.js';
import { collapseWhitespace, escapeHtml } from '../util/text.js';
import { parseHttpUrl } from '../util/url.js';
import type { ArticleRow } from '../db.js';

export const apiRoutes = new Hono();

interface SubmitBody {
  url?: string;
  tags?: string[];
  title?: string | null;
  html?: string | null;
  selection?: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Form fields may arrive as text or, from `curl -F html=@page.html` and shortcuts, as a file. */
async function formText(value: unknown): Promise<string | null> {
  if (value instanceof File) return optionalString(await value.text());
  return optionalString(value);
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof value === 'string') {
    return value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  }
  return [];
}

async function readSubmitBody(c: Context): Promise<SubmitBody> {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      url: typeof body.url === 'string' ? body.url : undefined,
      tags: parseTags(body.tags),
      title: typeof body.title === 'string' ? body.title : null,
      html: optionalString(body.html),
      selection: optionalString(body.selection),
    };
  }

  if (contentType.includes('form')) {
    const body = await c.req.parseBody();
    return {
      url: typeof body.url === 'string' ? body.url : undefined,
      tags: parseTags(body.tags),
      title: typeof body.title === 'string' ? body.title : null,
      html: await formText(body.html),
      selection: await formText(body.selection),
    };
  }

  // A bare text/plain body is the easiest thing for a phone shortcut to send.
  const text = await c.req.text().catch(() => '');
  const trimmed = collapseWhitespace(text);
  return { url: trimmed.length > 0 ? trimmed : c.req.query('url'), tags: parseTags(c.req.query('tags')) };
}

function articleJson(article: ArticleRow, base: string): Record<string, unknown> {
  return {
    id: article.id,
    status: article.status,
    title: article.title,
    url: article.canonical_url ?? article.url,
    fetchedUrl: article.url,
    site: article.site,
    author: article.author,
    excerpt: article.excerpt,
    tags: getTags(article.id),
    addedAt: article.added_at,
    publishedAt: article.published_at,
    wordCount: article.word_count,
    readingMinutes: article.reading_minutes,
    sizeBytes: article.epub_size,
    error: article.error,
    attempts: article.attempts,
    downloadedAt: article.downloaded_at,
    extractor: article.extractor,
    download: article.status === 'ready' ? `${base}/download/${article.id}.epub` : null,
    cover: article.cover_path ? `${base}/covers/${article.id}.jpg` : null,
  };
}

// Requests may carry a whole page of HTML (step 8), so cap them explicitly.
const submitBodyLimit = bodyLimit({
  maxSize: config.extract.maxSubmittedBytes,
  onError: (c) => c.json({ error: `Request body is over the ${config.extract.maxSubmittedBytes} byte limit` }, 413),
});

apiRoutes.post('/articles', submitBodyLimit, async (c) => {
  const body = await readSubmitBody(c);
  const url = body.url ?? c.req.query('url');

  if (!url) {
    return c.json({ error: 'A "url" field is required' }, 400);
  }

  try {
    parseHttpUrl(url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid URL' }, 400);
  }

  try {
    const result = submitUrl(url, {
      tags: body.tags,
      title: body.title,
      html: body.html,
      selection: body.selection,
    });
    const base = resolveBase(c);
    return c.json(
      {
        ...articleJson(result.article, base),
        created: result.created,
        requeued: result.requeued,
      },
      result.created ? 202 : 200,
    );
  } catch (error) {
    log.warn('submit failed', { url, ...errorFields(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Could not queue URL' }, 400);
  }
});

function confirmationPage(c: Context, url: string, options: Parameters<typeof submitUrl>[1]): Response {
  try {
    const result = submitUrl(url, options);
    const title = escapeHtml(result.article.title);
    const state = result.created ? 'Queued' : result.requeued ? 'Requeued' : 'Already saved';
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"/>` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
        `<title>${state}</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem 1.5rem;text-align:center}` +
        `h1{font-size:1.2rem}p{color:#666;word-break:break-word}</style></head>` +
        `<body><h1>${state}</h1><p>${title}</p></body></html>`,
      result.created ? 202 : 200,
    );
  } catch (error) {
    return c.text(`${error instanceof Error ? error.message : 'Could not queue URL'}\n`, 400);
  }
}

/**
 * GET-based ingest for bookmarklets and share shortcuts that cannot send a POST body.
 * Auth still applies (`?token=` or Basic).
 */
apiRoutes.get('/add', (c) => {
  const url = c.req.query('url');
  if (!url) return c.text('Missing ?url=\n', 400);
  return confirmationPage(c, url, { tags: parseTags(c.req.query('tags')) });
});

/**
 * Form-POST ingest for the bookmarklet that sends the rendered page (and any selection)
 * along with the URL. A plain form submit needs no CORS, and answers with a page the
 * new tab can show.
 */
apiRoutes.post('/add', submitBodyLimit, async (c) => {
  const body = await readSubmitBody(c);
  const url = body.url ?? c.req.query('url');
  if (!url) return c.text('A "url" field is required\n', 400);
  try {
    parseHttpUrl(url);
  } catch (error) {
    return c.text(`${error instanceof Error ? error.message : 'Invalid URL'}\n`, 400);
  }
  return confirmationPage(c, url, {
    tags: body.tags ?? parseTags(c.req.query('tags')),
    title: body.title,
    html: body.html,
    selection: body.selection,
  });
});

apiRoutes.get('/articles', (c) => {
  const base = resolveBase(c);
  const query = c.req.query('q');
  const site = c.req.query('site');
  const tag = c.req.query('tag');

  const scope: ArticleScope = query
    ? { kind: 'search', query }
    : site
      ? { kind: 'site', site }
      : tag
        ? { kind: 'tag', tag }
        : { kind: 'all' };

  const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const includeUnready = c.req.query('all') !== 'false';

  const articles = listArticles({ scope, limit, offset, includeUnready });
  return c.json({ articles: articles.map((article) => articleJson(article, base)) });
});

apiRoutes.get('/articles/:id', (c) => {
  const article = getArticle(c.req.param('id'));
  if (!article) return c.json({ error: 'Not found' }, 404);
  return c.json(articleJson(article, resolveBase(c)));
});

apiRoutes.post('/articles/:id/retry', (c) => {
  const article = getArticle(c.req.param('id'));
  if (!article) return c.json({ error: 'Not found' }, 404);
  resetAttempts(article.id);
  tick();
  return c.json({ ...articleJson(getArticle(article.id)!, resolveBase(c)), requeued: true });
});

apiRoutes.delete('/articles/:id', async (c) => {
  const article = deleteArticle(c.req.param('id'));
  if (!article) return c.json({ error: 'Not found' }, 404);
  await removeArticleFiles(article);
  await removeSnapshot(article.id);
  return c.json({ deleted: article.id });
});

apiRoutes.get('/feeds', (c) => c.json({ feeds: listFeeds() }));

apiRoutes.post('/feeds', async (c) => {
  const body = await readSubmitBody(c);
  const url = body.url ?? c.req.query('url');
  if (!url) return c.json({ error: 'A "url" field is required' }, 400);

  let parsed: string;
  try {
    parsed = parseHttpUrl(url).toString();
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid URL' }, 400);
  }

  let title: string | null = null;
  try {
    title = (await fetchFeed(parsed)).title;
  } catch (error) {
    // A feed that cannot be read right now is still worth storing; the poller will retry.
    log.warn('could not read feed at add time', { url: parsed, ...errorFields(error) });
  }

  const tags = body.tags ?? [];
  const feed = addFeed(parsed, title, tags[0] ?? null);
  void pollAllFeeds();
  return c.json({ feed }, 201);
});

apiRoutes.delete('/feeds/:id', (c) => {
  const deleted = deleteFeed(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ deleted: c.req.param('id') });
});

apiRoutes.post('/feeds/:id/enabled', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  setFeedEnabled(c.req.param('id'), body.enabled !== false);
  return c.json({ ok: true });
});

apiRoutes.post('/feeds/poll', async (c) => {
  await pollAllFeeds();
  return c.json({ ok: true });
});

apiRoutes.get('/status', (c) => {
  const base = resolveBase(c);
  return c.json({
    catalog: `${base}/opds`,
    counts: statusCounts(),
    feeds: listFeeds().length,
    pollIntervalMinutes: config.rss.enabled ? config.rss.pollIntervalMinutes : null,
  });
});
