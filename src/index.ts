import './env.js';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiAuth, basicAuth } from './auth.js';
import { config } from './config.js';
import { startFeedPoller, stopFeedPoller } from './ingest/rss.js';
import { startQueue, stopQueue } from './ingest/queue.js';
import { errorFields, log } from './logger.js';
import { opdsRoutes } from './opds/routes.js';
import { countUsers, seedUsersFromEnv } from './store.js';
import { apiRoutes } from './routes/api.js';
import { fileRoutes } from './routes/files.js';
import { webRoutes } from './web/routes.js';

// Credentials live in the database so the Users page can change them. The environment
// fills the table only when it is empty, which is what lets a fresh deployment in.
await seedUsersFromEnv();
if (countUsers() === 0) {
  throw new Error(
    'No accounts exist. Set OPDS_USERNAME and OPDS_PASSWORD so the first one can be created.',
  );
}

const app = new Hono();

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  log.debug('request', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: Date.now() - started,
  });
});

// Unauthenticated: lets a reverse proxy or container runtime probe the service.
app.get('/healthz', (c) => c.json({ ok: true }));

app.onError((error, c) => {
  // Hono's auth and csrf middleware refuse a request by throwing; those carry their own
  // status and headers (the Basic challenge lives there) and are not internal errors.
  if (error instanceof HTTPException) return error.getResponse();
  log.error('unhandled request error', { path: new URL(c.req.url).pathname, ...errorFields(error) });
  return c.text('Internal error\n', 500);
});

// Ingest API: bearer token or Basic.
app.use('/api/*', apiAuth);
app.route('/api', apiRoutes);

// Everything a reader touches is behind HTTP Basic.
app.use('/opds/*', basicAuth);
app.use('/opds', basicAuth);
app.use('/download/*', basicAuth);
app.use('/covers/*', basicAuth);
app.route('/opds', opdsRoutes);
app.route('/', fileRoutes);

// The browser UI shares the same credentials.
app.use('*', basicAuth);
app.route('/', webRoutes);

startQueue();
startFeedPoller();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info('opds-feed listening', {
    address: `http://${config.host}:${info.port}`,
    catalog: `${config.publicUrl}/opds`,
    dataDir: config.dataDir,
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  stopFeedPoller();
  stopQueue();
  server.close(() => process.exit(0));
  // Don't let an in-flight conversion hold the process open forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
