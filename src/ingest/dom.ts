import { JSDOM, VirtualConsole } from 'jsdom';
import { stripControlChars } from '../util/text.js';

/** Parses untrusted HTML without running scripts. Close the window when done. */
export function parseHtml(html: string, url: string): JSDOM {
  // jsdom logs every CSS parse error from the wild web; silence it.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  return new JSDOM(stripControlChars(html), { url, virtualConsole });
}
