import './setup.js';

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { db, nowIso, type ProspectRow } from '../src/db.js';
import { parseFeed } from '../src/ingest/rss.js';
import { summarizeProspect } from '../src/ingest/summarize.js';
import {
  addProspect,
  countProspects,
  expireOldProspects,
  getProspect,
  isUndoable,
  listProspects,
  setStatus,
  skipMany,
} from '../src/prospects.js';
import { addFeed } from '../src/store.js';
import { decodeEntities, stripHtml } from '../src/util/text.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Fixture</title>
<item>
  <title>The Slow Web</title>
  <link>https://example.com/slow-web</link>
  <guid>fixture-1</guid>
  <pubDate>Wed, 04 Mar 2026 09:30:00 GMT</pubDate>
  <dc:creator>A. Writer</dc:creator>
  <description>&lt;p&gt;A teaser with &lt;b&gt;markup&lt;/b&gt; and an &amp;amp; entity.&lt;/p&gt;</description>
  <content:encoded><![CDATA[<p>The full body, which is longer than the description and should win.</p>]]></content:encoded>
</item></channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Fixture Atom</title>
<entry>
  <title>Another Piece</title>
  <link rel="alternate" href="https://example.com/another"/>
  <id>urn:uuid:123</id>
  <published>2026-03-04T09:30:00Z</published>
  <author><name>B. Author</name></author>
  <summary>A short Atom summary.</summary>
</entry></feed>`;

describe('html helpers', () => {
  it('decodes the entities feeds actually use', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#8217;d&#8217; &hellip;'), 'a & b <c> ’d’ …');
    assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
  });

  it('flattens markup to plain text', () => {
    assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One Two');
    assert.equal(stripHtml('<script>evil()</script>Safe'), 'Safe');
    assert.equal(stripHtml('a<br/>b'), 'a b');
  });
});

describe('feed parsing', () => {
  it('lifts the teaser, author and date out of RSS', () => {
    const item = parseFeed(RSS).items[0]!;
    assert.equal(item.title, 'The Slow Web');
    assert.equal(item.author, 'A. Writer');
    assert.equal(item.publishedAt, '2026-03-04T09:30:00.000Z');
    // content:encoded is richer than description, so it wins.
    assert.match(item.teaser!, /full body/);
    assert.ok(!item.teaser!.includes('<'), 'markup is stripped');
  });

  it('lifts the same fields out of Atom', () => {
    const item = parseFeed(ATOM).items[0]!;
    assert.equal(item.title, 'Another Piece');
    assert.equal(item.author, 'B. Author');
    assert.equal(item.teaser, 'A short Atom summary.');
    assert.equal(item.publishedAt, '2026-03-04T09:30:00.000Z');
  });
});

describe('prospect queue', () => {
  const feed = addFeed('https://example.com/feed.xml', 'Fixture', 'longread');

  const make = (guid: string, overrides: Partial<Parameters<typeof addProspect>[0]> = {}): boolean =>
    addProspect({
      feedId: feed.id,
      guid,
      url: `https://example.com/${guid}`,
      title: `Article ${guid}`,
      author: null,
      teaser: 'A teaser.',
      publishedAt: null,
      ...overrides,
    });

  it('stores an item once, however often the feed offers it', () => {
    assert.equal(make('a'), true);
    assert.equal(make('a'), false, 'second offer is ignored');
    assert.equal(countProspects('pending'), 1);
  });

  it('does not convert or store anything on its own', () => {
    const articles = db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number };
    assert.equal(articles.count, 0, 'noticing a feed item must not create an article');
  });

  it('orders newest first and filters by status', () => {
    make('b', { publishedAt: '2026-01-01T00:00:00.000Z' });
    make('c', { publishedAt: '2026-06-01T00:00:00.000Z' });

    const dated = listProspects({ status: 'pending', limit: 10, offset: 0 }).filter(
      (row) => row.published_at !== null,
    );
    assert.deepEqual(
      dated.map((row) => row.guid),
      ['c', 'b'],
      'most recently published first',
    );

    // Item 'a' carries no publish date, so it falls back to when we first saw it -- which
    // is now, and therefore ahead of everything the feed dated in the past.
    const all = listProspects({ status: 'pending', limit: 10, offset: 0 });
    assert.equal(all[0]!.guid, 'a', 'undated items sort by discovery time');

    setStatus(all[0]!.id, 'skipped');
    assert.equal(countProspects('skipped'), 1);
    assert.equal(listProspects({ status: 'pending', limit: 10, offset: 0 }).length, 2);
  });

  it('bulk skips by age', () => {
    const skipped = skipMany({ olderThanIso: '2026-03-01T00:00:00.000Z' });
    assert.equal(skipped, 1, 'only the January item is old enough');
  });

  it('expires by how long you have had an item, not by its publication date', () => {
    // Subscribing to a feed whose archive is years old must not bin everything at once.
    make('old-news', { publishedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(expireOldProspects(), 0, 'just-seen items survive however old the article is');
    assert.equal(getProspect(listProspects({ status: 'pending', limit: 1, offset: 0 })[0]!.id)!.status, 'pending');

    // An item that has sat undecided past the window does go.
    const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare(`UPDATE prospects SET seen_at = ? WHERE guid = 'old-news'`).run(stale);
    assert.equal(expireOldProspects(), 1);
    assert.equal(countProspects('expired'), 1);
  });

  it('allows undo inside the window and not outside it', () => {
    make('undoable');
    const row = listProspects({ status: 'pending', limit: 1, offset: 0 })[0]!;
    setStatus(row.id, 'skipped');

    assert.equal(isUndoable(getProspect(row.id)!), true);
    assert.equal(isUndoable({ ...row, status: 'pending', decided_at: null } as ProspectRow), false);

    const longAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
    db.prepare('UPDATE prospects SET decided_at = ? WHERE id = ?').run(longAgo, row.id);
    assert.equal(isUndoable(getProspect(row.id)!), false);
  });
});

