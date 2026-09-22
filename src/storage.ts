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
