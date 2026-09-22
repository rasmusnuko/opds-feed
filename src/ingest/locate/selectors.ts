import { countWords } from '../../util/text.js';
import type { Locator } from './types.js';

const CANDIDATES = ['article', 'main', '[role="main"]', '#content', '.post', '.entry-content', 'body'];

/** Last resort: the first common content container with a reasonable amount of text. */
export const selectorsLocator: Locator = {
  name: 'selectors',
  locate(ctx) {
    for (const selector of CANDIDATES) {
      const element = ctx.doc.querySelector(selector);
      if (element && countWords(element.textContent ?? '') > 50) {
        return { content: element.cloneNode(true) as Element };
      }
    }
    return null;
  },
};
