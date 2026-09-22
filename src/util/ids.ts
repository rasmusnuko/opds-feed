import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, lowercase, URL- and filename-safe identifier. */
export function newId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

const ID_PATTERN = /^[0-9a-z]{6,32}$/;

/** Guards every path parameter that is interpolated into a filesystem path. */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}
