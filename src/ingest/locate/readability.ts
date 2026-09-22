import { Readability } from '@mozilla/readability';
import type { Locator } from './types.js';

/** Step 4: Mozilla Readability's content scoring, the same code as Firefox Reader View. */
export const readabilityLocator: Locator = {
  name: 'readability',
  locate(ctx) {
    // Readability rewrites the document it is given.
    const doc = ctx.doc.cloneNode(true) as Document;

    let parsed: ReturnType<Readability['parse']> = null;
    try {
      parsed = new Readability(doc, { charThreshold: 250 }).parse();
    } catch {
      parsed = null;
    }
    if (!parsed?.content) return null;

    const holder = doc.createElement('div');
    holder.innerHTML = parsed.content;
    // Readability wraps everything in <div id="readability-page-1">; unwrap it.
    const content = holder.querySelector('#readability-page-1') ?? holder;

    return {
      content,
      fallbacks: {
        title: parsed.title,
        byline: parsed.byline,
        excerpt: parsed.excerpt,
        siteName: parsed.siteName,
      },
    };
  },
};
