import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/util/password.js';

describe('passwords', () => {
  it('round-trips through argon2id and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse');
    assert.ok(stored.startsWith('$argon2id$'), 'the library owns the format');
    assert.equal(await verifyPassword('correct horse', stored), true);
    assert.equal(await verifyPassword('correct hors', stored), false);
  });

  it('never throws on a corrupt stored value', async () => {
    for (const bad of ['', 'scrypt:abc:def', '$argon2id$garbage', 'plaintext']) {
      assert.equal(await verifyPassword('anything', bad), false, JSON.stringify(bad));
    }
  });

  it('two hashes of one password differ (salted)', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });
});
