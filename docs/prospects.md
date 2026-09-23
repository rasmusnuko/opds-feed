# Prospects: triaging feeds without converting them

Subscribing to a feed used to mean converting every item it published. That is fine for
one carefully chosen feed and ruinous for ten — most items are not worth an EPUB, and the
disk fills with articles nobody chose.

Feed items now arrive as **prospects**: title, teaser, author, link and date, taken from
what the feed itself published. Nothing is fetched, converted or stored until you press
Save. A prospect row is a few hundred bytes; a converted article is ~200 KB.

## The queue

`/prospects` lists what your feeds are offering:

```
☐  The Slow Web & Its Discontents                    [Save] [Skip] [Summary]
   A. Writer · 2026-03-04 · example.com
   Reading on a small greyscale screen changes what a page is for…
```

- **Save** hands the URL to the normal conversion queue and links the resulting article.
- **Skip** files it away; both decisions are reversible for `PROSPECT_UNDO_WINDOW_HOURS`.
- **Summary** is covered below.

Tabs across the top switch between Pending, Saved, Skipped and Expired, with counts. Feed
chips filter to one source, which is much faster to scan than a mixed stream.

**Bulk actions** matter more than they look: subscribing to a feed with a backlog can
offer you 25 items at once. There is select-all, *Skip selected*, *Save selected*, *Skip
older than 7 days*, and *Skip all from this feed* when a feed filter is active.

**Keyboard**, on desktop: <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>a</kbd> save,
<kbd>s</kbd> skip, <kbd>e</kbd> summary. A hundred-item backlog becomes a two-minute pass.

Every action is a real form post, so the page works with JavaScript disabled. With
JavaScript it upgrades to in-place `fetch` calls and the row disappears without a reload.

**Expiry.** Undecided prospects are dropped after `PROSPECT_EXPIRY_DAYS`, counted from
when *you* first saw the item, never from the article's publication date — otherwise
subscribing to a feed with an archive would bin its entire backlog on the first poll. A
queue you can never finish is one you stop opening.

## Summaries

The Summary button fetches the article, summarises it, and throws the article away. Only
the summary is kept, so a decision aid costs ~300 bytes rather than a converted EPUB.

It is deliberately **on demand and synchronous**. You pressed the button, you are waiting,
and a few seconds is the expected price. Nothing is summarised speculatively, so you only
ever pay for the items you were genuinely undecided about — which is a small fraction of
what a pre-computing design would spend.

Results are cached on the row, a second click costs nothing, and two concurrent clicks
share one request.

If the article cannot be fetched (paywall, bot wall, dead link), it falls back to
summarising the feed's own teaser and says so, rather than showing an error.

### Configuration

Any OpenAI-compatible chat-completions endpoint works:

```bash
SUMMARY_ENABLED=true
SUMMARY_ENDPOINT=https://openrouter.ai/api/v1
SUMMARY_API_KEY=sk-or-...
SUMMARY_MODEL=google/gemini-2.0-flash-001
```

Point it at a local model instead and nothing else changes:

```bash
SUMMARY_ENDPOINT=http://127.0.0.1:11434/v1
SUMMARY_MODEL=qwen3:8b
SUMMARY_API_KEY=            # local endpoints generally need none
```

Summarisation is about the most forgiving task there is — it is dominated by reading the
input rather than reasoning about it, so a 4B–8B local model does this job well. A local
model is also the only option that keeps article text on your own hardware, which matters
if you ever run this for other people.

`SUMMARY_MAX_INPUT_CHARS` (default 6000) is the main cost and latency lever. Journalism is
inverted-pyramid by construction, so the opening almost always carries enough to judge
interest; raising it buys little and costs linearly.

The summary endpoint is called with a plain `fetch`, deliberately bypassing the SSRF guard
that protects article ingest — the endpoint is set by the operator, and a local model on
`127.0.0.1` is a normal configuration. Article fetching still goes through the guard.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/prospects` | List. `?status=pending\|saved\|skipped\|expired`, `?feed=`, `?limit=`, `?offset=` |
| `POST` | `/api/prospects/:id/save` | Convert and store it |
| `POST` | `/api/prospects/:id/skip` | File it away |
| `POST` | `/api/prospects/:id/summary` | Summarise now; returns the cached one if present |

State-changing requests that carry a browser `Origin` header must be same-origin. Requests
with no `Origin` — curl, phone shortcuts, anything using a bearer token — are unaffected.

## Upgrading an existing install

The migration is additive and safe to apply to a running instance. Items converted before
prospects existed are recorded in the legacy `feed_items` table, and the poller still
consults it, so upgrading will not resurface a year of already-converted articles as fresh
prospects.

The behavioural change is the point: **feeds no longer convert anything on their own.**
After upgrading, new feed items wait in `/prospects` for you.
