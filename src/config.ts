import { randomBytes } from 'node:crypto';
import path from 'node:path';

function env(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function required(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function int(name: string, fallback: number, min?: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  // A zero page size or concurrency is always a mistake, and divides by zero downstream.
  return min !== undefined ? Math.max(min, parsed) : parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(name: string): string[] {
  const value = env(name);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Environment variable ${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

const dataDir = path.resolve(env('DATA_DIR', './data')!);

// Trailing slashes in the public URL leak into every link we generate, so strip them once here.
const publicUrl = (env('PUBLIC_URL', 'http://localhost:8080')!).replace(/\/+$/, '');

export const config = {
  host: env('HOST', '127.0.0.1')!,
  port: int('PORT', 8080),
  publicUrl,
  // When unset we derive links from the incoming request instead of guessing.
  publicUrlConfigured: env('PUBLIC_URL') !== undefined,
  dataDir,
  booksDir: path.join(dataDir, 'books'),
  coversDir: path.join(dataDir, 'covers'),
  databasePath: env('DATABASE_PATH', path.join(dataDir, 'opds-feed.sqlite'))!,

  catalogTitle: env('CATALOG_TITLE', 'Articles')!,
  catalogAuthor: env('CATALOG_AUTHOR', 'opds-feed')!,

  auth: {
    username: required('OPDS_USERNAME'),
    // Either a scrypt hash (preferred, produced by `npm run hash-password`) or a plaintext password.
    password: env('OPDS_PASSWORD'),
    realm: env('OPDS_REALM', 'opds-feed')!,
    // Extra bearer tokens for the ingest API. Basic auth is always accepted too.
    apiTokens: list('API_TOKENS'),
  },

  feed: {
    pageSize: int('FEED_PAGE_SIZE', 25, 1),
    recentDays: int('FEED_RECENT_DAYS', 14, 1),
  },

  fetch: {
    userAgent: env(
      'FETCH_USER_AGENT',
      'Mozilla/5.0 (compatible; opds-feed/0.1; +https://github.com/rasmusnuko/opds-feed)',
    )!,
    timeoutMs: int('FETCH_TIMEOUT_MS', 30_000, 1_000),
    maxBytes: int('FETCH_MAX_BYTES', 10 * 1024 * 1024, 64 * 1024),
    // Fetching user-supplied URLs server side is an SSRF vector; refuse private targets by default.
    allowPrivateAddresses: bool('FETCH_ALLOW_PRIVATE_ADDRESSES', false),
  },

  // Reader-compatibility knobs. The defaults suit small greyscale e-ink screens but nothing
  // here is device specific -- raise them for a tablet, disable them for a desktop reader.
  epub: {
    embedImages: bool('EPUB_EMBED_IMAGES', true),
    imageMode: oneOf('EPUB_IMAGE_MODE', ['greyscale', 'colour'] as const, 'greyscale'),
    maxImageWidth: int('EPUB_MAX_IMAGE_WIDTH', 800, 64),
    maxImages: int('EPUB_MAX_IMAGES', 40, 0),
    jpegQuality: int('EPUB_JPEG_QUALITY', 72),
    coverWidth: int('EPUB_COVER_WIDTH', 600, 120),
    coverHeight: int('EPUB_COVER_HEIGHT', 800, 120),
    language: env('EPUB_LANGUAGE', 'en')!,
  },

  queue: {
    concurrency: int('QUEUE_CONCURRENCY', 2, 1),
    maxAttempts: int('QUEUE_MAX_ATTEMPTS', 3, 1),
    retryDelayMs: int('QUEUE_RETRY_DELAY_MS', 30_000),
  },

  rss: {
    enabled: bool('RSS_ENABLED', true),
    pollIntervalMinutes: int('RSS_POLL_INTERVAL_MINUTES', 30, 1),
    maxItemsPerPoll: int('RSS_MAX_ITEMS_PER_POLL', 10, 1),
  },

  logLevel: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
  trustProxy: bool('TRUST_PROXY', true),
} as const;

export type Config = typeof config;

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}
