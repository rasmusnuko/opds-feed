import { config } from '../config.js';
import type { ArticleRow, FeedRow } from '../db.js';
import { escapeHtml, formatBytes, formatDate } from '../util/text.js';

const STYLES = `
:root {
  --bg: #fbfbfa;
  --panel: #ffffff;
  --text: #1b1b1b;
  --muted: #6b6b6b;
  --border: #e3e3e0;
  --accent: #2f5d50;
  --danger: #a33a30;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --panel: #1f2023;
    --text: #ececec;
    --muted: #9a9a9a;
    --border: #33353a;
    --accent: #7fc0ab;
    --danger: #e08076;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
header { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
h1 { font-size: 1.3rem; margin: 0; }
h2 { font-size: 1rem; margin: 2rem 0 0.75rem; }
nav a { color: var(--muted); text-decoration: none; margin-left: 1rem; }
nav a:hover, nav a.active { color: var(--text); }
a { color: var(--accent); }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
form.add { display: flex; flex-wrap: wrap; gap: 0.5rem; }
input[type=url], input[type=text] {
  flex: 1 1 18rem; min-width: 0; padding: 0.6rem 0.7rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font-size: 1rem;
}
input.tags { flex: 0 1 10rem; }
button {
  padding: 0.6rem 1.1rem; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--accent); color: var(--panel); font-size: 1rem; font-weight: 600;
}
button.secondary { background: transparent; color: var(--muted); border: 1px solid var(--border); font-weight: 400; padding: 0.3rem 0.6rem; font-size: 0.85rem; }
button.danger { background: transparent; color: var(--danger); border: 1px solid var(--border); font-weight: 400; padding: 0.3rem 0.6rem; font-size: 0.85rem; }
.flash { padding: 0.7rem 0.9rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid var(--border); }
.flash.ok { border-color: var(--accent); }
.flash.err { border-color: var(--danger); color: var(--danger); }
ul.items { list-style: none; margin: 0; padding: 0; }
ul.items li { border-bottom: 1px solid var(--border); padding: 0.8rem 0; display: flex; gap: 0.9rem; align-items: flex-start; }
ul.items li:last-child { border-bottom: 0; }
.thumb { width: 46px; height: 61px; flex: 0 0 46px; object-fit: cover; border: 1px solid var(--border); border-radius: 3px; background: var(--bg); }
.item-main { flex: 1 1 auto; min-width: 0; }
.item-title { font-weight: 600; word-wrap: break-word; }
.item-meta { color: var(--muted); font-size: 0.85rem; word-break: break-word; }
.item-actions { display: flex; gap: 0.4rem; flex: 0 0 auto; }
.pill { display: inline-block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; color: var(--muted); }
.pill.ready { color: var(--accent); border-color: var(--accent); }
.pill.failed { color: var(--danger); border-color: var(--danger); }
.err-text { color: var(--danger); font-size: 0.85rem; word-break: break-word; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; overflow-x: auto; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; word-break: break-all; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
`;

