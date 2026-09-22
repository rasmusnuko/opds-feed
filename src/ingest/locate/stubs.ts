import type { Locator } from './types.js';

/*
 * Fallback steps that are planned but not built yet. They sit in the chain (./index.ts)
 * so the intended order is visible; each returns null and the chain moves on.
 * See docs/article-extraction-options.md for the reasoning behind each one.
 */

/**
 * Step 4, extended: run several extractors (Readability, defuddle, @postlight/parser,
 * @extractus/article-extractor) and keep the best candidate by word count, link density,
 * text-to-markup ratio, overlap with JSON-LD `articleBody` / og:description, and whether
 * it contains the headline. Once built, this replaces `readabilityLocator` in the chain.
 */
export const ensembleLocator: Locator = {
  name: 'ensemble',
  locate() {
    return null;
  },
};

/**
 * Step 7: send a pruned DOM outline (tag, id, class, word count and link density per
 * node; no text) to an LLM and ask for a body selector plus selectors to strip. Validate
 * the answer (it matches, it has enough text, it contains the headline) and save it as a
 * site rule in the first SITE_RULES_DIRS directory, so the next article from that host is
 * handled by `siteRulesLocator` without another call.
 */
export const llmLocator: Locator = {
  name: 'llm',
  locate() {
    return null;
  },
};
