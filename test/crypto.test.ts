import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { createAccountStore, QuotaExceededError } from '../src/accounts/store.js';
import {
  createAccountKeys,
  deriveAuthKey,
  issueRecoveryCode,
  rewrapForNewPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
} from '../src/crypto/keys.js';
import { DEFAULT_PAD_BLOCK, decodeContainer, pad, unpad } from '../src/crypto/format.js';
import {
  DEFAULT_KDF,
  DecryptionError,
  KEY_BYTES,
  randomBytes,
  type KdfParams,
} from '../src/crypto/primitives.js';
import { generateRecoveryCode, normaliseRecoveryCode } from '../src/crypto/recovery.js';
import {
  deriveVault,
  openContent,
  openMetadata,
  sealContent,
  sealMetadata,
  urlIndex,
} from '../src/crypto/vault.js';

/** Argon2id at the real cost would make this suite take minutes. */
const FAST_KDF: KdfParams = { alg: 'argon2id', m: 8192, t: 1, p: 1 };

const PASSPHRASE = 'correct horse battery staple';

function vaultFor(userId = 'user-1') {
  return deriveVault(userId, randomBytes(KEY_BYTES));
}

describe('container format', () => {
  it('pads to a block boundary and recovers the exact bytes', () => {
    for (const size of [0, 1, 255, 4096, DEFAULT_PAD_BLOCK, DEFAULT_PAD_BLOCK + 1]) {
      const data = randomBytes(size);
      const padded = pad(data, DEFAULT_PAD_BLOCK);

      assert.equal(padded.length % DEFAULT_PAD_BLOCK, 0, `size ${size} padded to a boundary`);
      assert.ok(padded.length >= size + 4);
      assert.deepEqual(unpad(padded), data);
    }
  });

  it('rejects a foreign or truncated container', () => {
    assert.throws(() => decodeContainer(randomBytes(64)), DecryptionError);
    assert.throws(() => decodeContainer(new Uint8Array(4)), DecryptionError);
  });
});

describe('vault content', () => {
  it('round-trips content of very different sizes', async () => {
    const vault = vaultFor();
    for (const size of [0, 1, 1024, 512 * 1024]) {
      const content = randomBytes(size);
      const sealed = await sealContent(vault, 'article-1', content);
      assert.deepEqual(await openContent(vault, 'article-1', sealed), content);
    }
  });

  it('hides the exact plaintext length', async () => {
    const vault = vaultFor();
    const a = await sealContent(vault, 'a', randomBytes(100));
    const b = await sealContent(vault, 'a', randomBytes(9000));
    assert.equal(a.length, b.length, 'both fall in the same padding bucket');
  });

  it('refuses to open a blob under a different item id', async () => {
    const vault = vaultFor();
    const sealed = await sealContent(vault, 'article-1', randomBytes(128));
    await assert.rejects(() => openContent(vault, 'article-2', sealed), DecryptionError);
  });

  it('refuses to open another account’s blob', async () => {
    const mine = vaultFor('user-1');
    const theirs = vaultFor('user-2');
    const sealed = await sealContent(mine, 'article-1', randomBytes(128));
    await assert.rejects(() => openContent(theirs, 'article-1', sealed), DecryptionError);
  });

  it('detects tampering anywhere in the container', async () => {
    const vault = vaultFor();
    const sealed = await sealContent(vault, 'article-1', randomBytes(4096));

    for (const offset of [12, 20, sealed.length - 1]) {
      const tampered = Uint8Array.from(sealed);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
      await assert.rejects(() => openContent(vault, 'article-1', tampered), DecryptionError);
    }
  });
});

