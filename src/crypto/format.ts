import { DecryptionError, concat } from './primitives.js';

/**
 * On-disk container for an encrypted item.
 *
 * This format is written to permanent storage, so it carries its own magic number, a
 * version and a cipher-suite byte. Anything that reads a container must reject a version
 * or suite it does not implement rather than guessing.
 *
 *   offset  size  field
 *   0       6     magic "OPDSEV"
 *   6       1     format version
 *   7       1     cipher suite
 *   8       1     flags (bit 0: payload is length-prefixed and padded)
 *   9       1     reserved, must be 0
 *   10      2     wrapped content-key length, big endian
 *   12      n     wrapped content key (nonce || ciphertext || tag)
 *   12+n    ...   sealed payload (nonce || ciphertext || tag)
 *
 * The wrapped content key travels inside the container rather than in the database, so a
 * blob plus the account's master key is enough to recover the content. Backups and
 * exports stay self-describing, and losing the database does not lose the library.
 */

export const MAGIC = new Uint8Array([0x4f, 0x50, 0x44, 0x53, 0x45, 0x56]); // "OPDSEV"
export const FORMAT_VERSION = 1;

/** AES-256-GCM content encryption, Argon2id passphrase KDF, HKDF-SHA256 subkeys. */
export const SUITE_AES256_GCM = 1;

export const FLAG_PADDED = 0x01;

export const HEADER_BYTES = 12;

/**
 * Ciphertext length leaks plaintext length. Rounding up to a block blurs that: it will
 * not hide the difference between a news article and a novel, but it does stop an
 * observer fingerprinting a specific known file by its exact byte count.
 */
export const DEFAULT_PAD_BLOCK = 16 * 1024;

export interface Container {
  version: number;
  suite: number;
  wrappedKey: Uint8Array;
  payload: Uint8Array;
  padded: boolean;
}

export function encodeContainer(input: Omit<Container, 'version' | 'suite'> & { version?: number; suite?: number }): Uint8Array {
  const { wrappedKey, payload } = input;
  if (wrappedKey.length > 0xffff) throw new Error('Wrapped key is too large for the container');

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[6] = input.version ?? FORMAT_VERSION;
  header[7] = input.suite ?? SUITE_AES256_GCM;
  header[8] = input.padded ? FLAG_PADDED : 0;
  header[9] = 0;
  header[10] = (wrappedKey.length >>> 8) & 0xff;
  header[11] = wrappedKey.length & 0xff;

  return concat(header, wrappedKey, payload);
}

export function decodeContainer(bytes: Uint8Array): Container {
  if (bytes.length < HEADER_BYTES) throw new DecryptionError('Not an opds-feed container');

  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new DecryptionError('Not an opds-feed container');
  }

  const version = bytes[6]!;
  const suite = bytes[7]!;
  const flags = bytes[8]!;

  if (version !== FORMAT_VERSION) {
    throw new DecryptionError(`Unsupported container version ${version}`);
  }
  if (suite !== SUITE_AES256_GCM) {
    throw new DecryptionError(`Unsupported cipher suite ${suite}`);
  }

  const wrappedKeyLength = (bytes[10]! << 8) | bytes[11]!;
  const payloadStart = HEADER_BYTES + wrappedKeyLength;
  if (bytes.length < payloadStart) throw new DecryptionError('Container is truncated');

  return {
    version,
    suite,
    wrappedKey: bytes.subarray(HEADER_BYTES, payloadStart),
    payload: bytes.subarray(payloadStart),
    padded: (flags & FLAG_PADDED) !== 0,
  };
}

/** Prefixes the true length as a big-endian uint32, then pads with zeros to `block`. */
export function pad(data: Uint8Array, block: number): Uint8Array {
  if (data.length > 0xffffffff) throw new Error('Payload is too large to pad');

  const withPrefix = 4 + data.length;
  const target = block > 1 ? Math.ceil(withPrefix / block) * block : withPrefix;

  const out = new Uint8Array(target);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  out.set(data, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new DecryptionError('Padded payload is truncated');

  const length =
    ((padded[0]! << 24) >>> 0) + (padded[1]! << 16) + (padded[2]! << 8) + padded[3]!;

  if (length > padded.length - 4) throw new DecryptionError('Padded payload is inconsistent');
  return padded.subarray(4, 4 + length);
}
