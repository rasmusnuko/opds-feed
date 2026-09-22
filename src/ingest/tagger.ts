import { config } from '../config.js';
import { errorFields, log } from '../logger.js';
import { addTags, getTagVocabulary } from '../store.js';
import { MAX_TAGS, pickTags } from '../util/tags.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_CHARS = 4000;

export interface TaggableArticle {
  id: string;
  title: string;
  site: string | null;
  excerpt: string | null;
  text: string;
}

/**
 * Asks the model to file one article under the site's own tags. Never throws:
 * tagging is a nicety layered on a conversion that has already succeeded, and a
 * model outage must not turn a ready article into a failed one.
 */
export async function tagArticle(article: TaggableArticle): Promise<string[]> {
  const apiKey = config.openrouter.apiKey;
  if (!apiKey) return [];
  const vocabulary = getTagVocabulary();
  if (vocabulary.length === 0) return [];

  const prompt =
    `Choose up to ${MAX_TAGS} tags for this article from the list below. ` +
    `Use only tags from the list, exactly as written. Reply with a JSON array of strings and nothing else. ` +
    `Reply [] if none fit.\n\n` +
    `Tags: ${JSON.stringify(vocabulary)}\n\n` +
    `Title: ${article.title}\n` +
    (article.site ? `Site: ${article.site}\n` : '') +
    (article.excerpt ? `Summary: ${article.excerpt}\n` : '') +
    `\n${article.text.slice(0, TEXT_CHARS)}`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.publicUrl,
        'X-Title': 'opds-feed',
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        temperature: 0,
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      log.warn('tagging: openrouter refused', { id: article.id, status: response.status, body: (await response.text()).slice(0, 200) });
      return [];
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const tags = pickTags(data.choices?.[0]?.message?.content ?? '', vocabulary);
    addTags(article.id, tags);
    log.info('tagged', { id: article.id, tags, model: config.openrouter.model });
    return tags;
  } catch (error) {
    log.warn('tagging failed', { id: article.id, ...errorFields(error) });
    return [];
  }
}
