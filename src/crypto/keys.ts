import {
  DEFAULT_KDF,
  KEY_BYTES,
  SALT_BYTES,
  type KdfParams,
  assertKdfParams,
  deriveKek,
  fromBase64,
  open,
  randomBytes,
  seal,
  subkey,
  toBase64,
  wipe,
} from './primitives.js';
import { generateRecoveryCode, normaliseRecoveryCode } from './recovery.js';
import { deriveVault, type Vault } from './vault.js';

/**
 * The key hierarchy.
 *
 *   passphrase ──Argon2id(salt)──> KEK ──HKDF──┬─> authKey   (sent to the server to log in)
 *                                              └─> wrapKey   (never leaves the holder)
 *
 *   masterKey (32 random bytes)
 *     ├─ sealed under wrapKey            ──> wrappedMaster
 *     └─ sealed under recoveryWrapKey    ──> wrappedMasterRecovery
 *
 *   masterKey ──HKDF──> file-wrap key, metadata key, blind-index key   (see vault.ts)
 *
 * Splitting authKey from wrapKey is what lets the server authenticate a user without
 * holding anything that can decrypt their library: authKey is a one-way derivation from
 * the KEK, so it proves knowledge of the passphrase but cannot be run backwards to
 * recover the KEK and unwrap the master key.
 *
 * Wrapping the master key rather than deriving content keys from the passphrase directly
 * is what makes a passphrase change cheap: only the wrapped master key is rewritten, and
 * not one stored article is re-encrypted.
 */

const LABEL_AUTH = 'opds-feed:auth:v1';
const LABEL_WRAP = 'opds-feed:wrap:v1';
const AAD_MASTER_PASSPHRASE = 'opds-feed:v1:master-key:passphrase';
const AAD_MASTER_RECOVERY = 'opds-feed:v1:master-key:recovery';

/** KDF parameters as stored beside the account, so they can be raised over time. */
export interface StoredKdf extends KdfParams {
  /** base64 */
  salt: string;
}

export interface WrappedSecrets {
  kdf: StoredKdf;
  /** base64. The server stores only a slow hash of this. */
  authKey: string;
  /** base64 */
  wrappedMaster: string;
}

export interface RecoverySecrets {
  recoveryKdf: StoredKdf;
  /** base64 */
  wrappedMasterRecovery: string;
}

export interface NewAccountKeys extends WrappedSecrets, RecoverySecrets {
  /** Displayed once at signup and never stored anywhere by us. */
  recoveryCode: string;
}

interface SplitKek {
  authKey: Uint8Array;
  wrapKey: Uint8Array;
}

function splitKek(kek: Uint8Array): SplitKek {
  return { authKey: subkey(kek, LABEL_AUTH), wrapKey: subkey(kek, LABEL_WRAP) };
}

function newSalt(params: KdfParams): StoredKdf {
  assertKdfParams(params);
  return { ...params, salt: toBase64(randomBytes(SALT_BYTES)) };
}

async function wrapMaster(
  masterKey: Uint8Array,
  secret: string,
  kdf: StoredKdf,
  aad: string,
): Promise<{ wrapped: string; authKey: Uint8Array }> {
  const kek = deriveKek(secret, fromBase64(kdf.salt), kdf);
  try {
    const { authKey, wrapKey } = splitKek(kek);
    try {
      return { wrapped: toBase64(await seal(wrapKey, masterKey, aad)), authKey };
    } finally {
      wipe(wrapKey);
    }
  } finally {
    wipe(kek);
  }
}

/**
 * Creates a brand-new account's key material. The caller stores everything except the
 * recovery code, which is shown to the user once.
 */
