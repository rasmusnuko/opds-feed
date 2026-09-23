import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { basicUser } from '../auth.js';
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
  countUsers,
  deleteUser,
  findUser,
  getFeed,
  listArticles,
  listFeeds,
  listUsers,
  putUser,
  getTagVocabulary,
  setTagVocabulary,
  resetAttempts,
  setFeedEnabled,
  statusCounts,
  tagsForArticles,
  type ArticleScope,
} from '../store.js';
import { removeArticleFiles } from '../storage.js';
import { parsePage, resolveBase } from '../util/base.js';
import { hashPassword } from '../util/password.js';
import { collapseWhitespace } from '../util/text.js';
import { parseHttpUrl } from '../util/url.js';
import { articlesPage, feedsPage, helpPage, prospectsPage, tagsPage, usersPage } from './views.js';
import type { ProspectStatus } from '../db.js';
import { summariesAvailable } from '../ingest/summarize.js';
import { summarizeProspect } from '../ingest/summarize.js';
import {
  countProspects,
  getProspect,
  isUndoable,
  listProspects,
  pendingByFeed,
  prospectCounts,
  setStatus as setProspectStatus,
  skipMany,
} from '../prospects.js';

export const webRoutes = new Hono();

const PAGE_SIZE = 30;

// Browsers replay cached Basic credentials on cross-site form posts. The origin to
// compare against is the public one, not the URL nginx handed us over plain HTTP.
webRoutes.use('*', csrf({ origin: (origin, c) => origin === new URL(resolveBase(c)).origin }));

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
      tags: tagsForArticles(articles.map((a) => a.id)),
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

// ---------------------------------------------------------------- users

/** Keeps usernames to what fits in a URL path and an e-reader's keyboard. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MIN_PASSWORD = 8;

webRoutes.get('/users', (c) =>
  c.html(
    usersPage({
      base: resolveBase(c),
      users: listUsers(),
      current: basicUser(c),
      ok: c.req.query('ok'),
      err: c.req.query('err'),
    }),
  ),
);

webRoutes.post('/users/add', async (c) => {
  const body = await c.req.parseBody();
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    return redirect(c, '/users', { err: 'Usernames can use letters, digits, dot, dash and underscore, up to 32.' });
  }
  if (password.length < MIN_PASSWORD) {
    return redirect(c, '/users', { err: `Passwords must be at least ${MIN_PASSWORD} characters.` });
  }
  if (findUser(username)) {
    return redirect(c, '/users', { err: `${username} already exists — change its password instead.` });
  }

  putUser(username, await hashPassword(password));
  log.info('user added', { username, by: basicUser(c) });
  return redirect(c, '/users', { ok: `Added ${username}.` });
});

webRoutes.post('/users/:username/password', async (c) => {
  const username = c.req.param('username');
  const body = await c.req.parseBody();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!findUser(username)) return redirect(c, '/users', { err: 'No such account.' });
  if (password.length < MIN_PASSWORD) {
    return redirect(c, '/users', { err: `Passwords must be at least ${MIN_PASSWORD} characters.` });
  }

  putUser(username, await hashPassword(password));
  log.info('password changed', { username, by: basicUser(c) });
  return redirect(c, '/users', {
    ok: `Password changed for ${username}. Readers holding the old one will ask again.`,
  });
});

webRoutes.post('/users/:username/delete', (c) => {
  const username = c.req.param('username');

  // Both of these are lockouts, and a catalogue you cannot sign into needs a shell on
  // the box and a sqlite3 to repair. Refused here as well as hidden in the page,
  // because the page is not the only thing that can post to this route.
  if (countUsers() <= 1) {
    return redirect(c, '/users', { err: 'That is the only account — add another before removing this one.' });
  }
  if (username === basicUser(c)) {
    return redirect(c, '/users', { err: 'That is the account you are signed in as.' });
  }
  if (!deleteUser(username)) return redirect(c, '/users', { err: 'No such account.' });

  log.info('user removed', { username, by: basicUser(c) });
  return redirect(c, '/users', { ok: `Removed ${username}.` });
});

// ---------------------------------------------------------------- tags

function tagsView(c: Context, ok?: string, err?: string): Response {
  return c.html(
    tagsPage({
      base: resolveBase(c),
      tags: getTagVocabulary(),
      enabled: config.openrouter.apiKey !== undefined,
      model: config.openrouter.model,
      ok,
      err,
    }),
  );
}

webRoutes.get('/tags', (c) => tagsView(c, c.req.query('ok'), c.req.query('err')));

webRoutes.post('/tags', async (c) => {
  const body = await c.req.parseBody();
  const raw = typeof body.tags === 'string' ? body.tags : '';
  const saved = setTagVocabulary(raw.split(/[\n,]/));
  return redirect(c, '/tags', { ok: saved.length > 0 ? `Saved ${saved.length} tags.` : 'Tag list cleared — tagging is paused.' });
});

/* ------------------------------------------------------------------ prospects */

const PROSPECT_STATUSES: ProspectStatus[] = ['pending', 'saved', 'skipped', 'expired'];

function parseStatus(value: string | undefined): ProspectStatus {
  return PROSPECT_STATUSES.includes(value as ProspectStatus) ? (value as ProspectStatus) : 'pending';
}

/** The triage script sends Accept: application/json; a plain form post gets a redirect. */
function wantsJson(c: Context): boolean {
  return (c.req.header('accept') ?? '').includes('application/json');
}

function prospectRedirect(c: Context, message: { ok?: string; err?: string }): Response {
  const status = c.req.query('status') ?? 'pending';
  const params = new URLSearchParams({ status });
  if (message.ok) params.set('ok', message.ok);
  if (message.err) params.set('err', message.err);
  return c.redirect(`/prospects?${params.toString()}`, 303);
}

