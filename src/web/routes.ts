import { Hono, type Context, type Next } from 'hono';
import { config } from '../config.js';
import { pollAllFeeds, fetchFeed } from '../ingest/rss.js';
import { tick } from '../ingest/queue.js';
import { submitUrl } from '../ingest/submit.js';
import { errorFields, log } from '../logger.js';
import {
  addFeed,
  countArticles,
  deleteArticle,
  deleteFeed,
  getArticle,
  listArticles,
  listFeeds,
  resetAttempts,
  setFeedEnabled,
  statusCounts,
  type ArticleScope,
} from '../store.js';
import { removeArticleFiles } from '../storage.js';
import { parsePage, resolveBase } from '../util/base.js';
import { collapseWhitespace } from '../util/text.js';
import { parseHttpUrl } from '../util/url.js';
import { articlesPage, feedsPage, helpPage } from './views.js';

export const webRoutes = new Hono();

const PAGE_SIZE = 30;

/**
 * Browsers replay cached Basic credentials on cross-site form posts, so every
 * state-changing form checks that the request came from this origin.
 */
const sameOrigin = async (c: Context, next: Next) => {
  if (c.req.method !== 'POST') {
    await next();
    return undefined;
  }

  const origin = c.req.header('origin');
  const referer = c.req.header('referer');
  const expected = resolveBase(c);

  const source = origin ?? referer;
  if (!source) {
    // Form posts from a browser always carry one of the two.
    return c.text('Missing Origin/Referer\n', 403);
  }

  try {
    const sourceOrigin = new URL(source).origin;
    if (sourceOrigin !== new URL(expected).origin) {
      return c.text('Cross-origin form post refused\n', 403);
    }
  } catch {
    return c.text('Bad Origin/Referer\n', 403);
  }

  await next();
  return undefined;
};

webRoutes.use('*', sameOrigin);

function redirect(c: Context, path: string, message: { ok?: string; err?: string }): Response {
  const params = new URLSearchParams();
  if (message.ok) params.set('ok', message.ok);
  if (message.err) params.set('err', message.err);
  const query = params.toString();
  return c.redirect(query.length > 0 ? `${path}?${query}` : path, 303);
}

webRoutes.get('/', (c) => {
  const page = parsePage(c.req.query('page'));
  const query = collapseWhitespace(c.req.query('q') ?? '').slice(0, 200);
  const scope: ArticleScope = query.length > 0 ? { kind: 'search', query } : { kind: 'all' };

  const articles = listArticles({
    scope,
    includeUnready: true,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const total = countArticles(scope, true);

  return c.html(
    articlesPage({
      base: resolveBase(c),
      articles,
      counts: statusCounts(),
      page,
      hasNext: page * PAGE_SIZE < total,
      query,
      ok: c.req.query('ok'),
      err: c.req.query('err'),
    }),
  );
});

webRoutes.post('/add', async (c) => {
  const body = await c.req.parseBody();
  const url = typeof body.url === 'string' ? body.url : '';
  const tags =
    typeof body.tags === 'string'
      ? body.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
      : [];

  if (url.trim().length === 0) {
    return redirect(c, '/', { err: 'Enter a URL first.' });
  }

  try {
    parseHttpUrl(url);
    const result = submitUrl(url, { tags, force: true });
    return redirect(c, '/', {
      ok: result.created ? 'Queued. It will appear in the catalogue shortly.' : 'Already saved — reconverting.',
    });
  } catch (error) {
    log.warn('web submit failed', { url, ...errorFields(error) });
    return redirect(c, '/', { err: error instanceof Error ? error.message : 'Could not queue that URL.' });
  }
});

webRoutes.post('/articles/:id/retry', (c) => {
  const article = getArticle(c.req.param('id'));
  if (!article) return redirect(c, '/', { err: 'That article no longer exists.' });
  resetAttempts(article.id);
  tick();
  return redirect(c, '/', { ok: 'Reconverting.' });
});

webRoutes.post('/articles/:id/delete', async (c) => {
  const article = deleteArticle(c.req.param('id'));
  if (!article) return redirect(c, '/', { err: 'That article no longer exists.' });
  await removeArticleFiles(article);
  return redirect(c, '/', { ok: 'Deleted.' });
});

webRoutes.get('/feeds', (c) =>
  c.html(feedsPage({ base: resolveBase(c), feeds: listFeeds(), ok: c.req.query('ok'), err: c.req.query('err') })),
);

webRoutes.post('/feeds/add', async (c) => {
  const body = await c.req.parseBody();
  const url = typeof body.url === 'string' ? body.url : '';
  const tag = typeof body.tag === 'string' && body.tag.trim().length > 0 ? body.tag.trim() : null;

  try {
    const parsed = parseHttpUrl(url).toString();
    let title: string | null = null;
    try {
      title = (await fetchFeed(parsed)).title;
    } catch (error) {
      log.warn('could not read feed at add time', { url: parsed, ...errorFields(error) });
    }
    addFeed(parsed, title, tag);
    void pollAllFeeds();
    return redirect(c, '/feeds', { ok: title ? `Subscribed to ${title}.` : 'Subscribed.' });
  } catch (error) {
    return redirect(c, '/feeds', {
      err: error instanceof Error ? error.message : 'Could not subscribe to that feed.',
    });
  }
});

webRoutes.post('/feeds/:id/delete', (c) => {
  deleteFeed(c.req.param('id'));
  return redirect(c, '/feeds', { ok: 'Unsubscribed.' });
});

webRoutes.post('/feeds/:id/toggle', (c) => {
  const feed = listFeeds().find((candidate) => candidate.id === c.req.param('id'));
  if (!feed) return redirect(c, '/feeds', { err: 'No such feed.' });
  setFeedEnabled(feed.id, feed.enabled !== 1);
  return redirect(c, '/feeds', { ok: feed.enabled === 1 ? 'Paused.' : 'Resumed.' });
});

webRoutes.post('/feeds/poll', async (c) => {
  await pollAllFeeds();
  return redirect(c, '/feeds', { ok: 'Polled.' });
});

webRoutes.get('/help', (c) =>
  c.html(helpPage(resolveBase(c), config.auth.apiTokens[0] ?? null)),
);
