import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { parseHttpUrl } from '../util/url.js';

export class FetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FetchError';
  }
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr(address: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw!, 10);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(range!) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, including cloud metadata at 169.254.169.254
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    return BLOCKED_V4.some((cidr) => inCidr(address, cidr));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped addresses (::ffff:10.0.0.1) must be judged by their IPv4 half.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped && mapped[1]) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    return false;
  }
  return true;
}

/**
 * Ingest fetches URLs that anyone with an API token can supply, so a target resolving to
 * a private address would turn this service into an SSRF proxy for the host network.
 * We re-check on every redirect hop. (A DNS rebind between this check and the socket
 * connect is still theoretically possible; keep the ingest API token private.)
 */
async function assertPublicHost(rawHostname: string): Promise<void> {
  if (config.fetch.allowPrivateAddresses) return;

  // URL.hostname keeps the brackets around an IPv6 literal; net.isIP does not want them.
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  if (net.isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new FetchError(`Refusing to fetch a private address: ${hostname}`);
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FetchError(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new FetchError(`Could not resolve host: ${hostname}`);
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new FetchError(`Refusing to fetch ${hostname}: resolves to private address ${entry.address}`);
    }
  }
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export interface FetchOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  referer?: string;
}

const MAX_REDIRECTS = 6;

export async function fetchUrl(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = options.maxBytes ?? config.fetch.maxBytes;
  const timeoutMs = options.timeoutMs ?? config.fetch.timeoutMs;

  let current = parseHttpUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current.hostname);

    const headers: Record<string, string> = {
      'user-agent': config.fetch.userAgent,
      accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en;q=0.9,*;q=0.5',
    };
    if (options.referer) headers.referer = options.referer;

    let response: Response;
    try {
      response = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new FetchError(`Request to ${current.hostname} failed: ${reason}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new FetchError(`Redirect from ${current.href} had no Location header`, response.status);
      }
      await response.body?.cancel();
      current = new URL(location, current);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new FetchError(`Redirect to unsupported scheme: ${current.protocol}`);
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new FetchError(`${current.hostname} returned HTTP ${response.status}`, response.status);
    }

    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new FetchError(`Response is ${declaredLength} bytes, over the ${maxBytes} byte limit`);
    }

    const body = await readCapped(response, maxBytes);

    return {
      url: current.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body,
    };
  }

  throw new FetchError(`Too many redirects starting at ${input}`);
}

/** Content-Length lies often enough that the stream itself has to enforce the cap. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new FetchError(`Response exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export function decodeHtml(result: FetchResult): string {
  const charsetMatch = /charset=["']?([\w-]+)/i.exec(result.contentType);
  const declared = charsetMatch?.[1]?.toLowerCase();

  const decodeWith = (label: string): string | null => {
    try {
      return new TextDecoder(label, { fatal: false }).decode(result.body);
    } catch {
      return null;
    }
  };

  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    const decoded = decodeWith(declared);
    if (decoded !== null) return decoded;
  }

  const utf8 = result.body.toString('utf8');

  // No HTTP charset: fall back to a <meta charset> declaration in the markup itself.
  if (!declared) {
    const metaMatch = /<meta[^>]+charset=["']?([\w-]+)/i.exec(utf8.slice(0, 4096));
    const metaCharset = metaMatch?.[1]?.toLowerCase();
    if (metaCharset && metaCharset !== 'utf-8' && metaCharset !== 'utf8') {
      const decoded = decodeWith(metaCharset);
      if (decoded !== null) return decoded;
    }
  }

  return utf8;
}