export async function createAccountKeys(
  passphrase: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<NewAccountKeys> {
  const masterKey = randomBytes(KEY_BYTES);
  const recoveryCode = generateRecoveryCode();

  try {
    const kdf = newSalt(params);
    const recoveryKdf = newSalt(params);

    const passphraseWrap = await wrapMaster(masterKey, passphrase, kdf, AAD_MASTER_PASSPHRASE);
    const recoveryWrap = await wrapMaster(
      masterKey,
      normaliseRecoveryCode(recoveryCode),
      recoveryKdf,
      AAD_MASTER_RECOVERY,
    );

    try {
      return {
        kdf,
        authKey: toBase64(passphraseWrap.authKey),
        wrappedMaster: passphraseWrap.wrapped,
        recoveryKdf,
        wrappedMasterRecovery: recoveryWrap.wrapped,
        recoveryCode,
      };
    } finally {
      wipe(passphraseWrap.authKey, recoveryWrap.authKey);
    }
  } finally {
    wipe(masterKey);
  }
}

/**
 * Derives only the login proof. Use this to check credentials without unwrapping
 * anything -- the caller never holds a key that could open the vault.
 */
export function deriveAuthKey(passphrase: string, kdf: StoredKdf): string {
  const kek = deriveKek(passphrase, fromBase64(kdf.salt), kdf);
  try {
    const { authKey, wrapKey } = splitKek(kek);
    wipe(wrapKey);
    try {
      return toBase64(authKey);
    } finally {
      wipe(authKey);
    }
  } finally {
    wipe(kek);
  }
}

async function unlockWith(
  userId: string,
  secret: string,
  kdf: StoredKdf,
  wrapped: string,
  aad: string,
): Promise<Vault> {
  const kek = deriveKek(secret, fromBase64(kdf.salt), kdf);
  try {
    const { authKey, wrapKey } = splitKek(kek);
    wipe(authKey);
    try {
      // Throws DecryptionError on a wrong passphrase; nothing distinguishes that from a
      // tampered wrapped key, which is what we want.
      const masterKey = await open(wrapKey, fromBase64(wrapped), aad);
      return deriveVault(userId, masterKey);
    } finally {
      wipe(wrapKey);
    }
  } finally {
    wipe(kek);
  }
}

export function unlockWithPassphrase(
  userId: string,
  passphrase: string,
  kdf: StoredKdf,
  wrappedMaster: string,
): Promise<Vault> {
  return unlockWith(userId, passphrase, kdf, wrappedMaster, AAD_MASTER_PASSPHRASE);
}

export function unlockWithRecoveryCode(
  userId: string,
  recoveryCode: string,
  recoveryKdf: StoredKdf,
  wrappedMasterRecovery: string,
): Promise<Vault> {
  return unlockWith(
    userId,
    normaliseRecoveryCode(recoveryCode),
    recoveryKdf,
    wrappedMasterRecovery,
    AAD_MASTER_RECOVERY,
  );
}

/**
 * Rewraps the existing master key under a new passphrase. The library is untouched, so
 * this is instant no matter how many articles the account holds.
 *
 * It also takes fresh KDF parameters, which is how an account picks up a stronger cost
 * setting later without any migration.
 */
export async function rewrapForNewPassphrase(
  vault: Vault,
  newPassphrase: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<WrappedSecrets> {
  const kdf = newSalt(params);
  const wrap = await wrapMaster(vault.masterKey, newPassphrase, kdf, AAD_MASTER_PASSPHRASE);

  try {
    return { kdf, authKey: toBase64(wrap.authKey), wrappedMaster: wrap.wrapped };
  } finally {
    wipe(wrap.authKey);
  }
}

/** Issues a replacement recovery code, invalidating the previous one once stored. */
export async function issueRecoveryCode(
  vault: Vault,
  params: KdfParams = DEFAULT_KDF,
): Promise<RecoverySecrets & { recoveryCode: string }> {
  const recoveryCode = generateRecoveryCode();
  const recoveryKdf = newSalt(params);
  const wrap = await wrapMaster(
    vault.masterKey,
    normaliseRecoveryCode(recoveryCode),
    recoveryKdf,
    AAD_MASTER_RECOVERY,
  );

  try {
    return { recoveryKdf, wrappedMasterRecovery: wrap.wrapped, recoveryCode };
  } finally {
    wipe(wrap.authKey);
  }
}