webRoutes.get('/prospects', (c) => {
  const status = parseStatus(c.req.query('status'));
  const feedId = c.req.query('feed') || null;
  const page = parsePage(c.req.query('page'));
  const pageSize = config.prospects.pageSize;

  const prospects = listProspects({
    status,
    feedId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return c.html(
    prospectsPage({
      base: resolveBase(c),
      prospects,
      status,
      counts: prospectCounts(),
      feeds: pendingByFeed(),
      activeFeedId: feedId,
      page,
      hasNext: page * pageSize < countProspects(status, feedId),
      summariesEnabled: summariesAvailable(),
      undoable: isUndoable,
      ok: c.req.query('ok'),
      err: c.req.query('err'),
    }),
  );
});

/** Accepting a prospect is the only path that spends disk: it hands the URL to the queue. */
webRoutes.post('/prospects/:id/save', (c) => {
  const prospect = getProspect(c.req.param('id'));
  if (!prospect) {
    return wantsJson(c) ? c.json({ error: 'Not found' }, 404) : prospectRedirect(c, { err: 'Gone.' });
  }

  try {
    const feed = getFeed(prospect.feed_id);
    const result = submitUrl(prospect.url, {
      tags: feed?.tag ? [feed.tag] : [],
      feedId: prospect.feed_id,
      title: prospect.title,
    });
    setProspectStatus(prospect.id, 'saved', result.article.id);

    return wantsJson(c)
      ? c.json({ id: prospect.id, status: 'saved', articleId: result.article.id })
      : prospectRedirect(c, { ok: 'Saved — converting now.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not queue that URL.';
    log.warn('prospect save failed', { id: prospect.id, url: prospect.url, ...errorFields(error) });
    return wantsJson(c) ? c.json({ error: message }, 400) : prospectRedirect(c, { err: message });
  }
});

webRoutes.post('/prospects/:id/skip', (c) => {
  const prospect = getProspect(c.req.param('id'));
  if (!prospect) {
    return wantsJson(c) ? c.json({ error: 'Not found' }, 404) : prospectRedirect(c, { err: 'Gone.' });
  }
  setProspectStatus(prospect.id, 'skipped');
  return wantsJson(c)
    ? c.json({ id: prospect.id, status: 'skipped' })
    : prospectRedirect(c, { ok: 'Skipped.' });
});

webRoutes.post('/prospects/:id/undo', (c) => {
  const prospect = getProspect(c.req.param('id'));
  if (!prospect) {
    return wantsJson(c) ? c.json({ error: 'Not found' }, 404) : prospectRedirect(c, { err: 'Gone.' });
  }
  setProspectStatus(prospect.id, 'pending');
  return wantsJson(c)
    ? c.json({ id: prospect.id, status: 'pending' })
    : prospectRedirect(c, { ok: 'Back in the queue.' });
});

/**
 * Fetches the article, summarises it and keeps only the summary. Synchronous on purpose:
 * the user pressed the button and is waiting, and a few seconds is the expected cost.
 */
webRoutes.post('/prospects/:id/summary', async (c) => {
  const prospect = getProspect(c.req.param('id'));
  if (!prospect) {
    return wantsJson(c) ? c.json({ error: 'Not found' }, 404) : prospectRedirect(c, { err: 'Gone.' });
  }

  if (prospect.summary) {
    return wantsJson(c)
      ? c.json({ id: prospect.id, summary: prospect.summary, model: prospect.summary_model, cached: true })
      : prospectRedirect(c, { ok: 'Already summarised.' });
  }

  try {
    const result = await summarizeProspect(prospect);
    return wantsJson(c)
      ? c.json({ id: prospect.id, summary: result.summary, model: result.model, source: result.source })
      : prospectRedirect(c, { ok: 'Summarised.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not summarise that article.';
    return wantsJson(c) ? c.json({ error: message }, 502) : prospectRedirect(c, { err: message });
  }
});

webRoutes.post('/prospects/bulk', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const action = typeof body.action === 'string' ? body.action : '';
  const feedId = typeof body.feed === 'string' && body.feed.length > 0 ? body.feed : null;

  const raw = body.ids;
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : typeof raw === 'string' ? [raw] : [];

  if (action === 'skip-older') {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const count = skipMany({ feedId, olderThanIso: cutoff });
    return prospectRedirect(c, { ok: `Skipped ${count} older than 7 days.` });
  }

  if (action === 'skip-feed') {
    if (!feedId) return prospectRedirect(c, { err: 'Pick a feed first.' });
    const count = skipMany({ feedId });
    return prospectRedirect(c, { ok: `Skipped ${count} from that feed.` });
  }

  if (ids.length === 0) return prospectRedirect(c, { err: 'Nothing selected.' });

  if (action === 'skip') {
    for (const id of ids) setProspectStatus(id, 'skipped');
    return prospectRedirect(c, { ok: `Skipped ${ids.length}.` });
  }

  if (action === 'save') {
    let saved = 0;
    for (const id of ids) {
      const prospect = getProspect(id);
      if (!prospect) continue;
      try {
        const feed = getFeed(prospect.feed_id);
        const result = submitUrl(prospect.url, {
          tags: feed?.tag ? [feed.tag] : [],
          feedId: prospect.feed_id,
          title: prospect.title,
        });
        setProspectStatus(id, 'saved', result.article.id);
        saved += 1;
      } catch (error) {
        log.warn('bulk save skipped an item', { id, ...errorFields(error) });
      }
    }
    return prospectRedirect(c, { ok: `Saved ${saved} — converting now.` });
  }

  return prospectRedirect(c, { err: 'Unknown action.' });
});
