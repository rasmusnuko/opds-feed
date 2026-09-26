import { config } from '../config.js';
import type { ArticleRow, FeedRow, ProspectRow, ProspectStatus } from '../db.js';
import { escapeHtml, formatBytes, formatDate, truncate } from '../util/text.js';
import { hostLabel } from '../util/url.js';

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

.tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.tabs a {
  padding: 0.35rem 0.8rem; border-radius: 999px; text-decoration: none;
  border: 1px solid var(--border); color: var(--muted); font-size: 0.9rem;
}
.tabs a.active { color: var(--text); border-color: var(--accent); }
.chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 1rem; }
.chips a {
  font-size: 0.8rem; padding: 0.2rem 0.6rem; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted); text-decoration: none;
}
.chips a.active { color: var(--text); border-color: var(--accent); }

ul.prospects { list-style: none; margin: 0; padding: 0; }
ul.prospects li { border-bottom: 1px solid var(--border); padding: 0.85rem 0; }
ul.prospects li:last-child { border-bottom: 0; }
ul.prospects li.decided { opacity: 0.45; }
ul.prospects li.focused { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
.prospect-head { display: flex; gap: 0.7rem; align-items: flex-start; }
.prospect-head input[type=checkbox] { margin-top: 0.35rem; flex: 0 0 auto; }
.prospect-main { flex: 1 1 auto; min-width: 0; }
/* Feed teasers are largely bare URLs -- Hacker News ships "Article URL: ... Comments
   URL: ..." -- and an unbroken URL is wider than a phone, so it must be allowed to break
   mid-token or it overflows the row and drags the layout with it. */
.prospect-title, .prospect-meta, .prospect-teaser, .summary { overflow-wrap: anywhere; }
.prospect-title { font-weight: 600; line-height: 1.35; }
.prospect-title a { text-decoration: none; }
.prospect-meta { color: var(--muted); font-size: 0.82rem; margin-top: 0.15rem; }
.prospect-teaser { font-size: 0.9rem; margin-top: 0.4rem; color: var(--text); }
.prospect-actions { display: flex; gap: 0.35rem; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
.prospect-actions form { display: inline; }
.summary {
  margin-top: 0.6rem; padding: 0.6rem 0.75rem; border-left: 2px solid var(--accent);
  background: var(--bg); border-radius: 0 6px 6px 0; font-size: 0.9rem;
}
.summary .label {
  display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--muted); margin-bottom: 0.25rem;
}
.summary.error { border-left-color: var(--danger); color: var(--danger); }
.bulk { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.hint { color: var(--muted); font-size: 0.8rem; }
kbd {
  font-family: ui-monospace, monospace; font-size: 0.75rem; border: 1px solid var(--border);
  border-radius: 4px; padding: 0.05rem 0.3rem;
}

/* On a phone the three action buttons cannot share a row with the text: held at their
   natural width they wrapped into a narrow column and squeezed the content to under half
   the screen. Below this width they move to their own row under the item instead, which
   also puts them within thumb reach. */
@media (max-width: 640px) {
  .prospect-head { flex-wrap: wrap; }
  /* basis 0 rather than auto: with a content-sized basis the text column no longer fits
     beside the checkbox and wraps, stranding the checkbox alone on its own line. */
  .prospect-main { flex: 1 1 0; }
  .prospect-actions {
    flex: 1 1 100%;
    justify-content: flex-start;
    margin-top: 0.6rem;
    padding-left: 1.7rem; /* line up with the text, clear of the checkbox */
  }
  .prospect-actions button {
    min-height: 2.4rem; /* a comfortable tap target */
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
  }
  .summary { font-size: 0.95rem; padding: 0.7rem 0.8rem; }
  .tabs a, .chips a { padding: 0.4rem 0.85rem; }
}
`;

export function layout(title: string, activePath: string, base: string, body: string): string {
  const nav = [
    ['/', 'Articles'],
    ['/prospects', 'Prospects'],
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
  const bookmarklet = `javascript:(function(){window.open('${base}/api/add?token=${encodeURIComponent(
    tokenValue,
  )}&url='+encodeURIComponent(location.href),'_blank');})()`;

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
  <p>Drag this to your bookmarks bar, then click it on any article:</p>
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

/* ------------------------------------------------------------------ prospects */

function prospectRow(prospect: ProspectRow, options: { summaries: boolean; undoable: boolean }): string {
  const meta = [
    prospect.author,
    formatDate(prospect.published_at ?? prospect.seen_at),
    hostLabel(prospect.url),
  ]
    .filter((bit): bit is string => Boolean(bit && bit.length > 0))
    .join(' · ');

  const teaser = prospect.teaser
    ? `<div class="prospect-teaser">${escapeHtml(truncate(prospect.teaser, 320))}</div>`
    : '';

  const summaryBlock = prospect.summary
    ? `<div class="summary" data-summary><span class="label">Summary${
        prospect.summary_model ? ` · ${escapeHtml(prospect.summary_model)}` : ''
      }</span>${escapeHtml(prospect.summary)}</div>`
    : prospect.summary_error
      ? `<div class="summary error" data-summary><span class="label">Summary failed</span>${escapeHtml(
          prospect.summary_error,
        )}</div>`
      : '<div data-summary hidden></div>';

  // Every action is a real form post, so the page works with JavaScript disabled; the
  // script below upgrades them to in-place fetches for fast triage.
  const action = (path: string, label: string, className = 'secondary'): string =>
    `<form method="post" action="/prospects/${escapeHtml(prospect.id)}/${path}">` +
    `<button class="${className}" type="submit" data-action="${path}">${escapeHtml(label)}</button></form>`;

  const actions =
    prospect.status === 'pending'
      ? [
          action('save', 'Save', 'secondary'),
          action('skip', 'Skip', 'danger'),
          options.summaries ? action('summary', 'Summary') : '',
        ]
      : [options.undoable ? action('undo', 'Undo') : ''];

  return `<li id="p-${escapeHtml(prospect.id)}" data-prospect="${escapeHtml(prospect.id)}"${
    prospect.status === 'pending' ? '' : ' class="decided"'
  }>
  <div class="prospect-head">
    ${prospect.status === 'pending' ? `<input type="checkbox" name="ids" value="${escapeHtml(prospect.id)}" aria-label="Select"/>` : '<span class="thumb" style="width:0;flex:0"></span>'}
    <div class="prospect-main">
      <div class="prospect-title"><a href="${escapeHtml(prospect.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(
        prospect.title,
      )}</a></div>
      <div class="prospect-meta">${escapeHtml(meta)}</div>
      ${teaser}
      ${summaryBlock}
    </div>
    <div class="prospect-actions">${actions.filter((item) => item.length > 0).join('')}</div>
  </div>
</li>`;
}

const TRIAGE_SCRIPT = `
(function () {
  var list = document.querySelector('ul.prospects');
  if (!list) return;

  function setSummary(row, html, isError) {
    var box = row.querySelector('[data-summary]');
    if (!box) return;
    box.hidden = false;
    box.className = isError ? 'summary error' : 'summary';
    box.innerHTML = html;
  }

  function post(row, action, button) {
    var id = row.getAttribute('data-prospect');
    var original = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = action === 'summary' ? 'Reading\\u2026' : '\\u2026'; }

    return fetch('/prospects/' + id + '/' + action, {
      method: 'POST',
      headers: { 'accept': 'application/json' },
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (button) { button.disabled = false; button.textContent = original; }
        if (action === 'summary') {
          if (res.ok && res.body.summary) {
            setSummary(row, '<span class="label">Summary' + (res.body.model ? ' \\u00b7 ' + res.body.model : '') +
              (res.body.source === 'teaser' ? ' \\u00b7 from feed description' : '') + '</span>' +
              res.body.summary.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }), false);
          } else {
            setSummary(row, '<span class="label">Summary failed</span>' + (res.body.error || 'Unknown error'), true);
          }
          return;
        }
        // Save and Skip both remove the row from the pending list.
        row.style.transition = 'opacity .15s';
        row.style.opacity = '0';
        setTimeout(function () { row.remove(); }, 150);
      })
      .catch(function () {
        if (button) { button.disabled = false; button.textContent = original; }
        setSummary(row, '<span class="label">Failed</span>Network error', true);
      });
  }

  list.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.matches('li form')) return;
    var button = form.querySelector('button');
    var action = button && button.getAttribute('data-action');
    var row = form.closest('li');
    if (!action || !row) return;
    event.preventDefault();
    post(row, action, button);
  });

  // Keyboard triage: j/k to move, a save, s skip, e summary.
  var focused = null;
  function focus(row) {
    if (focused) focused.classList.remove('focused');
    focused = row;
    if (row) { row.classList.add('focused'); row.scrollIntoView({ block: 'nearest' }); }
  }
  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    var rows = Array.prototype.slice.call(list.querySelectorAll('li'));
    if (rows.length === 0) return;
    var index = focused ? rows.indexOf(focused) : -1;

    if (event.key === 'j') { focus(rows[Math.min(index + 1, rows.length - 1)]); event.preventDefault(); }
    else if (event.key === 'k') { focus(rows[Math.max(index - 1, 0)]); event.preventDefault(); }
    else if (focused && (event.key === 'a' || event.key === 's' || event.key === 'e')) {
      var map = { a: 'save', s: 'skip', e: 'summary' };
      var button = focused.querySelector('button[data-action="' + map[event.key] + '"]');
      if (button) { post(focused, map[event.key], button); event.preventDefault(); }
    }
  });
})();
`;

export interface ProspectsPageOptions {
  base: string;
  prospects: ProspectRow[];
  status: ProspectStatus;
  counts: Record<ProspectStatus, number>;
  feeds: { feed_id: string; title: string | null; url: string; count: number }[];
  activeFeedId: string | null;
  page: number;
  hasNext: boolean;
  summariesEnabled: boolean;
  undoable: (prospect: ProspectRow) => boolean;
  ok?: string;
  err?: string;
}

export function prospectsPage(options: ProspectsPageOptions): string {
  const query = (status: ProspectStatus): string =>
    `/prospects?status=${status}${options.activeFeedId ? `&feed=${encodeURIComponent(options.activeFeedId)}` : ''}`;

  const tabs = (['pending', 'saved', 'skipped', 'expired'] as ProspectStatus[])
    .map(
      (status) =>
        `<a href="${query(status)}" class="${status === options.status ? 'active' : ''}">${
          status[0]!.toUpperCase() + status.slice(1)
        } (${options.counts[status]})</a>`,
    )
    .join('');

  const chips =
    options.feeds.length > 1
      ? `<div class="chips">
      <a href="/prospects?status=${options.status}" class="${options.activeFeedId ? '' : 'active'}">All feeds</a>
      ${options.feeds
        .map(
          (feed) =>
            `<a href="/prospects?status=${options.status}&feed=${encodeURIComponent(feed.feed_id)}" class="${
              feed.feed_id === options.activeFeedId ? 'active' : ''
            }">${escapeHtml(truncate(feed.title ?? feed.url, 32))} (${feed.count})</a>`,
        )
        .join('')}
    </div>`
      : '';

  const items =
    options.prospects.length > 0
      ? `<ul class="prospects">${options.prospects
          .map((prospect) =>
            prospectRow(prospect, {
              summaries: options.summariesEnabled,
              undoable: options.undoable(prospect),
            }),
          )
          .join('\n')}</ul>`
      : `<p class="hint">Nothing here. New feed items appear as prospects; nothing is fetched or converted until you save it.</p>`;

  const bulk =
    options.status === 'pending' && options.prospects.length > 0
      ? `<div class="bulk">
    <button class="secondary" type="submit" name="action" value="skip">Skip selected</button>
    <button class="secondary" type="submit" name="action" value="save">Save selected</button>
    <span class="hint">or</span>
    <button class="secondary" type="submit" name="action" value="skip-older">Skip older than 7 days</button>
    ${
      options.activeFeedId
        ? '<button class="danger" type="submit" name="action" value="skip-feed">Skip all from this feed</button>'
        : ''
    }
  </div>`
      : '';

  const pager = [
    options.page > 1 ? `<a href="${query(options.status)}&page=${options.page - 1}">← Newer</a>` : '',
    options.hasNext ? `<a href="${query(options.status)}&page=${options.page + 1}">Older →</a>` : '',
  ]
    .filter((link) => link.length > 0)
    .join(' &nbsp; ');

  const summaryNote = options.summariesEnabled
    ? '<span class="hint">Summary fetches the article, summarises it, and keeps only the summary.</span>'
    : '<span class="hint">Summaries are off. Set SUMMARY_ENABLED and SUMMARY_API_KEY to enable the Summary button.</span>';

  return layout(
    'Prospects',
    '/prospects',
    options.base,
    `${flash(options.ok, options.err)}
<div class="tabs">${tabs}</div>
${chips}
<form method="post" action="/prospects/bulk">
  <input type="hidden" name="status" value="${escapeHtml(options.status)}"/>
  <input type="hidden" name="feed" value="${escapeHtml(options.activeFeedId ?? '')}"/>
  ${bulk}
  <div class="panel">${items}</div>
</form>
<p>${pager}</p>
<p>${summaryNote}
  <span class="hint">Keys: <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>a</kbd> save, <kbd>s</kbd> skip, <kbd>e</kbd> summary.</span>
</p>
<script>${TRIAGE_SCRIPT}</script>`,
  );
}
