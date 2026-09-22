import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Cryptographic primitives for the encrypted vault.
 *
 * Everything here uses only WebCrypto and @noble/hashes, both of which behave identically
 * in Node and in a browser. That is deliberate: whichever delivery model we settle on
 * (server-side decryption, a local bridge, or a browser extension), the key handling and
 * the on-disk format must not change.
 */

export const KEY_BYTES = 32; // AES-256
export const NONCE_BYTES = 12; // GCM standard nonce
export const TAG_BYTES = 16;
export const SALT_BYTES = 16;

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

/** getRandomValues caps each call at 65536 bytes. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

/** Thrown for every decryption failure, with no detail about which check failed. */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/* ------------------------------------------------------------------ key derivation */

export interface KdfParams {
  alg: 'argon2id';
  /** Memory cost in KiB. */
  m: number;
  /** Time cost (passes). */
  t: number;
  /** Parallelism. */
  p: number;
}

/**
 * Comfortably above the OWASP Argon2id floor (19 MiB / t=2). Roughly 1.4s in pure JS,
 * which is the right order for a key derived once per unlock. Stored per account so it
 * can be raised later without invalidating existing vaults.
 */
export const DEFAULT_KDF: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

export function assertKdfParams(params: KdfParams): void {
  if (params.alg !== 'argon2id') {
    throw new Error(`Unsupported KDF algorithm: ${String(params.alg)}`);
  }
  if (!Number.isInteger(params.m) || params.m < 8192) {
    throw new Error('KDF memory cost must be at least 8192 KiB');
  }
  if (!Number.isInteger(params.t) || params.t < 1) {
    throw new Error('KDF time cost must be at least 1');
  }
  if (!Number.isInteger(params.p) || params.p < 1) {
    throw new Error('KDF parallelism must be at least 1');
  }
}

/**
 * Derives the key-encryption key from a passphrase.
 *
 * The passphrase is NFKC-normalised first: the same characters typed on a phone and on a
 * desktop can arrive as different byte sequences otherwise, and the user would be locked
 * out of their own vault.
 */
export function deriveKek(passphrase: string, salt: Uint8Array, params: KdfParams): Uint8Array {
  assertKdfParams(params);
  if (salt.length < SALT_BYTES) {
    throw new Error(`KDF salt must be at least ${SALT_BYTES} bytes`);
  }
  return argon2id(utf8(passphrase.normalize('NFKC')), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: KEY_BYTES,
  });
}

/**
 * Domain separation: every purpose gets its own key derived from the master key, so no
 * single key is ever used for two different things.
 */
export function subkey(master: Uint8Array, label: string): Uint8Array {
  if (master.length !== KEY_BYTES) throw new Error('Master key must be 32 bytes');
  return hkdf(sha256, master, undefined, utf8(label), KEY_BYTES);
}

/**
 * Keyed, deterministic index over a plaintext value. Lets the server enforce a uniqueness
 * constraint (article already saved?) without learning the URL. The key never leaves the
 * holder of the vault, and it is per account, so identical URLs across two accounts do
 * not produce the same index.
 */
export function blindIndex(key: Uint8Array, value: string): string {
  return toHex(hmac(sha256, key, utf8(value)));
}

/* ------------------------------------------------------------------ AEAD */

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error('AES key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usages);
}

/**
 * AES-256-GCM. Returns nonce || ciphertext || tag.
 *
 * Nonces are random 96-bit values, which is safe up to roughly 2^32 messages under one
 * key. Content keys are used exactly once, and the wrapping keys would need billions of
 * articles to approach the bound.
 *
 * `aad` binds the ciphertext to its context (owner, article, purpose) so that a blob
 * cannot be moved to another record or another user's account and still decrypt.
 */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_BYTES);
  const aesKey = await importAesKey(key, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource, tagLength: TAG_BYTES * 8 },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

export async function open(key: Uint8Array, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError();

  const nonce = sealed.subarray(0, NONCE_BYTES);
  const body = sealed.subarray(NONCE_BYTES);
  const aesKey = await importAesKey(key, ['decrypt']);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource, tagLength: TAG_BYTES * 8 },
      aesKey,
      body as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // Deliberately opaque: a wrong key, a tampered tag and a mismatched AAD look alike.
    throw new DecryptionError();
  }
}

/* ------------------------------------------------------------------ encoding helpers */

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Best effort only. JavaScript gives no guarantee that a copy was not left elsewhere by
 * the garbage collector, so this reduces the window rather than closing it.
 */
export function wipe(...buffers: Uint8Array[]): void {
  for (const buffer of buffers) buffer.fill(0);
}
