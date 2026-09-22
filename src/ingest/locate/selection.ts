import type { Locator } from './types.js';

/**
 * Step 8: the user highlighted the article in their own browser and the bookmarklet
 * sent the selection along. Nothing we could guess beats that.
 */
export const selectionLocator: Locator = {
  name: 'selection',
  locate(ctx) {
    if (!ctx.selection) return null;
    // Created in the page's document but never attached, so the document itself is untouched.
    const holder = ctx.doc.createElement('div');
    holder.innerHTML = ctx.selection;
    return { content: holder };
  },
};
