import { config } from './config.js';
import { db, nowIso, type ArticleRow, type ArticleStatus, type FeedRow, type UserRow } from './db.js';
import { log } from './logger.js';
import { newId } from './util/ids.js';
import { hashPassword } from './util/password.js';

export type ArticleScope =
  | { kind: 'all' }
  | { kind: 'recent'; sinceIso: string }
  | { kind: 'unread' }
  | { kind: 'site'; site: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'search'; query: string };

export interface ListOptions {
  scope: ArticleScope;
  /** Ready articles only by default; the web UI also wants pending/failed rows. */
  includeUnready?: boolean;
  limit: number;
  offset: number;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function buildWhere(scope: ArticleScope, includeUnready: boolean): WhereClause {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!includeUnready) {
    conditions.push(`a.status = 'ready'`);
  }

  switch (scope.kind) {
    case 'all':
      break;
    case 'recent':
      conditions.push('a.added_at >= ?');
      params.push(scope.sinceIso);
      break;
    case 'unread':
      conditions.push('a.downloaded_at IS NULL');
      break;
    case 'site':
      conditions.push('a.site = ?');
      params.push(scope.site);
      break;
    case 'tag':
      conditions.push('EXISTS (SELECT 1 FROM article_tags t WHERE t.article_id = a.id AND t.tag = ?)');
      params.push(scope.tag);
      break;
    case 'search': {
      const needle = `%${escapeLike(scope.query)}%`;
      conditions.push(
        `(a.title LIKE ? ESCAPE '\\' OR a.excerpt LIKE ? ESCAPE '\\' OR a.site LIKE ? ESCAPE '\\' OR a.author LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle, needle);
      break;
    }
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function listArticles(options: ListOptions): ArticleRow[] {
  const where = buildWhere(options.scope, options.includeUnready ?? false);
  const statement = db.prepare(
    `SELECT a.* FROM articles a ${where.sql} ORDER BY a.added_at DESC, a.id DESC LIMIT ? OFFSET ?`,
  );
  return statement.all(...where.params, options.limit, options.offset) as ArticleRow[];
}

export function countArticles(scope: ArticleScope, includeUnready = false): number {
  const where = buildWhere(scope, includeUnready);
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM articles a ${where.sql}`)
    .get(...where.params) as { count: number };
  return row.count;
}

export function getArticle(id: string): ArticleRow | undefined {
  return db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as ArticleRow | undefined;
}

export function findByUrlKey(key: string): ArticleRow | undefined {
  return db.prepare('SELECT * FROM articles WHERE url_key = ?').get(key) as ArticleRow | undefined;
}

export interface CreateArticleInput {
  url: string;
  requestedUrl: string;
  urlKey: string;
  title: string;
  site: string | null;
  tags: string[];
  feedId?: string | null;
}

export interface CreateArticleResult {
  article: ArticleRow;
  created: boolean;
}

export const createArticle = db.transaction((input: CreateArticleInput): CreateArticleResult => {
  const existing = findByUrlKey(input.urlKey);
  if (existing) {
    addTags(existing.id, input.tags);
    return { article: getArticle(existing.id)!, created: false };
  }

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO articles (id, url, requested_url, url_key, title, site, added_at, updated_at, status, feed_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, input.url, input.requestedUrl, input.urlKey, input.title, input.site, now, now, input.feedId ?? null);
  addTags(id, input.tags);
  return { article: getArticle(id)!, created: true };
});

export function addTags(articleId: string, tags: string[]): void {
  if (tags.length === 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag) VALUES (?, ?)');
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase();
    if (clean.length > 0) insert.run(articleId, clean);
  }
}

export function getTags(articleId: string): string[] {
  const rows = db
    .prepare('SELECT tag FROM article_tags WHERE article_id = ? ORDER BY tag')
    .all(articleId) as { tag: string }[];
  return rows.map((row) => row.tag);
}

export function listTags(): { tag: string; count: number }[] {
  return db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count
       FROM article_tags t
       JOIN articles a ON a.id = t.article_id
       WHERE a.status = 'ready'
       GROUP BY t.tag
       ORDER BY t.tag`,
    )
    .all() as { tag: string; count: number }[];
}

export function listSites(): { site: string; count: number }[] {
  return db
    .prepare(
      `SELECT site, COUNT(*) AS count
       FROM articles
       WHERE status = 'ready' AND site IS NOT NULL
       GROUP BY site
       ORDER BY site`,
    )
    .all() as { site: string; count: number }[];
}

export function setStatus(id: string, status: ArticleStatus): void {
  db.prepare('UPDATE articles SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
}

export interface ReadyUpdate {
  url: string;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  site: string | null;
  excerpt: string | null;
  language: string | null;
  publishedAt: string | null;
  wordCount: number;
  readingMinutes: number;
  epubPath: string;
  epubSize: number;
  coverPath: string | null;
  thumbPath: string | null;
}

export function markReady(id: string, update: ReadyUpdate): void {
  db.prepare(
    `UPDATE articles
     SET status = 'ready', url = ?, canonical_url = ?, title = ?, author = ?, site = ?, excerpt = ?, language = ?,
         published_at = ?, word_count = ?, reading_minutes = ?, epub_path = ?, epub_size = ?,
         cover_path = ?, thumb_path = ?, error = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    update.url,
    update.canonicalUrl,
    update.title,
    update.author,
    update.site,
    update.excerpt,
    update.language,
    update.publishedAt,
    update.wordCount,
    update.readingMinutes,
    update.epubPath,
    update.epubSize,
    update.coverPath,
    update.thumbPath,
    nowIso(),
    id,
  );
}

