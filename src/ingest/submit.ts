import type { ArticleRow } from '../db.js';
import { log } from '../logger.js';
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

  let requeued = false;
  if (!created && (options.force || article.status === 'failed')) {
    resetAttempts(article.id);
    requeued = true;
  }

  if (created || requeued) {
    log.info(created ? 'article queued' : 'article requeued', { id: article.id, url });
    tick();
  }

  return { article: getArticle(article.id) ?? article, created, requeued };
}
