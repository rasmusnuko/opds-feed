import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 32;
export const SCRYPT_PREFIX = 'scrypt$';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyScrypt(password: string, stored: string): boolean {
  const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
  const saltPart = parts[0];
  const hashPart = parts[1];
  if (parts.length !== 2 || !saltPart || !hashPart) return false;
  const salt = Buffer.from(saltPart, 'base64');
  const expected = Buffer.from(hashPart, 'base64');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(derived, expected);
}

/** Compares digests rather than raw values so the comparison is length independent. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