export function markFailed(id: string, error: string, nextAttemptAt: string | null): void {
  db.prepare(
    `UPDATE articles SET status = 'failed', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
  ).run(error.slice(0, 2000), nextAttemptAt, nowIso(), id);
}

export function incrementAttempts(id: string): number {
  db.prepare('UPDATE articles SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  const row = db.prepare('SELECT attempts FROM articles WHERE id = ?').get(id) as
    | { attempts: number }
    | undefined;
  return row?.attempts ?? 0;
}

export function resetAttempts(id: string): void {
  db.prepare(
    `UPDATE articles SET attempts = 0, status = 'pending', error = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(nowIso(), id);
}

/** Anything left mid-flight by a crash or restart is safe to retry from the top. */
export function requeueInterrupted(): number {
  const result = db
    .prepare(`UPDATE articles SET status = 'pending', updated_at = ? WHERE status = 'processing'`)
    .run(nowIso());
  return result.changes;
}

export function claimNextPending(maxAttempts: number): ArticleRow | undefined {
  const claim = db.transaction((): ArticleRow | undefined => {
    const row = db
      .prepare(
        `SELECT * FROM articles
         WHERE status IN ('pending', 'failed')
           AND attempts < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY added_at ASC
         LIMIT 1`,
      )
      .get(maxAttempts, nowIso()) as ArticleRow | undefined;
    if (!row) return undefined;
    setStatus(row.id, 'processing');
    return row;
  });
  return claim();
}

export function recordDownload(id: string): void {
  db.prepare(
    `UPDATE articles
     SET download_count = download_count + 1,
         downloaded_at = COALESCE(downloaded_at, ?)
     WHERE id = ?`,
  ).run(nowIso(), id);
}

export function deleteArticle(id: string): ArticleRow | undefined {
  const article = getArticle(id);
  if (!article) return undefined;
  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  return article;
}

export function statusCounts(): Record<ArticleStatus, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM articles GROUP BY status')
    .all() as { status: ArticleStatus; count: number }[];
  const counts: Record<ArticleStatus, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/* ------------------------------------------------------------------ feeds */

export function listFeeds(): FeedRow[] {
  return db.prepare('SELECT * FROM feeds ORDER BY added_at').all() as FeedRow[];
}

export function getFeed(id: string): FeedRow | undefined {
  return db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as FeedRow | undefined;
}

export function addFeed(url: string, title: string | null, tag: string | null): FeedRow {
  const existing = db.prepare('SELECT * FROM feeds WHERE url = ?').get(url) as FeedRow | undefined;
  if (existing) return existing;
  const id = newId(8);
  db.prepare(
    'INSERT INTO feeds (id, url, title, tag, enabled, added_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(id, url, title, tag, nowIso());
  return getFeed(id)!;
}

export function deleteFeed(id: string): boolean {
  return db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes > 0;
}

export function setFeedEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE feeds SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function recordFeedPoll(id: string, error: string | null): void {
  db.prepare('UPDATE feeds SET last_polled_at = ?, last_error = ? WHERE id = ?').run(
    nowIso(),
    error ? error.slice(0, 500) : null,
    id,
  );
}

export function isFeedItemSeen(feedId: string, guid: string): boolean {
  const row = db
    .prepare('SELECT 1 AS seen FROM feed_items WHERE feed_id = ? AND guid = ?')
    .get(feedId, guid);
  return row !== undefined;
}

export function markFeedItemSeen(feedId: string, guid: string): void {
  db.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, seen_at) VALUES (?, ?, ?)').run(
    feedId,
    guid,
    nowIso(),
  );
}