describe('summariser', () => {
  let server: http.Server;
  const requests: Record<string, unknown>[] = [];
  let reply: { status: number; body: unknown } = {
    status: 200,
    body: { choices: [{ message: { content: 'Summary: a two sentence summary. It says what the piece argues.' } }] },
  };

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/article')) {
        const html = `<!doctype html><html><head><title>Fixture</title></head><body><article>
          <h1>A Real Article</h1>
          <p>${'The body of the article, long enough for the extractor to accept it as real prose. '.repeat(6)}</p>
          </article></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try {
          requests.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          requests.push({});
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });

    await new Promise<void>((resolve) => server.listen(8123, '127.0.0.1', resolve));
    assert.equal((server.address() as AddressInfo).port, 8123);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const prospectFor = (url: string, teaser: string | null): ProspectRow => {
    const feed = addFeed('https://example.com/summary-feed.xml', 'Summary Fixture', null);
    const guid = `s-${Math.random().toString(36).slice(2)}`;
    addProspect({ feedId: feed.id, guid, url, title: 'A Real Article', author: null, teaser, publishedAt: null });
    return db.prepare('SELECT * FROM prospects WHERE guid = ?').get(guid) as ProspectRow;
  };

  it('fetches the article, summarises it, and stores only the summary', async () => {
    const prospect = prospectFor('http://127.0.0.1:8123/article', null);
    const result = await summarizeProspect(prospect);

    assert.equal(result.source, 'article');
    assert.equal(result.model, 'stub/model');
    assert.match(result.summary, /two sentence summary/);
    // A "Summary:" label is stripped; a sentence that merely begins with "Here is" is not,
    // because trimming it would leave a fragment.
    assert.ok(!result.summary.toLowerCase().startsWith('summary:'));
    assert.ok(result.summary.startsWith('a two sentence summary'));

    const stored = getProspect(prospect.id)!;
    assert.equal(stored.summary, result.summary);
    assert.equal(stored.summary_model, 'stub/model');
    assert.ok(stored.summary.length < 400, 'only the summary is kept, not the article');

    const sent = requests.at(-1)!;
    assert.equal(sent.model, 'stub/model');
    assert.ok(JSON.stringify(sent).includes('A Real Article'));
  });

  it('falls back to the feed teaser when the article cannot be read', async () => {
    const prospect = prospectFor('http://127.0.0.1:9/unreachable', 'The feed teaser, which is all we have.');
    const result = await summarizeProspect(prospect);
    assert.equal(result.source, 'teaser');
    assert.ok(JSON.stringify(requests.at(-1)).includes('feed teaser'));
  });

  it('reports a model error instead of storing junk', async () => {
    reply = { status: 429, body: { error: { message: 'rate limited' } } };
    const prospect = prospectFor('http://127.0.0.1:8123/article', null);

    await assert.rejects(() => summarizeProspect(prospect), /rate limited/);
    const stored = getProspect(prospect.id)!;
    assert.equal(stored.summary, null);
    assert.match(stored.summary_error!, /rate limited/);

    reply = { status: 200, body: { choices: [{ message: { content: 'Recovered summary.' } }] } };
  });

  it('collapses a double click into one model call', async () => {
    const prospect = prospectFor('http://127.0.0.1:8123/article', null);
    const before = requests.length;

    const [a, b] = await Promise.all([summarizeProspect(prospect), summarizeProspect(prospect)]);
    assert.equal(a.summary, b.summary);
    assert.equal(requests.length - before, 1, 'one request, not two');
  });
});