describe('vault metadata', () => {
  it('round-trips metadata including non-ASCII text', async () => {
    const vault = vaultFor();
    const metadata = {
      title: 'Café Résumé – an encoding test',
      url: 'https://example.com/article?x=1',
      tags: ['longread', 'test'],
      publishedAt: '2026-03-04T09:30:00.000Z',
    };

    const sealed = await sealMetadata(vault, 'article-1', metadata);
    assert.deepEqual(await openMetadata(vault, 'article-1', sealed), metadata);
  });

  it('leaks nothing recognisable about the plaintext', async () => {
    const vault = vaultFor();
    const sealed = await sealMetadata(vault, 'article-1', {
      url: 'https://example.com/a-very-distinctive-slug',
    });
    assert.ok(!Buffer.from(sealed).toString('latin1').includes('distinctive'));
  });
});

describe('blind index', () => {
  it('is deterministic within an account and unlinkable across accounts', () => {
    const url = 'https://example.com/article';
    const master = randomBytes(KEY_BYTES);

    const mine = deriveVault('user-1', Uint8Array.from(master));
    const sameVault = deriveVault('user-1', Uint8Array.from(master));
    const theirs = vaultFor('user-2');

    assert.equal(urlIndex(mine, url), urlIndex(sameVault, url), 'stable for one account');
    assert.notEqual(urlIndex(mine, url), urlIndex(theirs, url), 'not correlatable across accounts');
    assert.notEqual(urlIndex(mine, url), urlIndex(mine, `${url}?other`));
    assert.ok(!urlIndex(mine, url).includes('example'));
  });
});

describe('account keys', () => {
  it('unlocks with the right passphrase and refuses the wrong one', async () => {
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);

    const vault = await unlockWithPassphrase('user-1', PASSPHRASE, keys.kdf, keys.wrappedMaster);
    assert.equal(vault.masterKey.length, KEY_BYTES);

    await assert.rejects(
      () => unlockWithPassphrase('user-1', 'not the passphrase', keys.kdf, keys.wrappedMaster),
      DecryptionError,
    );
  });

  it('derives a login proof that cannot unwrap the vault', async () => {
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);
    const authKey = deriveAuthKey(PASSPHRASE, keys.kdf);

    assert.equal(authKey, keys.authKey, 'reproducible from the passphrase');

    // Treating the login proof as though it were the passphrase must not open anything.
    await assert.rejects(
      () => unlockWithPassphrase('user-1', authKey, keys.kdf, keys.wrappedMaster),
      DecryptionError,
    );
  });

  it('recovers with the recovery code, however the user retypes it', async () => {
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);

    const vault = await unlockWithRecoveryCode(
      'user-1',
      keys.recoveryCode,
      keys.recoveryKdf,
      keys.wrappedMasterRecovery,
    );
    assert.equal(vault.masterKey.length, KEY_BYTES);

    const mangled = keys.recoveryCode.toLowerCase().replace(/-/g, ' ');
    const again = await unlockWithRecoveryCode(
      'user-1',
      mangled,
      keys.recoveryKdf,
      keys.wrappedMasterRecovery,
    );
    assert.deepEqual(again.masterKey, vault.masterKey);
  });

  it('keeps the library readable across a passphrase change', async () => {
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);
    const vault = await unlockWithPassphrase('user-1', PASSPHRASE, keys.kdf, keys.wrappedMaster);

    const content = randomBytes(2048);
    const sealed = await sealContent(vault, 'article-1', content);

    const rotated = await rewrapForNewPassphrase(vault, 'a completely different passphrase', FAST_KDF);

    const reopened = await unlockWithPassphrase(
      'user-1',
      'a completely different passphrase',
      rotated.kdf,
      rotated.wrappedMaster,
    );

    // Same master key underneath, so nothing had to be re-encrypted.
    assert.deepEqual(await openContent(reopened, 'article-1', sealed), content);

    await assert.rejects(
      () => unlockWithPassphrase('user-1', PASSPHRASE, rotated.kdf, rotated.wrappedMaster),
      DecryptionError,
    );
  });

  it('issues a replacement recovery code for the same master key', async () => {
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);
    const vault = await unlockWithPassphrase('user-1', PASSPHRASE, keys.kdf, keys.wrappedMaster);

    const replacement = await issueRecoveryCode(vault, FAST_KDF);
    assert.notEqual(replacement.recoveryCode, keys.recoveryCode);

    const recovered = await unlockWithRecoveryCode(
      'user-1',
      replacement.recoveryCode,
      replacement.recoveryKdf,
      replacement.wrappedMasterRecovery,
    );
    assert.deepEqual(recovered.masterKey, vault.masterKey);
  });

  it('ships defaults at or above the OWASP Argon2id floor', () => {
    assert.equal(DEFAULT_KDF.alg, 'argon2id');
    assert.ok(DEFAULT_KDF.m >= 19456, 'at least 19 MiB of memory cost');
    assert.ok(DEFAULT_KDF.t >= 2, 'at least two passes');
  });
});

