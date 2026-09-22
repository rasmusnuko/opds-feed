/**
 * A locator answers one question: which part of this page is the article?
 *
 * Locators run in order (see ./index.ts) and the first candidate that survives
 * sanitising and the emptiness check wins. Every locator sees the same pristine
 * document, so a locator must never mutate `ctx.doc`: clone it (or build a new
 * element) and return content it owns.
 */

export interface LocateContext {
  /** The page as parsed. Read-only: clone before changing anything. */
  doc: Document;
  /** The raw HTML the document was parsed from, for locators that need to rewrite it. */
  html: string;
  /** The URL the HTML came from, used to resolve relative links. */
  url: string;
  /** HTML of the part of the page the user selected in their browser, if they sent one. */
  selection: string | null;
}

/** Article metadata a locator can contribute alongside the body. */
export interface LocatedMeta {
  title?: string | null;
  byline?: string | null;
  publishedAt?: string | null;
  excerpt?: string | null;
  siteName?: string | null;
}

export interface Located {
  /** Detached article body. It is sanitised in place after the locator returns. */
  content: Element;
  /** Metadata that beats the page's own meta tags (e.g. an explicit site rule). */
  overrides?: LocatedMeta;
  /** Metadata used only when the page's meta tags have nothing (e.g. Readability's guesses). */
  fallbacks?: LocatedMeta;
  /** Frees any extra DOM the locator created. */
  dispose?: () => void;
}

export interface Locator {
  /** Stored on the article so a bad conversion can be traced to the step that produced it. */
  name: string;
  locate(ctx: LocateContext): Promise<Located | null> | Located | null;
}
