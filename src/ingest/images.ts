import sharp from 'sharp';
import { config } from '../config.js';
import { log } from '../logger.js';
import { escapeXml, truncate } from '../util/text.js';
import { fetchUrl } from './fetch.js';

export interface PreparedImage {
  /** Path inside the EPUB, relative to the content document. */
  href: string;
  mediaType: string;
  data: Buffer;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Cumulative download budget for one article, across all of its images. */
const TOTAL_IMAGE_BYTES = 48 * 1024 * 1024;
const IMAGE_CONCURRENCY = 4;
const MIN_IMAGE_DIMENSION = 64;

function decodeDataUri(uri: string): Buffer | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  try {
    return isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Re-encodes every image to baseline (non-progressive) JPEG. Small readers commonly refuse
 * progressive JPEGs, animated GIFs and WebP, and greyscale halves the file size on e-ink.
 */
async function transcode(input: Buffer): Promise<Buffer | null> {
  try {
    const pipeline = sharp(input, { failOn: 'none', animated: false });
    const metadata = await pipeline.metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    // Tracking pixels and spacer GIFs are not worth embedding.
    if (width > 0 && height > 0 && width < MIN_IMAGE_DIMENSION && height < MIN_IMAGE_DIMENSION) {
      return null;
    }

    let processed = pipeline.rotate(); // honour EXIF orientation before resizing

    if (width > config.epub.maxImageWidth) {
      processed = processed.resize({ width: config.epub.maxImageWidth, withoutEnlargement: true });
    }

    processed = processed.flatten({ background: '#ffffff' }); // JPEG has no alpha channel

    if (config.epub.imageMode === 'greyscale') {
      // flatten() returns to sRGB, so the colourspace change has to come after it;
      // toColourspace writes a genuinely single-channel JPEG rather than grey RGB.
      processed = processed.greyscale().toColourspace('b-w');
    }

    return await processed
      .jpeg({ quality: config.epub.jpegQuality, progressive: false, mozjpeg: false })
      .toBuffer();
  } catch (error) {
    log.debug('image transcode failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Downloads and rewrites every <img> in the article body. Images that cannot be fetched or
 * decoded are dropped from the DOM rather than left as broken references.
 */
export async function prepareImages(content: Element, referer: string): Promise<PreparedImage[]> {
  const elements = [...content.querySelectorAll('img')];

  if (!config.epub.embedImages || config.epub.maxImages === 0) {
    for (const img of elements) img.remove();
    return [];
  }

  // De-duplicate first: the same photo often appears several times in one article, and
  // fetching it once keeps both the conversion and the finished EPUB small.
  const order: string[] = [];
  for (const img of elements) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (!order.includes(src)) order.push(src);
    if (order.length >= config.epub.maxImages) break;
  }

  const results = new Map<string, Buffer>();
  let budget = TOTAL_IMAGE_BYTES;

  const fetchOne = async (src: string): Promise<void> => {
    let raw: Buffer | null = null;

    if (src.startsWith('data:')) {
      raw = decodeDataUri(src);
    } else {
      // A page full of huge images should not be able to pull an unbounded amount of data.
      const allowance = Math.min(MAX_IMAGE_BYTES, budget);
      if (allowance <= 0) return;
      try {
        const response = await fetchUrl(src, {
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          maxBytes: allowance,
          referer,
        });
        raw = response.body;
        budget -= response.body.byteLength;
      } catch (error) {
        log.debug('image fetch failed', {
          src,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    const encoded = raw ? await transcode(raw) : null;
    if (encoded) results.set(src, encoded);
  };

  // A long article can carry dozens of images; serialising them is the slowest part of
  // the whole pipeline, and the point of this service is that an article lands quickly.
  const queue = [...order];
  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fetchOne(next);
    }
  });
  await Promise.all(workers);

  // Number the files by first appearance so the EPUB reads in document order.
  const images: PreparedImage[] = [];
  const hrefBySource = new Map<string, string>();
  for (const src of order) {
    const data = results.get(src);
    if (!data) continue;
    const href = `images/img-${String(images.length + 1).padStart(3, '0')}.jpg`;
    images.push({ href, mediaType: 'image/jpeg', data });
    hrefBySource.set(src, href);
  }

  for (const img of elements) {
    const src = img.getAttribute('src');
    const href = src ? hrefBySource.get(src) : undefined;
    if (href) img.setAttribute('src', href);
    else img.remove();
  }

  return images;
}

function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = word.length > maxCharsPerLine ? `${word.slice(0, maxCharsPerLine - 1)}…` : word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current.length > 0) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxCharsPerLine - 1))}…`;
  }
  return lines;
}

export interface CoverInput {
  title: string;
  site: string | null;
  date: string | null;
  readingMinutes: number;
}

export interface GeneratedCover {
  cover: Buffer;
  thumbnail: Buffer;
}

/**
 * Builds a typographic cover rather than reusing the article's lead image: it stays small
 * (large covers are slow to thumbnail on low-powered readers), renders predictably in
 * greyscale, and keeps the shelf legible at postage-stamp size.
 */
export async function generateCover(input: CoverInput): Promise<GeneratedCover> {
  const width = config.epub.coverWidth;
  const height = config.epub.coverHeight;

  const titleSize = Math.round(width / 12);
  const metaSize = Math.round(width / 26);
  // 0.58em is a decent average glyph width for the bold sans above; 0.78 keeps the text
  // clear of the drawn border.
  const charsPerLine = Math.floor((width * 0.78) / (titleSize * 0.58));
  const lines = wrapText(input.title, Math.max(8, charsPerLine), 6);

  const blockHeight = lines.length * titleSize * 1.25;
  const titleTop = Math.max(height * 0.22, height / 2 - blockHeight / 2);

  const footerParts = [input.site, input.date, `${input.readingMinutes} min read`].filter(
    (part): part is string => Boolean(part && part.length > 0),
  );

  const titleLines = lines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${titleTop + i * titleSize * 1.25}" text-anchor="middle" ` +
        `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${titleSize}" ` +
        `font-weight="700" fill="#101010">${escapeXml(line)}</text>`,
    )
    .join('\n    ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <rect x="${width * 0.06}" y="${height * 0.05}" width="${width * 0.88}" height="${height * 0.9}"
        fill="none" stroke="#101010" stroke-width="${Math.max(2, width / 200)}"/>
  <rect x="${width * 0.1}" y="${height * 0.14}" width="${width * 0.18}" height="${Math.max(3, width / 150)}" fill="#101010"/>
  ${titleLines}
  <text x="${width / 2}" y="${height * 0.86}" text-anchor="middle"
        font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${metaSize}"
        fill="#404040">${escapeXml(truncate(footerParts.join('  ·  '), 60))}</text>
</svg>`;

  const cover = await sharp(Buffer.from(svg))
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')
    .jpeg({ quality: 82, progressive: false, mozjpeg: false })
    .toBuffer();

  const thumbnail = await sharp(cover)
    .resize({ width: 180, withoutEnlargement: true })
    .jpeg({ quality: 75, progressive: false, mozjpeg: false })
    .toBuffer();

  return { cover, thumbnail };
}