export function layout(title: string, activePath: string, base: string, body: string): string {
  const nav = [
    ['/', 'Articles'],
    ['/feeds', 'Feeds'],
    ['/help', 'Connect'],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${href === activePath ? 'active' : ''}">${escapeHtml(label!)}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(config.catalogTitle)}</h1>
  <nav>${nav}</nav>
</header>
${body}
<footer>OPDS catalogue at <code>${escapeHtml(base)}/opds</code></footer>
</div>
</body>
</html>
`;
}

export function flash(ok: string | undefined, err: string | undefined): string {
  if (err) return `<div class="flash err">${escapeHtml(err)}</div>`;
  if (ok) return `<div class="flash ok">${escapeHtml(ok)}</div>`;
  return '';
}

function statusPill(article: ArticleRow): string {
  const label =
    article.status === 'ready'
      ? article.downloaded_at
        ? 'downloaded'
        : 'ready'
      : article.status;
  const className = article.status === 'ready' ? 'ready' : article.status === 'failed' ? 'failed' : '';
  return `<span class="pill ${className}">${escapeHtml(label)}</span>`;
}

function articleItem(article: ArticleRow): string {
  const meta = [
    article.site,
    formatDate(article.published_at ?? article.added_at),
    article.reading_minutes > 0 ? `${article.reading_minutes} min` : null,
    article.epub_size ? formatBytes(article.epub_size) : null,
  ]
    .filter((bit): bit is string => Boolean(bit && bit.length > 0))
    .join(' · ');

  const source = article.canonical_url ?? article.url;

  const thumb = article.thumb_path
    ? `<img class="thumb" src="/covers/${escapeHtml(article.id)}-thumb.jpg" alt=""/>`
    : `<div class="thumb"></div>`;

  const titleHtml =
    article.status === 'ready'
      ? `<a href="/download/${escapeHtml(article.id)}.epub">${escapeHtml(article.title)}</a>`
      : escapeHtml(article.title);

  const error = article.error ? `<div class="err-text">${escapeHtml(article.error)}</div>` : '';

  return `<li>
  ${thumb}
  <div class="item-main">
    <div class="item-title">${titleHtml} ${statusPill(article)}</div>
    <div class="item-meta">${escapeHtml(meta)}</div>
    <div class="item-meta"><a href="${escapeHtml(source)}">${escapeHtml(source)}</a></div>
    ${error}
  </div>
  <div class="item-actions">
    <form method="post" action="/articles/${escapeHtml(article.id)}/retry"><button class="secondary" type="submit">Redo</button></form>
    <form method="post" action="/articles/${escapeHtml(article.id)}/delete"><button class="danger" type="submit">Delete</button></form>
  </div>
</li>`;
}

export function articlesPage(options: {
  base: string;
  articles: ArticleRow[];
  counts: Record<string, number>;
  page: number;
  hasNext: boolean;
  query: string;
  ok?: string;
  err?: string;
}): string {
  const items =
    options.articles.length > 0
      ? `<ul class="items">${options.articles.map(articleItem).join('\n')}</ul>`
      : `<p class="item-meta">Nothing here yet. Paste an article URL above.</p>`;

  const pager = [
    options.page > 1
      ? `<a href="/?page=${options.page - 1}${options.query ? `&q=${encodeURIComponent(options.query)}` : ''}">← Newer</a>`
      : '',
    options.hasNext
      ? `<a href="/?page=${options.page + 1}${options.query ? `&q=${encodeURIComponent(options.query)}` : ''}">Older →</a>`
      : '',
  ]
    .filter((link) => link.length > 0)
    .join(' &nbsp; ');

  const summary = `${options.counts.ready ?? 0} ready · ${options.counts.pending ?? 0} queued · ${
    options.counts.processing ?? 0
  } converting · ${options.counts.failed ?? 0} failed`;

  return layout(
    config.catalogTitle,
    '/',
    options.base,
    `${flash(options.ok, options.err)}
<div class="panel">
  <form class="add" method="post" action="/add">
    <input type="url" name="url" placeholder="https://example.com/article" required autofocus autocomplete="off"/>
    <input class="tags" type="text" name="tags" placeholder="tags (optional)" autocomplete="off"/>
    <button type="submit">Add</button>
  </form>
</div>

<h2>Articles <span class="item-meta">${escapeHtml(summary)}</span></h2>
<form class="add" method="get" action="/" style="margin-bottom:1rem">
  <input type="text" name="q" placeholder="Search titles, sites, authors" value="${escapeHtml(options.query)}"/>
  <button class="secondary" type="submit">Search</button>
</form>
<div class="panel">${items}</div>
<p>${pager}</p>`,
  );
}

export function feedsPage(options: { base: string; feeds: FeedRow[]; ok?: string; err?: string }): string {
  const rows =
    options.feeds.length > 0
      ? `<ul class="items">${options.feeds
          .map(
            (feed) => `<li>
  <div class="item-main">
    <div class="item-title">${escapeHtml(feed.title ?? feed.url)} ${
      feed.enabled ? '' : '<span class="pill">paused</span>'
    }</div>
    <div class="item-meta">${escapeHtml(feed.url)}</div>
    <div class="item-meta">${
      feed.last_polled_at ? `last polled ${escapeHtml(feed.last_polled_at)}` : 'never polled'
    }${feed.tag ? ` · tag: ${escapeHtml(feed.tag)}` : ''}</div>
    ${feed.last_error ? `<div class="err-text">${escapeHtml(feed.last_error)}</div>` : ''}
  </div>
  <div class="item-actions">
    <form method="post" action="/feeds/${escapeHtml(feed.id)}/toggle"><button class="secondary" type="submit">${
      feed.enabled ? 'Pause' : 'Resume'
    }</button></form>
    <form method="post" action="/feeds/${escapeHtml(feed.id)}/delete"><button class="danger" type="submit">Delete</button></form>
  </div>
</li>`,
          )
          .join('\n')}</ul>`
      : `<p class="item-meta">No feeds yet. Every new item in a feed becomes an EPUB automatically.</p>`;

  const polling = config.rss.enabled
    ? `Polling every ${config.rss.pollIntervalMinutes} minutes, at most ${config.rss.maxItemsPerPoll} new items per feed per poll.`
    : 'Feed polling is disabled (RSS_ENABLED=false).';

  return layout(
    'Feeds',
    '/feeds',
    options.base,
    `${flash(options.ok, options.err)}
<div class="panel">
  <form class="add" method="post" action="/feeds/add">
    <input type="url" name="url" placeholder="https://example.com/feed.xml" required autocomplete="off"/>
    <input class="tags" type="text" name="tag" placeholder="tag (optional)" autocomplete="off"/>
    <button type="submit">Subscribe</button>
  </form>
</div>

<h2>Subscriptions</h2>
<div class="panel">${rows}</div>
<p class="item-meta">${escapeHtml(polling)}
  <form method="post" action="/feeds/poll" style="display:inline"><button class="secondary" type="submit">Poll now</button></form>
</p>`,
  );
}

export function helpPage(base: string, token: string | null): string {
  const catalogUrl = `${base}/opds`;
  const tokenValue = token ?? '<your API_TOKENS value>';
  const tokenParam = encodeURIComponent(tokenValue);
  const bookmarklet = `javascript:(function(){window.open('${base}/api/add?token=${tokenParam}&url='+encodeURIComponent(location.href),'_blank');})()`;
  // Posts the page as rendered in the browser (plus any highlighted selection) so the
  // server needs neither the user's logins nor the page's JavaScript.
  const pageBookmarklet =
    `javascript:(function(){var f=document.createElement('form');f.method='post';` +
    `f.enctype='multipart/form-data';f.acceptCharset='utf-8';f.target='_blank';` +
    `f.action='${base}/api/add?token=${tokenParam}';` +
    `function a(n,v){var t=document.createElement('textarea');t.name=n;t.value=v;f.appendChild(t);}` +
    `var s=window.getSelection(),d=document.createElement('div');` +
    `if(s&&!s.isCollapsed){for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());}` +
    `a('url',location.href);a('title',document.title);a('html',document.documentElement.outerHTML);` +
    `if(d.innerHTML)a('selection',d.innerHTML);` +
    `f.style.display='none';document.body.appendChild(f);f.submit();f.remove();})()`;

  return layout(
    'Connect',
    '/help',
    base,
    `<h2>Point a reader at the catalogue</h2>
<div class="panel">
  <dl class="kv">
    <dt>OPDS URL</dt><dd><code>${escapeHtml(catalogUrl)}</code></dd>
    <dt>Authentication</dt><dd>HTTP Basic — the same username and password you used to open this page</dd>
    <dt>Username</dt><dd><code>${escapeHtml(config.auth.username)}</code></dd>
  </dl>
  <p class="item-meta">Any OPDS 1.2 client works: CrossPoint Reader, KOReader, Moon+ Reader, Thorium, Foliate, Calibre's catalogue browser.</p>
</div>

<h2>Send an article from your phone</h2>
<div class="panel">
  <p>Create a shortcut that sends the shared URL to:</p>
  <pre>POST ${escapeHtml(base)}/api/articles
Authorization: Bearer ${escapeHtml(tokenValue)}
Content-Type: application/json

{"url": "SHARED_URL"}</pre>
  <p class="item-meta">On iOS: Shortcuts &rarr; new shortcut &rarr; <em>Get Contents of URL</em>, method POST, the header and JSON body above, then enable <em>Show in Share Sheet</em> with <em>URLs</em> as the input type. On Android, HTTP Shortcuts or Tasker does the same job.</p>
</div>

<h2>Browser bookmarklet</h2>
<div class="panel">
  <p><strong>Send the page</strong> (recommended). Sends the page as your browser shows it, so logins, paywalls you pay for and JavaScript-only sites work. Highlight the article first to use exactly that part:</p>
  <pre>${escapeHtml(pageBookmarklet)}</pre>
  <p><strong>Send the link only.</strong> The server fetches the page itself. Use this on sites whose security policy blocks the one above (nothing happens when you click it):</p>
  <pre>${escapeHtml(bookmarklet)}</pre>
  ${token ? '' : '<p class="err-text">Set API_TOKENS in your environment to get a working bookmarklet.</p>'}
</div>

<h2>From a terminal</h2>
<div class="panel">
  <pre>curl -X POST ${escapeHtml(base)}/api/articles \\
  -H "Authorization: Bearer ${escapeHtml(tokenValue)}" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/article", "tags": ["longread"]}'</pre>
</div>`,
  );
}
