import './env.js';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { apiAuth, basicAuth, rejectCrossOrigin } from './auth.js';
import { config } from './config.js';
import { startFeedPoller, stopFeedPoller } from './ingest/rss.js';
import { startQueue, stopQueue } from './ingest/queue.js';
import { errorFields, log } from './logger.js';
import { opdsRoutes } from './opds/routes.js';
import { apiRoutes } from './routes/api.js';
import { fileRoutes } from './routes/files.js';
import { webRoutes } from './web/routes.js';

if (!config.auth.password && !config.auth.passwordHash) {
  throw new Error(
    'Set OPDS_PASSWORD_HASH (recommended, see `npm run hash-password`) or OPDS_PASSWORD before starting.',
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
  log.error('unhandled request error', { path: new URL(c.req.url).pathname, ...errorFields(error) });
  return c.text('Internal error\n', 500);
});

// Ingest API: bearer token or Basic.
app.use('/api/*', rejectCrossOrigin);
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
