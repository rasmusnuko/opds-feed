import Database from 'better-sqlite3';
import { createAccountStore } from '../accounts/store.js';
import {
  createAccountKeys,
  deriveAuthKey,
  rewrapForNewPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
} from '../crypto/keys.js';
import { DEFAULT_KDF, randomBytes } from '../crypto/primitives.js';
import { openContent, openMetadata, sealContent, sealMetadata, urlIndex } from '../crypto/vault.js';

/**
 * Walks the whole account lifecycle at the real KDF cost, so the timings below are the
 * ones a user would actually see. Run with: npm run vault-demo
 */

const PASSPHRASE = 'correct horse battery staple';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function timed<T>(label: string, work: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  const result = await work();
  line(label, `${Date.now() - started} ms`);
  return result;
}

async function main(): Promise<void> {
  const db = new Database(':memory:');
  const store = createAccountStore(db);

  process.stdout.write(`\nArgon2id: m=${DEFAULT_KDF.m / 1024} MiB, t=${DEFAULT_KDF.t}, p=${DEFAULT_KDF.p}\n\n`);

  process.stdout.write('Signup\n');
  const keys = await timed('derive + wrap keys', () => createAccountKeys(PASSPHRASE));
  const account = store.create({ email: 'reader@example.com', keys });
  line('account id', account.id);
  line('recovery code', keys.recoveryCode);

  process.stdout.write('\nWhat the server row contains\n');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(account.id) as Record<string, unknown>;
  for (const key of ['email', 'status', 'auth_hash', 'wrapped_master']) {
    line(key, String(row[key]).slice(0, 56) + (String(row[key]).length > 56 ? '…' : ''));
  }
  line('contains passphrase?', JSON.stringify(row).includes(PASSPHRASE) ? 'YES (bug!)' : 'no');

  process.stdout.write('\nLogin\n');
  const authKey = await timed('derive login proof', () => deriveAuthKey(PASSPHRASE, account.kdf));
  line('accepted', store.verifyAuthKey('reader@example.com', authKey) ? 'yes' : 'no');
  line('wrong proof accepted', store.verifyAuthKey('reader@example.com', 'nope') ? 'YES (bug!)' : 'no');

  process.stdout.write('\nStore an article\n');
  const vault = await timed('unlock vault', () =>
    unlockWithPassphrase(account.id, PASSPHRASE, account.kdf, account.wrappedMaster),
  );

  const epub = randomBytes(184_320); // a typical converted article
  const metadata = {
    title: 'The Slow Web & Its Discontents',
    url: 'https://example.com/slow-web',
    site: 'Fixture Review',
  };

  const sealedContent = await timed('seal 180 KB', () => sealContent(vault, 'article-1', epub));
  const sealedMetadata = await sealMetadata(vault, 'article-1', metadata);

  store.reserveStorage(account.id, sealedContent.byteLength);

  line('ciphertext size', `${sealedContent.byteLength} bytes (padded)`);
  line('metadata size', `${sealedMetadata.byteLength} bytes`);
  line('blind index', `${urlIndex(vault, metadata.url).slice(0, 32)}…`);
  line('title visible in blob?', Buffer.from(sealedMetadata).toString('latin1').includes('Slow') ? 'YES (bug!)' : 'no');
  line('quota used', `${store.getById(account.id)?.usedBytes} / ${account.quotaBytes} bytes`);

  process.stdout.write('\nRead it back\n');
  const content = await openContent(vault, 'article-1', sealedContent);
  line('content matches', Buffer.from(content).equals(Buffer.from(epub)) ? 'yes' : 'NO (bug!)');
  line('metadata title', (await openMetadata<typeof metadata>(vault, 'article-1', sealedMetadata)).title);

  process.stdout.write('\nChange the passphrase\n');
  const rotated = await timed('rewrap master key', () => rewrapForNewPassphrase(vault, 'a new passphrase'));
  store.updatePassphrase(account.id, rotated);
  const afterRotation = store.getById(account.id)!;
  const reopened = await unlockWithPassphrase(
    account.id,
    'a new passphrase',
    afterRotation.kdf,
    afterRotation.wrappedMaster,
  );
  const stillReadable = await openContent(reopened, 'article-1', sealedContent);
  line('articles re-encrypted', '0');
  line('old article still opens', Buffer.from(stillReadable).equals(Buffer.from(epub)) ? 'yes' : 'NO (bug!)');

  process.stdout.write('\nForgotten passphrase\n');
  const recovered = await timed('unlock via recovery code', () =>
    unlockWithRecoveryCode(
      account.id,
      keys.recoveryCode.toLowerCase(),
      account.recoveryKdf!,
      account.wrappedMasterRecovery!,
    ),
  );
  const recoveredContent = await openContent(recovered, 'article-1', sealedContent);
  line('library recovered', Buffer.from(recoveredContent).equals(Buffer.from(epub)) ? 'yes' : 'NO (bug!)');

  process.stdout.write('\nContent-blind moderation\n');
  line('strikes after notice', String(store.addStrike(account.id)));
  store.setStatus(account.id, 'suspended');
  line('suspended login', store.verifyAuthKey('reader@example.com', authKey) ? 'ACCEPTED (bug!)' : 'refused');

  process.stdout.write('\n');
  vault.destroy();
  reopened.destroy();
  recovered.destroy();
}

void main();
