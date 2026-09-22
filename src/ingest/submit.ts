import type { ArticleRow } from '../db.js';
import { log } from '../logger.js';
import { writeSnapshot } from '../storage.js';
import { createArticle, getArticle, resetAttempts } from '../store.js';
import { truncate } from '../util/text.js';
import { cleanUrl, hostLabel, urlKey } from '../util/url.js';
import { tick } from './queue.js';

export interface SubmitOptions {
  tags?: string[];
  feedId?: string | null;
  title?: string | null;
  /** Re-run an article that already exists (used by the retry button). */
  force?: boolean;
  /** The page as the user's browser rendered it (bookmarklet / shortcut). Used instead of fetching. */
  html?: string | null;
  /** HTML of the part of the page the user highlighted. Used as the article body. */
  selection?: string | null;
}

export interface SubmitResult {
  article: ArticleRow;
  created: boolean;
  requeued: boolean;
}

/**
 * Single entry point for every ingest front end (API, web form, RSS poller).
 * Returns immediately; the queue does the fetching and conversion.
 */
export function submitUrl(rawUrl: string, options: SubmitOptions = {}): SubmitResult {
  const url = cleanUrl(rawUrl);
  const key = urlKey(url);
  const site = hostLabel(url);

  const { article, created } = createArticle({
    url,
    requestedUrl: rawUrl.trim(),
    urlKey: key,
    title: options.title ? truncate(options.title, 300) : (site ?? url),
    site,
    tags: options.tags ?? [],
    feedId: options.feedId ?? null,
  });

  const html = options.html?.trim() ? options.html : null;
  const selection = options.selection?.trim() ? options.selection : null;
  const hasSnapshot = html !== null || selection !== null;
  if (hasSnapshot) {
    writeSnapshot(article.id, { html, selection, submittedAt: new Date().toISOString() });
  }

  let requeued = false;
  // Fresh HTML from the browser is a request to convert again, even if we have a copy.
  if (!created && (options.force || hasSnapshot || article.status === 'failed')) {
    resetAttempts(article.id);
    requeued = true;
  }

  if (created || requeued) {
    log.info(created ? 'article queued' : 'article requeued', { id: article.id, url, snapshot: hasSnapshot });
    tick();
  }

  return { article: getArticle(article.id) ?? article, created, requeued };
}
