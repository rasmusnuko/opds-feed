import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import type { FeedRow } from '../db.js';
import { errorFields, log } from '../logger.js';
import { isFeedItemSeen, listFeeds, recordFeedPoll } from '../store.js';
import { addProspect, expireOldProspects } from '../prospects.js';
import { cleanUrl, hostLabel } from '../util/url.js';
import { collapseWhitespace, stripHtml, truncate } from '../util/text.js';
import { decodeHtml, fetchUrl } from './fetch.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // The default caps *total* entity expansions at 1000 per document, and a feed whose
  // items carry HTML in their descriptions — Wikipedia's featured feed, most blogs —
  // has thousands of &amp; and &lt; in ordinary use. That guard is against
  // billion-laughs, which needs DOCTYPE-defined entities; maxEntityCount (still 1000)
  // is the one that actually stops that, so it stays.
  processEntities: { maxTotalExpansions: 200_000 },
});

// A feed is not an article. Full-content Atom feeds with a long archive run to 10 MB
// and more (danluu.com is 128 entries of full text), and the article cap is tuned for
// jsdom's memory, which never sees a feed.
const FEED_MAX_BYTES = 32 * 1024 * 1024;

interface FeedItem {
  url: string;
  guid: string;
  title: string | null;
  /** Description text the feed already gives us. The cheapest summary there is. */
  teaser: string | null;
  author: string | null;
  publishedAt: string | null;
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

/** Feeds put the teaser in any of several elements; take the richest one available. */
function teaserOf(node: Record<string, unknown>, keys: string[]): string | null {
  let best: string | null = null;

  for (const key of keys) {
    const raw = node[key];
    const text =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? ((raw as Record<string, unknown>)['#text'] as string | undefined)
          : undefined;
    if (typeof text !== 'string') continue;

    const clean = stripHtml(text);
    if (clean.length > (best?.length ?? 0)) best = clean;
  }

  return best ? truncate(best, 500) : null;
}

function authorOf(node: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = node[key];
    if (typeof raw === 'string') {
      const clean = collapseWhitespace(raw);
      if (clean.length > 0) return truncate(clean, 120);
    }
    if (raw && typeof raw === 'object') {
      const name = (raw as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim().length > 0) return truncate(collapseWhitespace(name), 120);
    }
  }
  return null;
}

function dateOf(node: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = node[key];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    const year = parsed.getUTCFullYear();
    if (year < 1990 || year > 2200) continue;
    return parsed.toISOString();
  }
  return null;
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
      items.push({
        url: link,
        guid: guidValue,
        title: textOf(item.title),
        teaser: teaserOf(item, ['content:encoded', 'description', 'summary']),
        author: authorOf(item, ['dc:creator', 'author', 'creator']),
        publishedAt: dateOf(item, ['pubDate', 'dc:date', 'date', 'published']),
      });
    }
  } else if (atom) {
    title = textOf(atom.title);
    for (const raw of asArray(atom.entry as unknown)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const link = atomLink(entry);
      if (!link) continue;
      items.push({
        url: link,
        guid: textOf(entry.id) ?? link,
        title: textOf(entry.title),
        teaser: teaserOf(entry, ['content', 'summary']),
        author: authorOf(entry, ['author']),
        publishedAt: dateOf(entry, ['published', 'updated']),
      });
    }
  }

  return { title, items };
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const response = await fetchUrl(url, {
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    maxBytes: FEED_MAX_BYTES,
  });
  return parseFeed(decodeHtml(response));
}

/**
 * Records what a feed is offering. Deliberately does not fetch, convert or store anything:
 * items sit in the prospect queue until the user saves one.
 */
async function pollFeed(feed: FeedRow): Promise<number> {
  const parsed = await fetchFeed(feed.url);
  let added = 0;

  // Newest first in most feeds; cap so a first poll of a large archive stays manageable.
  for (const item of parsed.items.slice(0, config.rss.maxItemsPerPoll)) {
    // Items converted before the prospect queue existed must not reappear as new.
    if (isFeedItemSeen(feed.id, item.guid)) continue;

    let url: string;
    try {
      url = cleanUrl(item.url);
    } catch (error) {
      log.warn('feed item has an unusable link', { feed: feed.url, item: item.url, ...errorFields(error) });
      continue;
    }

    const wasAdded = addProspect({
      feedId: feed.id,
      guid: item.guid,
      url,
      title: item.title ?? hostLabel(url) ?? url,
      author: item.author,
      teaser: item.teaser,
      publishedAt: item.publishedAt,
    });

    if (wasAdded) added += 1;
  }

  return added;
}

export async function pollAllFeeds(): Promise<void> {
  const expired = expireOldProspects();
  if (expired > 0) log.info('expired undecided prospects', { count: expired });

  const feeds = listFeeds().filter((feed) => feed.enabled === 1);
  if (feeds.length === 0) return;

  log.debug('polling feeds', { count: feeds.length });

  for (const feed of feeds) {
    try {
      const added = await pollFeed(feed);
      recordFeedPoll(feed.id, null);
      if (added > 0) log.info('feed offered new prospects', { feed: feed.url, added });
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
