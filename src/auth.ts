import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { basicAuth as honoBasicAuth } from 'hono/basic-auth';
import { bearerAuth } from 'hono/bearer-auth';
import { timingSafeEqual } from 'hono/utils/buffer';
import { config } from './config.js';
import { findUser } from './store.js';
import { hashPassword, verifyPassword } from './util/password.js';

/**
 * Header parsing, the realm challenge, the 401s and every comparison are Hono's own
 * middleware. This file only says where users and tokens come from.
 */

/**
 * A hash of a secret nobody knows, made with the same parameters as a real one, so an
 * unknown username costs the same verify as a known one. Skipping the derivation on a
 * miss would let response time say which names exist.
 */
const ABSENT_USER_HASH = await hashPassword(randomBytes(32).toString('hex'));

/** HTTP Basic against the users table. Every catalogue, cover and download route. */
export const basicAuth: MiddlewareHandler = honoBasicAuth({
  realm: config.auth.realm,
  verifyUser: async (username, password, c) => {
    const user = findUser(username);
    const ok = await verifyPassword(password, user?.password_hash ?? ABSENT_USER_HASH);
    if (user === undefined || !ok) return false;
    c.set('user', username);
    return true;
  },
});

/** The username basicAuth accepted on this request, for routes that need it. */
export function basicUser(c: Context): string | null {
  return (c.get('user') as string | undefined) ?? null;
}

const tokenAuth: MiddlewareHandler | null =
  config.auth.apiTokens.length > 0 ? bearerAuth({ token: config.auth.apiTokens }) : null;

async function isApiToken(candidate: string): Promise<boolean> {
  for (const token of config.auth.apiTokens) {
    if (await timingSafeEqual(candidate, token)) return true;
  }
  return false;
}

/**
 * Ingest auth: a bearer token — in the header, or as ?token= for bookmarklets and
 * anything else that cannot set one — or the same Basic credentials.
 */
export const apiAuth: MiddlewareHandler = async (c, next) => {
  const query = c.req.query('token');
  if (query !== undefined && (await isApiToken(query))) return next();
  if (tokenAuth && /^bearer\s/i.test(c.req.header('authorization') ?? '')) return tokenAuth(c, next);
  return basicAuth(c, next);
};
