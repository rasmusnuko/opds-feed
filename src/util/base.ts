import type { Context } from 'hono';
import { config } from '../config.js';

/**
 * Absolute base URL for generated links. PUBLIC_URL wins when set; otherwise we trust the
 * reverse proxy headers, falling back to the request itself.
 */
export function resolveBase(c: Context): string {
  if (config.publicUrlConfigured) return config.publicUrl;

  const requestUrl = new URL(c.req.url);
  const forwardedProto = config.trustProxy ? c.req.header('x-forwarded-proto') : undefined;
  const forwardedHost = config.trustProxy ? c.req.header('x-forwarded-host') : undefined;

  const protocol = forwardedProto?.split(',')[0]?.trim() || requestUrl.protocol.replace(':', '');
  const host = forwardedHost?.split(',')[0]?.trim() || c.req.header('host') || requestUrl.host;

  return `${protocol}://${host}`;
}

export function parsePage(value: string | undefined): number {
  const page = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}
