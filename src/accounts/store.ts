import type { Database } from 'better-sqlite3';
import type { RecoverySecrets, StoredKdf, WrappedSecrets } from '../crypto/keys.js';
import { newId } from '../util/ids.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { applyAccountSchema } from './schema.js';

// The vault's proof-of-possession hash. node:crypto scrypt, synchronous, because this
// store is synchronous throughout and is not wired into the running server yet.
// ponytail: when the vault ships, move this onto util/password.ts (argon2, async).
const AUTH_KEY_PREFIX = 'scrypt:';
const AUTH_KEY_LEN = 32;

function hashAuthKey(key: string): string {
  const salt = randomBytes(16);
  return `${AUTH_KEY_PREFIX}${salt.toString('base64')}:${scryptSync(key, salt, AUTH_KEY_LEN).toString('base64')}`;
}

function authKeyMatches(key: string, stored: string): boolean {
  if (!stored.startsWith(AUTH_KEY_PREFIX)) return false;
  const [saltPart, hashPart, extra] = stored.slice(AUTH_KEY_PREFIX.length).split(':');
  if (!saltPart || !hashPart || extra !== undefined) return false;
  const expected = Buffer.from(hashPart, 'base64');
  if (expected.length !== AUTH_KEY_LEN) return false;
  return timingSafeEqual(scryptSync(key, Buffer.from(saltPart, 'base64'), AUTH_KEY_LEN), expected);
}

export type UserStatus = 'active' | 'suspended' | 'terminated';

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
  status: UserStatus;
  kdf_json: string;
  auth_hash: string;
  wrapped_master: string;
  recovery_kdf_json: string | null;
  wrapped_master_recovery: string | null;
  recovery_used_at: string | null;
  quota_bytes: number;
  used_bytes: number;
  strikes: number;
  last_notice_at: string | null;
}

/** A user record with the key material parsed, ready to hand to `unlockWithPassphrase`. */
export interface Account {
  id: string;
  email: string;
  status: UserStatus;
  kdf: StoredKdf;
  wrappedMaster: string;
  recoveryKdf: StoredKdf | null;
  wrappedMasterRecovery: string | null;
  quotaBytes: number;
  usedBytes: number;
  strikes: number;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  keys: WrappedSecrets & Partial<RecoverySecrets>;
  quotaBytes?: number;
}

