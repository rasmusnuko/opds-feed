const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_/i,
  /^hsa_/i,
  /^vero_/i,
  /^_hs/i,
];

const TRACKING_PARAMS = new Set(
  [
    'fbclid',
    'gclid',
    'dclid',
    'gbraid',
    'wbraid',
    'msclkid',
    'igshid',
    'igsh',
    'mkt_tok',
    'ref',
    'ref_src',
    'ref_url',
    'referrer',
    'source',
    'cmpid',
    'campaign_id',
    'spm',
    'sh',
    's_cid',
    'twclid',
    'yclid',
  ].map((name) => name.toLowerCase()),
);

export function parseHttpUrl(input: string): URL {
  let candidate = input.trim();
  if (candidate.length === 0) {
    throw new Error('URL is empty');
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  return url;
}

function stripTrackingParams(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || TRACKING_PARAM_PATTERNS.some((re) => re.test(lower))) {
      url.searchParams.delete(key);
    }
  }
}

/** Human-facing URL: tracking junk removed, everything else preserved. */
export function cleanUrl(input: string): string {
  const url = parseHttpUrl(input);
  stripTrackingParams(url);
  url.hash = '';
  return url.toString();
}

/**
 * Aggressive normalisation used only as a dedupe key, so that the same article submitted
 * twice with different casing, tracking params or a trailing slash lands on one row.
 */
export function urlKey(input: string): string {
  const url = parseHttpUrl(input);
  stripTrackingParams(url);
  url.hash = '';
  url.username = '';
  url.password = '';
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.port === '80' || url.port === '443') url.port = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

export function hostLabel(input: string): string | null {
  try {
    return parseHttpUrl(input).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
