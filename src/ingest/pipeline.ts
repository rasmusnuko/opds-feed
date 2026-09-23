import { config } from '../config.js';
import type { ArticleRow } from '../db.js';
import { log } from '../logger.js';
import { markReady, type ReadyUpdate } from '../store.js';
import { removeArticleFiles, writeBook, writeCover } from '../storage.js';
import { readingMinutes, slugify, truncate } from '../util/text.js';
import { hostLabel } from '../util/url.js';
import { buildEpub, serializeBody } from './epub.js';
import { extractArticle } from './extract.js';
import { detectPaywall } from './paywall.js';
import { tagArticle } from './tagger.js';
import { decodeHtml, fetchUrl } from './fetch.js';
import { generateCover, prepareImages } from './images.js';

function assertHtml(contentType: string, url: string): void {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '' || type.startsWith('text/html') || type.startsWith('application/xhtml')) return;
  if (type.startsWith('text/')) return; // plain text still goes through extraction
  throw new Error(`${url} is ${type}, not an HTML page`);
}

/** Fetches, extracts, converts and stores a single article. Throws on any failure. */
export async function processArticle(article: ArticleRow): Promise<ReadyUpdate> {
  log.info('processing article', { id: article.id, url: article.url });

  const response = await fetchUrl(article.url);
  assertHtml(response.contentType, response.url);

  const html = decodeHtml(response);
  const extracted = extractArticle(html, response.url);

  try {
    const images = await prepareImages(extracted.content, response.url);
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
      bytes: epub.byteLength,
    });

    const update: ReadyUpdate = {
      // Keep the URL we actually fetched: a canonical link can point somewhere that
      // does not serve the article (or anything at all), which would break reconversion.
      url: response.url,
      canonicalUrl: extracted.canonicalUrl !== response.url ? extracted.canonicalUrl : null,
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
      paywall: detectPaywall(html, extracted.textContent, extracted.wordCount).reason,
    };

    markReady(article.id, update);

    // After it is ready, never before: a slow or failing model must not hold up or
    // fail the conversion. tagArticle swallows its own errors.
    await tagArticle({ id: article.id, title: extracted.title, site, excerpt: update.excerpt, text: extracted.textContent });
    return update;
  } finally {
    extracted.dispose();
  }
}
