import { config } from '../config.js';
import type { ArticleRow } from '../db.js';
import { log } from '../logger.js';
import { markReady, type ReadyUpdate } from '../store.js';
import { readSnapshot, removeArticleFiles, writeBook, writeCover } from '../storage.js';
import { escapeXml, readingMinutes, slugify, truncate } from '../util/text.js';
import { hostLabel } from '../util/url.js';
import { buildEpub, serializeBody } from './epub.js';
import { extractArticle } from './extract.js';
import { decodeHtml, fetchUrl } from './fetch.js';
import { generateCover, prepareImages } from './images.js';

function assertHtml(contentType: string, url: string): void {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '' || type.startsWith('text/html') || type.startsWith('application/xhtml')) return;
  if (type.startsWith('text/')) return; // plain text still goes through extraction
  throw new Error(`${url} is ${type}, not an HTML page`);
}

async function fetchPage(url: string): Promise<{ url: string; html: string }> {
  const response = await fetchUrl(url);
  assertHtml(response.contentType, response.url);
  return { url: response.url, html: decodeHtml(response) };
}

/** Fetches, extracts, converts and stores a single article. Throws on any failure. */
export async function processArticle(article: ArticleRow): Promise<ReadyUpdate> {
  log.info('processing article', { id: article.id, url: article.url });

  // Step 8: a page the user's browser sent beats anything we can fetch ourselves (it has
  // their logins, has run its JavaScript, and got past any bot wall).
  const snapshot = await readSnapshot(article.id);
  let page: { url: string; html: string };
  if (snapshot?.html) {
    page = { url: article.url, html: snapshot.html };
  } else if (snapshot?.selection) {
    // Only a selection was sent: fetch the page anyway for its metadata, but settle for
    // a bare document if the server cannot reach it.
    try {
      page = await fetchPage(article.url);
    } catch (error) {
      log.info('using selection without page metadata', { id: article.id, reason: String(error) });
      const html = `<!doctype html><html><head><title>${escapeXml(article.title)}</title></head><body></body></html>`;
      page = { url: article.url, html };
    }
  } else {
    page = await fetchPage(article.url);
  }
  const pageUrl = page.url;

  const extracted = await extractArticle(page.html, pageUrl, { selection: snapshot?.selection ?? null });

  try {
    const images = await prepareImages(extracted.content, pageUrl);
    const bodyXhtml = serializeBody(extracted.content);

    const minutes = readingMinutes(extracted.wordCount);
    const site = extracted.siteName ?? hostLabel(extracted.canonicalUrl);
    const language = (extracted.language ?? config.epub.language).slice(0, 10);

    const { cover, thumbnail } = await generateCover({
      title: extracted.title,
      site,
      date: extracted.publishedAt ? extracted.publishedAt.slice(0, 10) : null,
      readingMinutes: minutes,
    });

    const epub = await buildEpub({
      id: article.id,
      title: extracted.title,
      author: extracted.byline,
      site,
      language,
      sourceUrl: extracted.canonicalUrl,   // what a reader should share
      publishedAt: extracted.publishedAt,
      addedAt: article.added_at,
      readingMinutes: minutes,
      wordCount: extracted.wordCount,
      bodyXhtml,
      images,
      cover,
    });

    // Reprocessing an article writes a new filename; clear the old files first.
    await removeArticleFiles(article);

    const epubName = `${article.id}-${slugify(extracted.title)}.epub`;
    const coverName = `${article.id}.jpg`;
    const thumbName = `${article.id}-thumb.jpg`;

    await writeBook(epubName, epub);
    await writeCover(coverName, cover);
    await writeCover(thumbName, thumbnail);

    log.info('article ready', {
      id: article.id,
      title: extracted.title,
      words: extracted.wordCount,
      images: images.length,
      extractor: extracted.extractor,
      bytes: epub.byteLength,
    });

    const update: ReadyUpdate = {
      // Keep the URL we actually fetched: a canonical link can point somewhere that
      // does not serve the article (or anything at all), which would break reconversion.
      url: pageUrl,
      canonicalUrl: extracted.canonicalUrl !== pageUrl ? extracted.canonicalUrl : null,
      title: extracted.title,
      author: extracted.byline,
      site,
      excerpt: extracted.excerpt ? truncate(extracted.excerpt, 400) : null,
      language,
      publishedAt: extracted.publishedAt,
      wordCount: extracted.wordCount,
      readingMinutes: minutes,
      epubPath: epubName,
      epubSize: epub.byteLength,
      coverPath: coverName,
      thumbPath: thumbName,
      extractor: extracted.extractor,
    };

    markReady(article.id, update);
    return update;
  } finally {
    extracted.dispose();
  }
}
