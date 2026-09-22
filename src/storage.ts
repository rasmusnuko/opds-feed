import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/** Stored filenames are generated, never user supplied, but resolve defensively anyway. */
function resolveWithin(directory: string, filename: string): string | null {
  const resolved = path.resolve(directory, filename);
  const root = path.resolve(directory);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export function bookPath(filename: string): string | null {
  return resolveWithin(config.booksDir, filename);
}

export function coverPath(filename: string): string | null {
  return resolveWithin(config.coversDir, filename);
}

export async function writeBook(filename: string, data: Buffer): Promise<void> {
  const target = bookPath(filename);
  if (!target) throw new Error(`Refusing to write outside the books directory: ${filename}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

export async function writeCover(filename: string, data: Buffer): Promise<void> {
  const target = coverPath(filename);
  if (!target) throw new Error(`Refusing to write outside the covers directory: ${filename}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

async function removeQuietly(target: string | null): Promise<void> {
  if (!target) return;
  try {
    await fs.unlink(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('could not remove file', { target, code });
    }
  }
}

export async function removeArticleFiles(files: {
  epub_path: string | null;
  cover_path: string | null;
  thumb_path: string | null;
}): Promise<void> {
  await removeQuietly(files.epub_path ? bookPath(files.epub_path) : null);
  await removeQuietly(files.cover_path ? coverPath(files.cover_path) : null);
  await removeQuietly(files.thumb_path ? coverPath(files.thumb_path) : null);
}

/** A page as the user's browser saw it, sent alongside the URL by a bookmarklet or shortcut. */
export interface Snapshot {
  /** The whole document, or null when only a selection was sent. */
  html: string | null;
  /** HTML of the part the user highlighted, if anything. */
  selection: string | null;
  submittedAt: string;
}

function snapshotPath(articleId: string): string | null {
  return resolveWithin(config.snapshotsDir, `${articleId}.json`);
}

/** Synchronous so submitting stays synchronous; snapshots are written once per submit. */
export function writeSnapshot(articleId: string, snapshot: Snapshot): void {
  const target = snapshotPath(articleId);
  if (!target) throw new Error(`Refusing to write outside the snapshots directory: ${articleId}`);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, JSON.stringify(snapshot));
}

export async function readSnapshot(articleId: string): Promise<Snapshot | null> {
  const target = snapshotPath(articleId);
  if (!target) return null;
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    return {
      html: typeof parsed.html === 'string' ? parsed.html : null,
      selection: typeof parsed.selection === 'string' ? parsed.selection : null,
      submittedAt: typeof parsed.submittedAt === 'string' ? parsed.submittedAt : '',
    };
  } catch {
    log.warn('ignoring unreadable snapshot', { target });
    return null;
  }
}

export async function removeSnapshot(articleId: string): Promise<void> {
  await removeQuietly(snapshotPath(articleId));
}