/** One query for a whole page of entries, instead of one per article. */
export function tagsForArticles(ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT article_id, tag FROM article_tags WHERE article_id IN (${placeholders}) ORDER BY tag`,
    )
    .all(...ids) as { article_id: string; tag: string }[];

  for (const row of rows) {
    const existing = result.get(row.article_id);
    if (existing) existing.push(row.tag);
    else result.set(row.article_id, [row.tag]);
  }
  return result;
}

// ---------------------------------------------------------------- users

/**
 * Credentials live here rather than in the environment so they can be changed
 * without editing .env and restarting the container. The environment is still
 * where the *first* user comes from — see seedUsersFromEnv — because a fresh
 * deployment has no other way to let anybody in.
 */
export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
}

export function findUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

/** Insert or replace one user. The caller hashes; plaintext never reaches the table. */
export function putUser(username: string, passwordHash: string): void {
  db.prepare(
    `INSERT INTO users (username, password_hash, added_at) VALUES (?, ?, ?)
     ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash`,
  ).run(username, passwordHash, nowIso());
}

export function deleteUser(username: string): boolean {
  return db.prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0;
}

/**
 * Put the environment's password in the table the first time the table is empty.
 *
 * Only when empty: once an account has been added or a password changed on the Users
 * page, the environment is stale by definition, and re-applying it on every restart
 * would silently undo that — and resurrect a removed account on the next deploy. So
 * OPDS_USERNAME/OPDS_PASSWORD are a seed, not a source of truth, and the .env comments
 * say so. Plaintext rather than a hash because every real hash format begins with `$`,
 * which Docker Compose interpolates inside an env_file.
 */
export async function seedUsersFromEnv(): Promise<void> {
  if (countUsers() > 0) return;
  const { username, password } = config.auth;
  if (!password) return;
  putUser(username, await hashPassword(password));
  log.info('seeded the first user from the environment', { username });
}

// ---------------------------------------------------------------- tag vocabulary

/** The site's own tag list: what the tagger may choose from. Empty means "do not tag". */
export function getTagVocabulary(): string[] {
  return (db.prepare('SELECT tag FROM tag_vocabulary ORDER BY tag').all() as { tag: string }[]).map((r) => r.tag);
}

export function setTagVocabulary(tags: string[]): string[] {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 40))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tag_vocabulary').run();
    const insert = db.prepare('INSERT INTO tag_vocabulary (tag) VALUES (?)');
    for (const tag of clean) insert.run(tag);
  });
  tx();
  return clean;
}
