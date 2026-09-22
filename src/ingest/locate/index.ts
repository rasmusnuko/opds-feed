import { readabilityLocator } from './readability.js';
import { selectionLocator } from './selection.js';
import { selectorsLocator } from './selectors.js';
import { siteRulesLocator } from './siteRules.js';
import { ensembleLocator, llmLocator } from './stubs.js';
import type { Locator } from './types.js';

export type { Located, LocatedMeta, LocateContext, Locator } from './types.js';

/**
 * Where the article body comes from, tried in order until one produces non-empty content.
 * (Step 8 has a second half before this chain: a page the user's browser sent is used
 * instead of fetching; see pipeline.ts.) Numbers refer to docs/article-extraction-options.md.
 */
export const LOCATORS: readonly Locator[] = [
  selectionLocator, // 8. the user highlighted the article in their browser
  siteRulesLocator, // 1. a hand-written rule for this host
  readabilityLocator, // 4. general-purpose content scoring
  ensembleLocator, // 4. (stub) several extractors, best candidate wins
  llmLocator, // 7. (stub) ask an LLM for a selector, save it as a site rule
  selectorsLocator, // last resort: common content containers
];