describe('recovery codes', () => {
  it('generates distinct, well-formed codes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRecoveryCode()));
    assert.equal(codes.size, 50, 'no collisions');

    for (const code of codes) {
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
      assert.ok(normaliseRecoveryCode(code).length >= 32);
    }
  });

  it('rejects an empty code rather than deriving from nothing', () => {
    assert.throws(() => normaliseRecoveryCode('---'), /empty/i);
  });
});

describe('account store', () => {
  const setup = async () => {
    const db = new Database(':memory:');
    const store = createAccountStore(db);
    const keys = await createAccountKeys(PASSPHRASE, FAST_KDF);
    const account = store.create({ email: ' Reader@Example.COM ', keys, quotaBytes: 1000 });
    return { db, store, keys, account };
  };

  it('normalises the email and stores no readable secret', async () => {
    const { db, store, account } = await setup();

    assert.equal(account.email, 'reader@example.com');
    assert.ok(store.getByEmail('READER@example.com'));

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(account.id) as Record<string, unknown>;
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes(PASSPHRASE), 'the passphrase is nowhere in the row');
    assert.ok(!('password' in row));
  });

  it('accepts the right login proof and rejects a wrong one', async () => {
    const { store, keys } = await setup();

    assert.ok(store.verifyAuthKey('reader@example.com', keys.authKey));
    assert.equal(store.verifyAuthKey('reader@example.com', 'wrong'), undefined);
    assert.equal(store.verifyAuthKey('nobody@example.com', keys.authKey), undefined);
  });

  it('refuses a suspended account at login', async () => {
    const { store, keys, account } = await setup();

    store.setStatus(account.id, 'suspended');
    assert.equal(store.verifyAuthKey('reader@example.com', keys.authKey), undefined);
  });

  it('survives a passphrase change without losing the account', async () => {
    const { store, account, keys } = await setup();
    const vault = await unlockWithPassphrase(account.id, PASSPHRASE, keys.kdf, keys.wrappedMaster);

    const rotated = await rewrapForNewPassphrase(vault, 'another passphrase entirely', FAST_KDF);
    store.updatePassphrase(account.id, rotated);

    assert.ok(store.verifyAuthKey('reader@example.com', rotated.authKey));
    assert.equal(store.verifyAuthKey('reader@example.com', keys.authKey), undefined);
  });

  it('enforces the storage quota', async () => {
    const { store, account } = await setup();

    store.reserveStorage(account.id, 600);
    assert.equal(store.getById(account.id)?.usedBytes, 600);

    assert.throws(() => store.reserveStorage(account.id, 500), QuotaExceededError);
    assert.equal(store.getById(account.id)?.usedBytes, 600, 'a refused write reserves nothing');

    store.releaseStorage(account.id, 600);
    assert.equal(store.getById(account.id)?.usedBytes, 0);
  });

  it('counts strikes without touching content', async () => {
    const { store, account } = await setup();

    assert.equal(store.addStrike(account.id), 1);
    assert.equal(store.addStrike(account.id), 2);
    assert.equal(store.getById(account.id)?.strikes, 2);
  });
});
