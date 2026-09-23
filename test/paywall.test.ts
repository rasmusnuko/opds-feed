import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectPaywall } from '../src/ingest/paywall.js';

const longBody = 'word '.repeat(900);

describe('detectPaywall', () => {
  it('trusts the schema.org declaration', () => {
    assert.match(detectPaywall('<script type="application/ld+json">{"isAccessibleForFree": false}</script>', longBody, 900).reason!, /isAccessibleForFree/);
    assert.equal(detectPaywall('{"isAccessibleForFree": true}', longBody, 900).reason, null);
  });
  it('catches the sentence a stub ends with, in English and Danish', () => {
    assert.ok(detectPaywall('', 'Some intro... Subscribe to continue reading.', 60).reason);
    assert.ok(detectPaywall('', 'This post is for paid subscribers.', 60).reason);
    assert.ok(detectPaywall('', 'Til gengæld er der ingen... Dit medlemskab giver adgang Som medlem af IDA', 134).reason);
  });
  it('takes a paywall element at its word only when the body is short', () => {
    const html = '<div class="plus-paywall-form">';
    assert.ok(detectPaywall(html, 'short stub', 120).reason);
    assert.equal(detectPaywall(html, longBody, 900).reason, null, 'a full article on a paywalled site is not a stub');
  });
  it('does not flag an ordinary article that merely mentions subscribing', () => {
    assert.equal(detectPaywall('<a>Subscribe</a>', 'You can subscribe to our newsletter at the bottom. ' + longBody, 950).reason, null);
  });
});
