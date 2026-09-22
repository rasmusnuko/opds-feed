import { config } from '../config.js';
import { errorFields, log } from '../logger.js';
import { claimNextPending, incrementAttempts, markFailed, requeueInterrupted } from '../store.js';
import { processArticle } from './pipeline.js';

const POLL_INTERVAL_MS = 15_000;

let active = 0;
let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function runOne(): Promise<boolean> {
  const article = claimNextPending(config.queue.maxAttempts);
  if (!article) return false;

  active += 1;
  try {
    const attempts = incrementAttempts(article.id);
    try {
      await processArticle(article);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attempts >= config.queue.maxAttempts;
      const nextAttemptAt = exhausted
        ? null
        : new Date(Date.now() + config.queue.retryDelayMs * attempts).toISOString();
      markFailed(article.id, message, nextAttemptAt);
      log.warn('article failed', {
        id: article.id,
        url: article.url,
        attempt: attempts,
        willRetry: !exhausted,
        ...errorFields(error),
      });
    }
  } finally {
    active -= 1;
  }
  return true;
}

/** Fills every free worker slot, then returns. Safe to call as often as you like. */
export function tick(): void {
  if (stopped) return;
  while (active < config.queue.concurrency) {
    const before = active;
    void runOne()
      .then((claimed) => {
        // A claimed job frees its slot asynchronously; keep the pump primed either way.
        if (claimed) tick();
      })
      .catch((error: unknown) => {
        // runOne handles article failures itself; reaching here means the store or the
        // filesystem misbehaved, which must not take the process down.
        log.error('queue worker crashed', errorFields(error));
      });
    // runOne increments `active` synchronously only when it claims work; if nothing was
    // claimed we would otherwise spin forever inside this loop.
    if (active === before) break;
  }
}

export function startQueue(): void {
  stopped = false;
  const requeued = requeueInterrupted();
  if (requeued > 0) log.info('requeued interrupted articles', { count: requeued });

  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  tick();
}

export function stopQueue(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function queueDepth(): number {
  return active;
}
