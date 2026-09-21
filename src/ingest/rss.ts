import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import type { FeedRow } from '../db.js';
import { errorFields, log } from '../logger.js';
import { isFeedItemSeen, listFeeds, markFeedItemSeen, recordFeedPoll } from '../store.js';
import { collapseWhitespace } from '../util/text.js';
import { decodeHtml, fetchUrl } from './fetch.js';
import { submitUrl } from './submit.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

interface FeedItem {
  url: string;
  guid: string;
  title: string | null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return collapseWhitespace(value) || null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return collapseWhitespace(text) || null;
  }
  return null;
}

function atomLink(entry: Record<string, unknown>): string | null {
  const links = asArray(entry.link as unknown);
  let fallback: string | null = null;

  for (const link of links) {
    if (typeof link === 'string') {
      fallback ??= link;
      continue;
    }
    if (!link || typeof link !== 'object') continue;
    const record = link as Record<string, unknown>;
    const href = record['@_href'];
    if (typeof href !== 'string') continue;
    const rel = record['@_rel'];
    if (rel === undefined || rel === 'alternate') return href;
    fallback ??= href;
  }

  return fallback;
}

export interface ParsedFeed {
  title: string | null;
  items: FeedItem[];
}

export function parseFeed(xml: string): ParsedFeed {
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const rss = parsed.rss as Record<string, unknown> | undefined;
  const rdf = parsed['rdf:RDF'] as Record<string, unknown> | undefined;
  const atom = parsed.feed as Record<string, unknown> | undefined;

  const items: FeedItem[] = [];
  let title: string | null = null;

  if (rss || rdf) {
    const channel = (rss?.channel ?? rdf?.channel) as Record<string, unknown> | undefined;
    title = textOf(channel?.title);
    const rawItems = asArray((channel?.item ?? rdf?.item) as unknown);
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const link = textOf(item.link) ?? textOf(item['@_rdf:about']);
      if (!link) continue;
      const guidValue = textOf(item.guid) ?? link;
      items.push({ url: link, guid: guidValue, title: textOf(item.title) });
    }
  } else if (atom) {
    title = textOf(atom.title);
    for (const raw of asArray(atom.entry as unknown)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const link = atomLink(entry);
      if (!link) continue;
      items.push({ url: link, guid: textOf(entry.id) ?? link, title: textOf(entry.title) });
    }
  }

  return { title, items };
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const response = await fetchUrl(url, {
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  });
  return parseFeed(decodeHtml(response));
}

async function pollFeed(feed: FeedRow): Promise<number> {
  const parsed = await fetchFeed(feed.url);
  let queued = 0;

  // Newest first in most feeds; cap so a first poll of a large archive does not flood the queue.
  for (const item of parsed.items.slice(0, config.rss.maxItemsPerPoll)) {
    if (isFeedItemSeen(feed.id, item.guid)) continue;
    try {
      submitUrl(item.url, {
        tags: feed.tag ? [feed.tag] : [],
        feedId: feed.id,
        title: item.title,
      });
      queued += 1;
    } catch (error) {
      log.warn('feed item rejected', { feed: feed.url, item: item.url, ...errorFields(error) });
    }
    markFeedItemSeen(feed.id, item.guid);
  }

  return queued;
}

export async function pollAllFeeds(): Promise<void> {
  const feeds = listFeeds().filter((feed) => feed.enabled === 1);
  if (feeds.length === 0) return;

  log.debug('polling feeds', { count: feeds.length });

  for (const feed of feeds) {
    try {
      const queued = await pollFeed(feed);
      recordFeedPoll(feed.id, null);
      if (queued > 0) log.info('feed queued new articles', { feed: feed.url, queued });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordFeedPoll(feed.id, message);
      log.warn('feed poll failed', { feed: feed.url, ...errorFields(error) });
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startFeedPoller(): void {
  if (!config.rss.enabled) return;

  const intervalMs = Math.max(1, config.rss.pollIntervalMinutes) * 60_000;
  timer = setInterval(() => {
    void pollAllFeeds();
  }, intervalMs);
  timer.unref();

  // Give the server a moment to come up before the first poll.
  setTimeout(() => void pollAllFeeds(), 10_000).unref();
}

export function stopFeedPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
