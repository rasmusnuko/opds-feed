// Pure: no config, no database, so it can be tested without either.
export const MAX_TAGS = 3;

/**
 * Picks the tags out of whatever the model said. Lenient on the wrapper — some
 * models fence the JSON, some prefix a sentence — strict on the content: only tags
 * that are in the vocabulary survive, so a hallucinated tag can never reach the
 * catalogue.
 */
export function pickTags(raw: string, vocabulary: string[]): string[] {
  const match = /\[[\s\S]*?\]/.exec(raw);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set(vocabulary);
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase();
    if (allowed.has(tag) && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
