import { randomBytes } from './primitives.js';

/**
 * Recovery codes.
 *
 * A forgotten passphrase means the library is gone; there is no reset, because a reset
 * the operator can perform is a backdoor the operator can be compelled to use. The
 * recovery code is the user's own second copy of the key, shown once at signup.
 *
 * Crockford base32: no I, L, O or U, so it cannot be misread and cannot spell anything.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP_SIZE = 4;
const ENTROPY_BYTES = 20; // 160 bits

export function generateRecoveryCode(): string {
  const bytes = randomBytes(ENTROPY_BYTES);

  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  const groups: string[] = [];
  for (let i = 0; i < out.length; i += GROUP_SIZE) {
    groups.push(out.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Users retype these from paper, so accept the obvious confusions: lower case, missing or
 * extra dashes and spaces, and the letters Crockford deliberately dropped.
 */
export function normaliseRecoveryCode(code: string): string {
  const cleaned = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  if (cleaned.length === 0) throw new Error('Recovery code is empty');
  return cleaned;
}
