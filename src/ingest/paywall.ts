/**
 * Flags an article that arrived as a paywall stub instead of the piece itself.
 *
 * Three signals, each enough on its own except the weakest:
 *  - structured: schema.org `isAccessibleForFree: false`, which the big publishers set;
 *  - text: a subscribe-to-continue sentence *in the extracted article text*, where site
 *    chrome has already been stripped, so a "Subscribe" button in the header cannot match;
 *  - markup: a paywall element in the raw HTML. Free articles on paywalled sites often
 *    ship that element too, dormant, so this one only counts when the body is short.
 *
 * Pure: no config, no network, so it is tested with fixtures.
 */
const STRUCTURED = /"isAccessibleForFree"\s*:\s*(false|"false")|isAccessibleForFree\s*=\s*"?false/i;
const MARKUP = /(?:class|id)="[^"]*paywall[^"]*"/i;

// Sentences a stub ends with, not words a real article might contain. Kept short and
// specific on purpose: a false flag on a readable article is worse than a missed stub.
const TEXT: RegExp[] = [
  /\b(subscribe|sign in|log in|register|create (a )?free account) to (continue|keep) reading\b/i,
  /\bto continue reading\b.{0,40}\b(subscribe|sign in|log in)\b/i,
  /\bthis (post|article|story) is (only )?for (paid|paying|premium) (subscribers|members)\b/i,
  /\b(available|exclusively) (to|for) (paid|paying|premium) (subscribers|members)\b/i,
  /\balready a (paid )?(subscriber|member)\?/i,
  /\bunlock (this|the full) (article|story)\b/i,
  // Danish — Ingeniøren/Version2/radar.dk, Politiken, Berlingske, Zetland
  /\bdit medlemskab giver adgang\b/i,
  /\bfortsæt med mitida\b/i,
  /\b(bliv|som) abonnent (for at|og) (læse|få adgang)\b/i,
  /\blog ind for at læse\b/i,
  /\bkun for abonnenter\b/i,
  /\blæs (hele|resten af) artiklen (som|med) (abonnent|et abonnement)\b/i,
  // Swedish / German / Norwegian, the common shapes
  /\b(bara|endast) för prenumeranter\b/i,
  /\b(nur|exklusiv) für abonnenten\b/i,
  /\bkun for abonnenter\b/i,
];

/** Below this many words a paywall element in the page is taken at its word. */
const SHORT_BODY_WORDS = 500;

export interface PaywallVerdict {
  /** null when nothing suggests a paywall */
  reason: string | null;
}

export function detectPaywall(html: string, text: string, wordCount: number): PaywallVerdict {
  if (STRUCTURED.test(html)) return { reason: 'page declares isAccessibleForFree: false' };
  for (const re of TEXT) {
    const m = re.exec(text);
    if (m) return { reason: `“${m[0].slice(0, 60)}”` };
  }
  if (wordCount < SHORT_BODY_WORDS && MARKUP.test(html)) {
    return { reason: `paywall element in the page and only ${wordCount} words extracted` };
  }
  return { reason: null };
}
