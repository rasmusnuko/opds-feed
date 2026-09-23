import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitTags } from '../src/util/text.js';

describe('splitTags', () => {
  it('splits on space, comma and semicolon, lowercases, dedupes', () => {
    assert.deepEqual(splitTags('HN, longread;science tech  hn'), ['hn', 'longread', 'science', 'tech']);
  });
  it('accepts arrays and ignores junk', () => {
    assert.deepEqual(splitTags(['a b', 'c', 3, null]), ['a', 'b', 'c']);
    assert.deepEqual(splitTags(undefined), []);
    assert.deepEqual(splitTags(' , ; '), []);
  });
});
