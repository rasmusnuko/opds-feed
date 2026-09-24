import { config } from './config.js';
import { db, nowIso, type ProspectRow, type ProspectStatus } from './db.js';
import { findByUrlKey } from './store.js';
import { newId } from './util/ids.js';
import { urlKey } from './util/url.js';

/**
 * The prospect queue.
 *
 * Feed items land here as candidates: title, teaser and link only. Nothing is fetched,
 * converted or stored until the user says so, which is the whole point -- a year of
 * unread feed items costs less disk than two converted articles.
 */

export interface ProspectInput {
  feedId: string;
  guid: string;
  url: string;
  title: string;
  author: string | null;
  teaser: string | null;
  publishedAt: string | null;
}

/**
 * Offers a prospect, unless the same story is already known. Returns false when it was a
 * duplicate, so the poller can report how many are genuinely new.
 *
 * Deduplication is global rather than per feed: subscribing to two views of the same
 * source (two Hacker News feeds, a site's main and section feeds) must not make you
 * triage the same article twice. An article you have already converted suppresses the
 * prospect entirely -- you decided once.
 */
export function addProspect(input: ProspectInput): boolean {
  let key: string;
  try {
    key = urlKey(input.url);
  } catch {
    key = input.url;
  }

  if (findByUrlKey(key)) return false; // already in the library
  if (findProspectByUrlKey(key)) return false; // already offered, by this feed or another

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO prospects
         (id, feed_id, guid, url, url_key, title, author, teaser, published_at, seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      newId(),
      input.feedId,
      input.guid,
      input.url,
      key,
      input.title,
      input.author,
      input.teaser,
      input.publishedAt,
      nowIso(),
    );

  return result.changes > 0;
}

export function findProspectByUrlKey(key: string): ProspectRow | undefined {
  return db.prepare('SELECT * FROM prospects WHERE url_key = ?').get(key) as ProspectRow | undefined;
}

export function getProspect(id: string): ProspectRow | undefined {
  return db.prepare('SELECT * FROM prospects WHERE id = ?').get(id) as ProspectRow | undefined;
}

export interface ListProspectOptions {
  status: ProspectStatus;
  feedId?: string | null;
  limit: number;
  offset: number;
}

export function listProspects(options: ListProspectOptions): ProspectRow[] {
  const conditions = ['p.status = ?'];
  const params: unknown[] = [options.status];

  if (options.feedId) {
    conditions.push('p.feed_id = ?');
    params.push(options.feedId);
  }

  // Newest first by publication date where the feed gave us one, else by when we saw it.
  return db
    .prepare(
      `SELECT p.* FROM prospects p
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(p.published_at, p.seen_at) DESC, p.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset) as ProspectRow[];
}

export function countProspects(status: ProspectStatus, feedId?: string | null): number {
  const row = feedId
    ? (db
        .prepare('SELECT COUNT(*) AS count FROM prospects WHERE status = ? AND feed_id = ?')
        .get(status, feedId) as { count: number })
    : (db.prepare('SELECT COUNT(*) AS count FROM prospects WHERE status = ?').get(status) as {
        count: number;
      });
  return row.count;
}

/** Pending counts per feed, for the filter chips. */
export function pendingByFeed(): { feed_id: string; title: string | null; url: string; count: number }[] {
  return db
    .prepare(
      `SELECT p.feed_id AS feed_id, f.title AS title, f.url AS url, COUNT(*) AS count
       FROM prospects p
       JOIN feeds f ON f.id = p.feed_id
       WHERE p.status = 'pending'
       GROUP BY p.feed_id
       ORDER BY count DESC`,
    )
    .all() as { feed_id: string; title: string | null; url: string; count: number }[];
}

export function setStatus(id: string, status: ProspectStatus, articleId?: string | null): void {
  db.prepare(
    `UPDATE prospects SET status = ?, decided_at = ?, article_id = COALESCE(?, article_id)
     WHERE id = ?`,
  ).run(status, status === 'pending' ? null : nowIso(), articleId ?? null, id);
}

export function storeSummary(id: string, summary: string, model: string): void {
  db.prepare(
    'UPDATE prospects SET summary = ?, summary_model = ?, summary_at = ?, summary_error = NULL WHERE id = ?',
  ).run(summary, model, nowIso(), id);
}

export function storeSummaryError(id: string, error: string): void {
  db.prepare('UPDATE prospects SET summary_error = ?, summary_at = ? WHERE id = ?').run(
    error.slice(0, 500),
    nowIso(),
    id,
  );
}

/** Bulk skip, used by "skip everything from this feed" and "skip older than". */
export function skipMany(options: { feedId?: string | null; olderThanIso?: string | null }): number {
  const conditions = [`status = 'pending'`];
  const params: unknown[] = [];

  if (options.feedId) {
    conditions.push('feed_id = ?');
    params.push(options.feedId);
  }
  if (options.olderThanIso) {
    conditions.push('COALESCE(published_at, seen_at) < ?');
    params.push(options.olderThanIso);
  }

  return db
    .prepare(`UPDATE prospects SET status = 'skipped', decided_at = ? WHERE ${conditions.join(' AND ')}`)
    .run(nowIso(), ...params).changes;
}

/**
 * Ages out undecided prospects. Without this the queue only ever grows, and a list you can
 * never finish is one you stop opening.
 *
 * Keyed on seen_at, never on published_at: expiry measures how long *you* have had the
 * item to decide on. Judging it by publication date would silently bin a feed's whole
 * backlog the moment you subscribed to it.
 */
export function expireOldProspects(): number {
  const cutoff = new Date(Date.now() - config.prospects.expiryDays * 86_400_000).toISOString();
  return db
    .prepare(
      `UPDATE prospects SET status = 'expired', decided_at = ?
       WHERE status = 'pending' AND seen_at < ?`,
    )
    .run(nowIso(), cutoff).changes;
}

/** A decision is reversible for a while; people triage faster when undo exists. */
export function isUndoable(prospect: ProspectRow): boolean {
  if (prospect.status === 'pending' || !prospect.decided_at) return false;
  const decided = new Date(prospect.decided_at).getTime();
  if (Number.isNaN(decided)) return false;
  return Date.now() - decided <= config.prospects.undoWindowHours * 3_600_000;
}

export function prospectCounts(): Record<ProspectStatus, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM prospects GROUP BY status').all() as {
    status: ProspectStatus;
    count: number;
  }[];
  const counts: Record<ProspectStatus, number> = { pending: 0, saved: 0, skipped: 0, expired: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
