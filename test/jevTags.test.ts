import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tagQuestions, tagsFromAnswers } from '../src/util/jevTags.js';

const vocab = ['tech', 'history', 'politics', 'science'];

describe('jev tagging', () => {
  it('asks one yes/no per tag', () => {
    const q = tagQuestions(vocab);
    assert.deepEqual(Object.keys(q), vocab);
    assert.equal(q.history!.type, 'noul');
  });
  it('keeps yeses above threshold, most confident first, at most three, vocabulary only', () => {
    const answers = { history: { noul: 0.97 }, politics: { noul: 0.61 }, tech: { noul: 0.2 }, science: { noul: 0.55 }, cooking: { noul: 0.99 } };
    assert.deepEqual(tagsFromAnswers(answers, vocab), ['history', 'politics', 'science']);
    assert.deepEqual(tagsFromAnswers(answers, vocab, 0.9), ['history']);
  });
  it('survives missing or malformed answers', () => {
    assert.deepEqual(tagsFromAnswers({}, vocab), []);
    assert.deepEqual(tagsFromAnswers({ history: {}, tech: { noul: undefined } } as never, vocab), []);
  });
});
