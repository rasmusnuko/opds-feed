import type { Context, MiddlewareHandler, Next } from 'hono';
import { config } from './config.js';
import { constantTimeEquals, SCRYPT_PREFIX, verifyScrypt } from './util/password.js';

export function verifyPassword(password: string): boolean {
  const { passwordHash, password: plaintext } = config.auth;
  if (passwordHash) {
    return passwordHash.startsWith(SCRYPT_PREFIX)
      ? verifyScrypt(password, passwordHash)
      : constantTimeEquals(password, passwordHash);
  }
  if (plaintext) return constantTimeEquals(password, plaintext);
  return false;
}

export function verifyCredentials(username: string, password: string): boolean {
  // Always check both halves so a wrong username costs the same as a wrong password.
  const userOk = constantTimeEquals(username, config.auth.username);
  const passOk = verifyPassword(password);
  return userOk && passOk;
}

export function verifyApiToken(token: string): boolean {
  return config.auth.apiTokens.some((candidate) => constantTimeEquals(token, candidate));
}

interface ParsedBasic {
  username: string;
  password: string;
}

function parseBasic(header: string): ParsedBasic | null {
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function parseBearer(header: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

function unauthorized(c: Context, challenge: boolean): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (challenge) {
    // OPDS clients rely on this challenge to know they should prompt for credentials.
    headers['WWW-Authenticate'] = `Basic realm="${config.auth.realm}", charset="UTF-8"`;
  }
  return c.text('Unauthorized\n', 401, headers);
}

/** HTTP Basic auth. Required on every catalogue, cover and download route. */
export const basicAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const header = c.req.header('authorization');
  if (!header) return unauthorized(c, true);
  const credentials = parseBasic(header);
  if (!credentials || !verifyCredentials(credentials.username, credentials.password)) {
    return unauthorized(c, true);
  }
  await next();
  return undefined;
};

/** Ingest auth: a bearer token from API_TOKENS, or the same Basic credentials. */
export const apiAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const header = c.req.header('authorization');
  const queryToken = c.req.query('token');

  if (queryToken && verifyApiToken(queryToken)) {
    await next();
    return undefined;
  }

  if (header) {
    const bearer = parseBearer(header);
    if (bearer && verifyApiToken(bearer)) {
      await next();
      return undefined;
    }
    const credentials = parseBasic(header);
    if (credentials && verifyCredentials(credentials.username, credentials.password)) {
      await next();
      return undefined;
    }
  }

  // No Basic challenge here: a browser popping up a password box on a failed API call is noise.
  return unauthorized(c, false);
};

/**
 * Browsers replay cached Basic credentials on cross-site requests, so a malicious page
 * could drive the ingest API through a logged-in browser. Requests that carry no Origin
 * header -- curl, phone shortcuts, anything using a bearer token -- are unaffected.
 */
export const rejectCrossOrigin: MiddlewareHandler = async (c: Context, next: Next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    await next();
    return undefined;
  }

  const origin = c.req.header('origin');
  if (origin) {
    try {
      const expected = config.publicUrlConfigured
        ? new URL(config.publicUrl).origin
        : new URL(c.req.url).origin;
      const forwardedHost = config.trustProxy ? c.req.header('x-forwarded-host') : undefined;
      const host = forwardedHost?.split(',')[0]?.trim() ?? c.req.header('host');

      const sameOrigin =
        new URL(origin).origin === expected ||
        (host !== undefined && new URL(origin).host === host);

      if (!sameOrigin) return c.json({ error: 'Cross-origin request refused' }, 403);
    } catch {
      return c.json({ error: 'Bad Origin header' }, 403);
    }
  }

  await next();
  return undefined;
};
