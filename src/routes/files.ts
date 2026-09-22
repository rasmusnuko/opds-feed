import fs from 'node:fs/promises';
import { Hono } from 'hono';
import { getArticle, recordDownload } from '../store.js';
import { bookPath, coverPath } from '../storage.js';
import { isValidId } from '../util/ids.js';
import { slugify } from '../util/text.js';

export const fileRoutes = new Hono();

function asciiFallback(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

interface RangeSpec {
  start: number;
  end: number;
}

/** Minimal single-range support: enough for resumable downloaders, no multipart. */
function parseRange(header: string | undefined, size: number): RangeSpec | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';

  if (startRaw === '' && endRaw === '') return 'invalid';

  let start: number;
  let end: number;

  if (startRaw === '') {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

fileRoutes.on(['GET', 'HEAD'], '/download/:file', async (c) => {
  const file = c.req.param('file');
  const id = file.endsWith('.epub') ? file.slice(0, -'.epub'.length) : file;

  if (!isValidId(id)) return c.text('Not found\n', 404);

  const article = getArticle(id);
  if (!article || article.status !== 'ready' || !article.epub_path) {
    return c.text('Not found\n', 404);
  }

  const target = bookPath(article.epub_path);
  if (!target) return c.text('Not found\n', 404);

  let data: Buffer;
  try {
    data = await fs.readFile(target);
  } catch {
    return c.text('Not found\n', 404);
  }

  const filename = `${slugify(article.title)}.epub`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/epub+zip',
    'Content-Disposition': `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(
      filename,
    )}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };

  const range = parseRange(c.req.header('range'), data.byteLength);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${data.byteLength}` },
    });
  }

  if (c.req.method === 'GET') {
    // "Downloaded" is the closest signal to "read" that OPDS gives us; it drives the
    // "Not yet downloaded" shelf.
    recordDownload(article.id);
  }

  if (range) {
    const slice = data.subarray(range.start, range.end + 1);
    return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(slice), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${data.byteLength}`,
        'Content-Length': String(slice.byteLength),
      },
    });
  }

  // An explicit Content-Length keeps simple readers off chunked transfer encoding.
  return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(data), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(data.byteLength) },
  });
});

fileRoutes.on(['GET', 'HEAD'], '/covers/:file', async (c) => {
  const file = c.req.param('file');
  const match = /^([0-9a-z]{6,32})(-thumb)?\.jpg$/.exec(file);
  if (!match) return c.text('Not found\n', 404);

  const id = match[1]!;
  const wantThumb = Boolean(match[2]);

  const article = getArticle(id);
  if (!article) return c.text('Not found\n', 404);

  const stored = wantThumb ? article.thumb_path : article.cover_path;
  if (!stored) return c.text('Not found\n', 404);

  const target = coverPath(stored);
  if (!target) return c.text('Not found\n', 404);

  let data: Buffer;
  try {
    data = await fs.readFile(target);
  } catch {
    return c.text('Not found\n', 404);
  }

  return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(data.byteLength),
      // Covers are immutable for a given article id + filename.
      'Cache-Control': 'private, max-age=86400',
    },
  });
});
