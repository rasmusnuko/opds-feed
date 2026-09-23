import { config } from '../config.js';
import type { ProspectRow } from '../db.js';
import { errorFields, log } from '../logger.js';
import { storeSummary, storeSummaryError } from '../prospects.js';
import { collapseWhitespace, truncate } from '../util/text.js';
import { extractArticle } from './extract.js';
import { decodeHtml, fetchUrl } from './fetch.js';

/**
 * On-demand article summaries.
 *
 * Talks to any OpenAI-compatible chat-completions endpoint: OpenRouter by default, or a
 * local Ollama / llama.cpp / vLLM server by pointing SUMMARY_ENDPOINT at it. Summarising is
 * about the most forgiving thing you can ask a model to do, so a small local model is a
 * perfectly good backend here -- switching is two environment variables, no code change.
 *
 * Summaries are produced only when the user asks for one, and cached on the prospect row.
 * Nothing is fetched speculatively.
 */

const SYSTEM_PROMPT = [
  'You help someone decide whether an article is worth reading.',
  'In two or three sentences of plain prose, say what the article covers and what its',
  'central claim or angle is. Use only what the text itself says; do not speculate or',
  'add background. No preamble, no bullet points, no markdown, no headings.',
].join(' ');

export class SummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryError';
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: unknown };
}

/** Where the text being summarised came from, for the UI to be honest about. */
export type SummarySource = 'article' | 'teaser';

export interface SummaryResult {
  summary: string;
  model: string;
  source: SummarySource;
}

export function summariesAvailable(): boolean {
  if (!config.summary.enabled) return false;
  // A hosted endpoint needs a key; a local one generally does not.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(config.summary.endpoint);
  return isLocal || Boolean(config.summary.apiKey);
}

/**
 * Pulls the article text. Falls back to the feed's own teaser when the page cannot be
 * fetched or extracted -- a summary of the teaser still beats an error message.
 */
async function sourceTextFor(prospect: ProspectRow): Promise<{ text: string; source: SummarySource }> {
  try {
    const response = await fetchUrl(prospect.url);
    const extracted = extractArticle(decodeHtml(response), response.url);
    try {
      const text = collapseWhitespace(extracted.textContent);
      if (text.length >= 200) return { text, source: 'article' };
    } finally {
      extracted.dispose();
    }
  } catch (error) {
    log.debug('summary could not read the article, falling back to the teaser', {
      url: prospect.url,
      ...errorFields(error),
    });
  }

  const teaser = collapseWhitespace(prospect.teaser ?? '');
  if (teaser.length === 0) {
    throw new SummaryError('Could not read the article, and the feed gave no description');
  }
  return { text: teaser, source: 'teaser' };
}

async function callModel(title: string, text: string): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.summary.apiKey) headers.authorization = `Bearer ${config.summary.apiKey}`;

  // OpenRouter uses these for attribution; harmless everywhere else.
  headers['http-referer'] = config.publicUrl;
  headers['x-title'] = config.catalogTitle;

  const body = {
    model: config.summary.model,
    max_tokens: config.summary.maxOutputTokens,
    temperature: config.summary.temperature,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Title: ${title}\n\nArticle:\n${text}` },
    ],
  };

  let response: Response;
  try {
    // Deliberately plain fetch, not the SSRF-guarded fetchUrl: this endpoint is set by the
    // operator, and a local model on 127.0.0.1 is a legitimate and common configuration.
    response = await fetch(`${config.summary.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.summary.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SummaryError(`Could not reach the summary model: ${reason}`);
  }

  const raw = await response.text();
  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    throw new SummaryError(`Summary model returned HTTP ${response.status} with a non-JSON body`);
  }

  if (!response.ok) {
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : `HTTP ${response.status}`;
    throw new SummaryError(`Summary model refused the request: ${message}`);
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || collapseWhitespace(content).length === 0) {
    throw new SummaryError('Summary model returned an empty response');
  }

  // Small models sometimes ignore "no preamble". Strip only a label that ends in a colon:
  // trimming a bare "Here is " would leave a sentence fragment, which is worse.
  return collapseWhitespace(content).replace(/^(?:here(?:'s| is)[^:.]{0,40}:|summary:)\s*/i, '');
}

const inFlight = new Map<string, Promise<SummaryResult>>();

/**
 * Summarises a prospect, caching the result on the row. Concurrent requests for the same
 * prospect share one call, so an impatient double-click costs one request, not two.
 */
export function summarizeProspect(prospect: ProspectRow): Promise<SummaryResult> {
  const existing = inFlight.get(prospect.id);
  if (existing) return existing;

  const work = (async (): Promise<SummaryResult> => {
    if (!config.summary.enabled) {
      throw new SummaryError('Summaries are disabled (set SUMMARY_ENABLED=true)');
    }
    if (!summariesAvailable()) {
      throw new SummaryError('Summaries need SUMMARY_API_KEY for a hosted endpoint');
    }

    const started = Date.now();
    const { text, source } = await sourceTextFor(prospect);
    const summary = truncate(
      await callModel(prospect.title, text.slice(0, config.summary.maxInputChars)),
      1200,
    );

    storeSummary(prospect.id, summary, config.summary.model);
    log.info('summarised prospect', {
      id: prospect.id,
      model: config.summary.model,
      source,
      ms: Date.now() - started,
    });

    return { summary, model: config.summary.model, source };
  })();

  inFlight.set(prospect.id, work);

  return work
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      storeSummaryError(prospect.id, message);
      throw error;
    })
    .finally(() => {
      inFlight.delete(prospect.id);
    }) as Promise<SummaryResult>;
}
