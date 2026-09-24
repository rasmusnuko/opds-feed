import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { urlKey } from './util/url.js';

export type ArticleStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type ProspectStatus = 'pending' | 'saved' | 'skipped' | 'expired';

export interface ArticleRow {
  id: string;
  /** The URL we fetch: the submitted URL after redirects. Always re-fetchable. */
  url: string;
  /** The page's own canonical link, used for display and attribution. */
  canonical_url: string | null;
  requested_url: string;
  url_key: string;
  title: string;
  author: string | null;
  site: string | null;
  excerpt: string | null;
  language: string | null;
  published_at: string | null;
  added_at: string;
  updated_at: string;
  word_count: number;
  reading_minutes: number;
  status: ArticleStatus;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  epub_path: string | null;
  epub_size: number | null;
  cover_path: string | null;
  thumb_path: string | null;
  downloaded_at: string | null;
  download_count: number;
  feed_id: string | null;
}

/**
 * A feed item that has been noticed but deliberately not fetched or converted. Holds only
 * what the feed itself gave us -- a few hundred bytes against ~200 KB for an EPUB.
 */
export interface ProspectRow {
  id: string;
  feed_id: string;
  guid: string;
  url: string;
  /** Normalised form of `url`, shared with articles, so the same story dedupes across feeds. */
  url_key: string | null;
  title: string;
  author: string | null;
  /** Description/summary text lifted straight from the feed. Costs nothing. */
  teaser: string | null;
  /** Filled in only when the user asks for it. */
  summary: string | null;
  summary_model: string | null;
  summary_at: string | null;
  summary_error: string | null;
  published_at: string | null;
  seen_at: string | null;
  status: ProspectStatus;
  decided_at: string | null;
  article_id: string | null;
}

export interface FeedRow {
  id: string;
  url: string;
  title: string | null;
  tag: string | null;
  enabled: number;
  last_polled_at: string | null;
  last_error: string | null;
  added_at: string;
}

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.mkdirSync(config.booksDir, { recursive: true });
fs.mkdirSync(config.coversDir, { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT,
  requested_url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  site TEXT,
  excerpt TEXT,
  language TEXT,
  published_at TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  epub_path TEXT,
  epub_size INTEGER,
  cover_path TEXT,
  thumb_path TEXT,
  downloaded_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  feed_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_added_at ON articles (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_site ON articles (site);
CREATE INDEX IF NOT EXISTS idx_articles_downloaded ON articles (downloaded_at);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (article_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags (tag);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  tag TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_polled_at TEXT,
  last_error TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  url_key TEXT,
  title TEXT NOT NULL,
  author TEXT,
  teaser TEXT,
  summary TEXT,
  summary_model TEXT,
  summary_at TEXT,
  summary_error TEXT,
  published_at TEXT,
  seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  article_id TEXT REFERENCES articles (id) ON DELETE SET NULL,
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects (status, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_feed ON prospects (feed_id, status);

-- Legacy ledger of items processed before prospects existed. Kept only so that upgrading
-- does not re-surface a year of already-converted articles as fresh prospects.
CREATE TABLE IF NOT EXISTS feed_items (
  feed_id TEXT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (feed_id, guid)
);
`);

/** Additive migrations for databases created by an earlier version. */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('articles', 'canonical_url', 'TEXT');
addColumnIfMissing('prospects', 'url_key', 'TEXT');

/**
 * `UNIQUE (feed_id, guid)` only stops a feed offering the same item twice. Two feeds that
 * both carry a story -- two Hacker News views, say -- each produced their own prospect,
 * snapshotted at their own poll time. Articles have always deduped globally on url_key;
 * this gives prospects the same key, backfills it, collapses the duplicates that already
 * exist, and then enforces it.
 */
function backfillProspectUrlKeys(): void {
  const rows = db.prepare('SELECT id, url FROM prospects WHERE url_key IS NULL').all() as {
    id: string;
    url: string;
  }[];

  if (rows.length > 0) {
    const update = db.prepare('UPDATE prospects SET url_key = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of rows) {
        try {
          update.run(urlKey(row.url), row.id);
        } catch {
          // An unparseable URL keeps its raw form as the key; it still dedupes against itself.
          update.run(row.url, row.id);
        }
      }
    })();
  }

  // Keep one row per URL, preferring any that already carries a decision so that
  // collapsing duplicates can never resurface something the user has dealt with.
  db.exec(`
    DELETE FROM prospects WHERE url_key IS NOT NULL AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY url_key
          ORDER BY CASE status
                     WHEN 'saved' THEN 0 WHEN 'skipped' THEN 1
                     WHEN 'expired' THEN 2 ELSE 3 END,
                   seen_at
        ) AS rn
        FROM prospects WHERE url_key IS NOT NULL
      ) WHERE rn = 1
    )
  `);

  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_url_key ON prospects (url_key)');
  } catch {
    // Not fatal: addProspect checks explicitly too, so a startup here must not take the
    // server down over historical data.
  }
}

backfillProspectUrlKeys();

export function nowIso(): string {
  return new Date().toISOString();
}
