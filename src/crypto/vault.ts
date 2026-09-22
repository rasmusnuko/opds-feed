import {
  DEFAULT_PAD_BLOCK,
  decodeContainer,
  encodeContainer,
  pad,
  unpad,
} from './format.js';
import {
  KEY_BYTES,
  blindIndex,
  open,
  randomBytes,
  seal,
  subkey,
  wipe,
} from './primitives.js';

/**
 * An unlocked vault: the set of keys derived from one account's master key, held in
 * memory for as long as the holder needs them.
 *
 * Nothing here touches storage. The vault seals and opens byte strings; where those bytes
 * live, and which machine holds the vault, is the delivery model's business.
 */

const LABEL_FILE_WRAP = 'opds-feed:file-key-wrap:v1';
const LABEL_METADATA = 'opds-feed:metadata:v1';
const LABEL_INDEX = 'opds-feed:blind-index:v1';

export interface Vault {
  readonly userId: string;
  readonly masterKey: Uint8Array;
  readonly fileWrapKey: Uint8Array;
  readonly metadataKey: Uint8Array;
  readonly indexKey: Uint8Array;
  /** Best-effort zeroing of every key in this vault. */
  destroy(): void;
}

export function deriveVault(userId: string, masterKey: Uint8Array): Vault {
  if (masterKey.length !== KEY_BYTES) throw new Error('Master key must be 32 bytes');
  if (userId.length === 0) throw new Error('A vault needs a user id');

  const fileWrapKey = subkey(masterKey, LABEL_FILE_WRAP);
  const metadataKey = subkey(masterKey, LABEL_METADATA);
  const indexKey = subkey(masterKey, LABEL_INDEX);

  return {
    userId,
    masterKey,
    fileWrapKey,
    metadataKey,
    indexKey,
    destroy() {
      wipe(masterKey, fileWrapKey, metadataKey, indexKey);
    },
  };
}

function contentAad(userId: string, itemId: string): string {
  return `opds-feed:v1:content:${userId}:${itemId}`;
}

function keyWrapAad(userId: string, itemId: string): string {
  return `opds-feed:v1:content-key:${userId}:${itemId}`;
}

function metadataAad(userId: string, itemId: string): string {
  return `opds-feed:v1:metadata:${userId}:${itemId}`;
}

export interface SealOptions {
  /** Round the plaintext up to a multiple of this many bytes. 0 disables padding. */
  padBlock?: number;
}

/**
 * Envelope encryption: a fresh random key per item, wrapped by the account's file-wrap
 * key and carried inside the container.
 *
 * The indirection is what makes per-item operations cheap. Deleting one article, or later
 * sharing one with a second key, touches only that item's wrapped key; rotating the
 * passphrase touches only the wrapped master key. Neither ever re-encrypts the library.
 */
export async function sealContent(
  vault: Vault,
  itemId: string,
  content: Uint8Array,
  options: SealOptions = {},
): Promise<Uint8Array> {
  const padBlock = options.padBlock ?? DEFAULT_PAD_BLOCK;
  const contentKey = randomBytes(KEY_BYTES);

  try {
    const wrappedKey = await seal(vault.fileWrapKey, contentKey, keyWrapAad(vault.userId, itemId));
    const payload = await seal(
      contentKey,
      padBlock > 1 ? pad(content, padBlock) : pad(content, 1),
      contentAad(vault.userId, itemId),
    );

    return encodeContainer({ wrappedKey, payload, padded: true });
  } finally {
    wipe(contentKey);
  }
}

export async function openContent(
  vault: Vault,
  itemId: string,
  container: Uint8Array,
): Promise<Uint8Array> {
  const parsed = decodeContainer(container);
  const contentKey = await open(
    vault.fileWrapKey,
    parsed.wrappedKey,
    keyWrapAad(vault.userId, itemId),
  );

  try {
    const payload = await open(contentKey, parsed.payload, contentAad(vault.userId, itemId));
    return parsed.padded ? unpad(payload) : payload;
  } finally {
    wipe(contentKey);
  }
}

/**
 * Metadata is sealed directly under the account's metadata key rather than with a per-item
 * key: the blobs are small, and one fewer indirection keeps listing a library cheap.
 */
export async function sealMetadata(
  vault: Vault,
  itemId: string,
  metadata: unknown,
): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  // Metadata lengths are correlated with title and URL lengths, so pad these too.
  return seal(vault.metadataKey, pad(json, 256), metadataAad(vault.userId, itemId));
}

export async function openMetadata<T = unknown>(
  vault: Vault,
  itemId: string,
  sealed: Uint8Array,
): Promise<T> {
  const padded = await open(vault.metadataKey, sealed, metadataAad(vault.userId, itemId));
  return JSON.parse(new TextDecoder().decode(unpad(padded))) as T;
}

/**
 * Deterministic, keyed index over a normalised URL. The server stores only this, and can
 * still answer "does this account already have that article?" without learning any URL.
 */
export function urlIndex(vault: Vault, normalisedUrl: string): string {
  return blindIndex(vault.indexKey, normalisedUrl);
}
