import type { Database } from 'better-sqlite3';

/**
 * Accounts for the encrypted vault.
 *
 * Note what is deliberately absent: there is no password column, no key column, and no
 * way for an operator to reset a passphrase. The server holds a slow hash of the login
 * proof and the user's master key sealed under keys it never sees. Everything it can
 * read about an account is operational -- who, when, how much, and whether they are still
 * allowed to use the service.
 *
 * `status` and `strikes` exist because a service that cannot read its users' content
 * still has to be able to act on a valid complaint. Suspending an account and deleting an
 * item by id are both content-blind operations, and being able to perform them is what
 * keeps the hosting liability exemption available.
 */
export function applyAccountSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- active | suspended | terminated
  status TEXT NOT NULL DEFAULT 'active',

  -- Argon2id parameters and salt for the passphrase, as JSON.
  kdf_json TEXT NOT NULL,
  -- Slow hash of the derived login proof. Cannot unwrap anything.
  auth_hash TEXT NOT NULL,
  -- Master key sealed under the passphrase-derived wrap key.
  wrapped_master TEXT NOT NULL,

  -- Second copy of the master key, sealed under the recovery code.
  recovery_kdf_json TEXT,
  wrapped_master_recovery TEXT,
  recovery_used_at TEXT,

  quota_bytes INTEGER NOT NULL DEFAULT 1073741824,
  used_bytes INTEGER NOT NULL DEFAULT 0,

  -- Repeat-infringer counter. Content-blind: incremented on a substantiated notice.
  strikes INTEGER NOT NULL DEFAULT 0,
  last_notice_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
`);
}