export class QuotaExceededError extends Error {
  constructor(readonly required: number, readonly available: number) {
    super('Storage quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

function normaliseEmail(email: string): string {
  const clean = email.trim().toLowerCase();
  if (clean.length === 0 || !clean.includes('@')) {
    throw new Error(`Not a valid email address: ${email}`);
  }
  return clean;
}

function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    kdf: JSON.parse(row.kdf_json) as StoredKdf,
    wrappedMaster: row.wrapped_master,
    recoveryKdf: row.recovery_kdf_json ? (JSON.parse(row.recovery_kdf_json) as StoredKdf) : null,
    wrappedMasterRecovery: row.wrapped_master_recovery,
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    strikes: row.strikes,
    createdAt: row.created_at,
  };
}

export function createAccountStore(db: Database) {
  applyAccountSchema(db);

  const nowIso = (): string => new Date().toISOString();

  const findRowByEmail = (email: string): UserRow | undefined =>
    db.prepare('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email)) as
      | UserRow
      | undefined;

  const findRowById = (id: string): UserRow | undefined =>
    db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

  return {
    create(input: CreateUserInput): Account {
      const email = normaliseEmail(input.email);
      if (findRowByEmail(email)) {
        throw new Error(`An account already exists for ${email}`);
      }

      const id = newId();
      const now = nowIso();

      db.prepare(
        `INSERT INTO users (
           id, email, created_at, updated_at, status,
           kdf_json, auth_hash, wrapped_master,
           recovery_kdf_json, wrapped_master_recovery, quota_bytes
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, COALESCE(?, 1073741824))`,
      ).run(
        id,
        email,
        now,
        now,
        JSON.stringify(input.keys.kdf),
        // The login proof is already high entropy, but hashing it means a stolen database
        // still cannot be replayed against the login endpoint.
        hashAuthKey(input.keys.authKey),
        input.keys.wrappedMaster,
        input.keys.recoveryKdf ? JSON.stringify(input.keys.recoveryKdf) : null,
        input.keys.wrappedMasterRecovery ?? null,
        input.quotaBytes ?? null,
      );

      return toAccount(findRowById(id)!);
    },

    getById(id: string): Account | undefined {
      const row = findRowById(id);
      return row ? toAccount(row) : undefined;
    },

    getByEmail(email: string): Account | undefined {
      const row = findRowByEmail(email);
      return row ? toAccount(row) : undefined;
    },

    /** KDF parameters are needed before login, to derive the proof on the client side. */
    getKdfForLogin(email: string): StoredKdf | undefined {
      const row = findRowByEmail(email);
      return row ? (JSON.parse(row.kdf_json) as StoredKdf) : undefined;
    },

    /**
     * Verifies a login proof. Returns the account only when it is also allowed to be used,
     * so a suspended account fails here rather than somewhere deeper in the request.
     */
    verifyAuthKey(email: string, authKey: string): Account | undefined {
      const row = findRowByEmail(email);
      if (!row) return undefined;

      const stored = row.auth_hash;
      const valid = authKeyMatches(authKey, stored);

      if (!valid || row.status !== 'active') return undefined;
      return toAccount(row);
    },

    /** Applies a passphrase change. The library itself is never re-encrypted. */
    updatePassphrase(id: string, secrets: WrappedSecrets): void {
      const changed = db
        .prepare(
          `UPDATE users SET kdf_json = ?, auth_hash = ?, wrapped_master = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(secrets.kdf), hashAuthKey(secrets.authKey), secrets.wrappedMaster, nowIso(), id).changes;

      if (changed === 0) throw new Error(`No such account: ${id}`);
    },

    updateRecovery(id: string, secrets: RecoverySecrets): void {
      db.prepare(
        `UPDATE users SET recovery_kdf_json = ?, wrapped_master_recovery = ?,
                          recovery_used_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(secrets.recoveryKdf), secrets.wrappedMasterRecovery, nowIso(), id);
    },

    markRecoveryUsed(id: string): void {
      db.prepare('UPDATE users SET recovery_used_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso(),
        nowIso(),
        id,
      );
    },

    setStatus(id: string, status: UserStatus): void {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    },

    /**
     * Records a substantiated notice against an account. Deliberately content-blind: it
     * counts complaints, it does not inspect anything.
     */
    addStrike(id: string): number {
      db.prepare(
        'UPDATE users SET strikes = strikes + 1, last_notice_at = ?, updated_at = ? WHERE id = ?',
      ).run(nowIso(), nowIso(), id);
      const row = findRowById(id);
      return row?.strikes ?? 0;
    },

    /**
     * Reserves quota before a write. Conditional in SQL so two concurrent uploads cannot
     * both pass the check and overshoot.
     */
    reserveStorage(id: string, bytes: number): void {
      if (bytes < 0) throw new Error('Cannot reserve a negative number of bytes');

      const changed = db
        .prepare(
          `UPDATE users SET used_bytes = used_bytes + ?, updated_at = ?
           WHERE id = ? AND used_bytes + ? <= quota_bytes`,
        )
        .run(bytes, nowIso(), id, bytes).changes;

      if (changed === 0) {
        const row = findRowById(id);
        if (!row) throw new Error(`No such account: ${id}`);
        throw new QuotaExceededError(bytes, row.quota_bytes - row.used_bytes);
      }
    },

    releaseStorage(id: string, bytes: number): void {
      db.prepare(
        `UPDATE users SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = ?`,
      ).run(Math.max(0, bytes), nowIso(), id);
    },

    setQuota(id: string, quotaBytes: number): void {
      db.prepare('UPDATE users SET quota_bytes = ?, updated_at = ? WHERE id = ?').run(
        quotaBytes,
        nowIso(),
        id,
      );
    },

    list(): Account[] {
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
      return rows.map(toAccount);
    },
  };
}

export type AccountStore = ReturnType<typeof createAccountStore>;
