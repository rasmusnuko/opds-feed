import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickTags } from '../src/util/tags.js';

const vocab = ['tech', 'politics', 'longread'];

describe('pickTags', () => {
  it('keeps only vocabulary tags, lowercased, deduped, at most three', () => {
    assert.deepEqual(pickTags('["Tech", "tech", "cooking", "politics", "longread", "tech"]', vocab), ['tech', 'politics', 'longread']);
  });
  it('tolerates prose and fences around the array', () => {
    assert.deepEqual(pickTags('Sure! ```json\n["longread"]\n```', vocab), ['longread']);
    assert.deepEqual(pickTags('{"tags":["tech"]}', vocab), ['tech']);
  });
  it('returns nothing for garbage, non-arrays, or an empty pick', () => {
    for (const raw of ['', 'no json here', '{"tag":"tech"}', '[]', '[1, null]']) {
      assert.deepEqual(pickTags(raw, vocab), [], JSON.stringify(raw));
    }
  });
});
