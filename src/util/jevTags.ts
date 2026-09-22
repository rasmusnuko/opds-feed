// Pure: builds the question set for a decision model and reads its answers.
// No config, no network, so it is testable without either.
import { MAX_TAGS } from './tags.js';

export interface JevQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface JevAnswer {
  noul?: number;
  confidence?: number;
}

/** One yes/no question per tag. Decomposed rather than one multi-way choice: a tag is not exclusive. */
export function tagQuestions(vocabulary: string[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const tag of vocabulary) {
    out[tag] = {
      type: 'noul',
      instructions: `The article belongs under the tag "${tag}".`,
      criteria: {
        true: `The article is substantially about ${tag}; a reader browsing a "${tag}" shelf would expect it there.`,
        false: `The article is not about ${tag}, or mentions it only in passing.`,
      },
    };
  }
  return out;
}

/** Tags the model said yes to, most confident first, capped like the chat path. */
export function tagsFromAnswers(answers: Record<string, JevAnswer>, vocabulary: string[], threshold = 0.5): string[] {
  const allowed = new Set(vocabulary);
  return Object.entries(answers)
    .filter(([tag, a]) => allowed.has(tag) && typeof a?.noul === 'number' && a.noul >= threshold)
    .sort((x, y) => (y[1].noul ?? 0) - (x[1].noul ?? 0))
    .slice(0, MAX_TAGS)
    .map(([tag]) => tag);
}
