# opds-feed

A self-hosted OPDS catalogue that turns article URLs into EPUBs.

Give it a link — from your phone's share sheet, a bookmarklet, `curl`, or an RSS
subscription — and a few seconds later the article is a clean EPUB sitting in an
OPDS 1.2 catalogue that any e-reader can browse and download over the internet,
behind a username and password.

It is a plain OPDS server. It does not care which reader you use: CrossPoint
Reader, KOReader, Moon+ Reader, Thorium, Foliate, Calibre's catalogue browser and
anything else that speaks OPDS 1.2 all work the same way.

## What it does

- **Ingest** an article URL over an authenticated API, a web form, a bookmarklet, or an RSS feed.
- **Extract** the readable article with Mozilla Readability, keeping title, byline,
  publication, publish date and canonical link.
- **Convert** it to a small, well-formed EPUB: sanitised XHTML, a generated typographic
  cover, and images re-encoded to something conservative readers actually render.
- **Serve** it as an OPDS 1.2 (Atom) catalogue with shelves, search and pagination,
  with HTTP Basic auth on every feed, cover and download.

## Quick start

```bash
git clone https://github.com/rasmusnuko/opds-feed.git
cd opds-feed
npm install

cp .env.example .env
npm run hash-password            # prints OPDS_PASSWORD_HASH=... for your .env
openssl rand -base64 24          # an API token for API_TOKENS

npm run build
npm start
```

Then open <http://127.0.0.1:8080/>, paste an article URL, and point your reader at
`http://127.0.0.1:8080/opds`.

### Docker

```bash
cp .env.example .env             # fill in OPDS_USERNAME, OPDS_PASSWORD_HASH, PUBLIC_URL, API_TOKENS
docker compose up -d --build
```

The compose file publishes the port on `127.0.0.1` only, so your existing TLS
reverse proxy is the only route in. See [docs/deploying.md](docs/deploying.md) for
nginx, Caddy and Apache snippets.

## Connecting a reader

| | |
|---|---|
| Catalogue URL | `https://your-domain/opds` |
| Authentication | HTTP Basic — **not** Digest |
| Username / password | `OPDS_USERNAME` and the password you hashed |

`PUBLIC_URL` must match the URL your reader connects to, because the links inside
the feed are absolute. If you leave `PUBLIC_URL` unset, links are derived from the
incoming request and the `X-Forwarded-*` headers instead.

The catalogue has four shelves: **Latest**, **Not yet downloaded**, **All articles**,
and **By site** (plus **By tag** once anything is tagged). Readers that support
OpenSearch also get a search box.

"Not yet downloaded" uses the only read-state signal OPDS gives us: an article moves
off that shelf the first time the catalogue serves its EPUB.

## Sending articles in

Every route below needs credentials. `/api/*` accepts either a bearer token from
`API_TOKENS` or the same Basic credentials; everything else is Basic only.

```bash
# JSON
curl -X POST https://your-domain/api/articles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article", "tags": ["longread"]}'

# a bare URL in the body, which is the easiest thing for a phone shortcut to send
curl -X POST https://your-domain/api/articles \
  -H "Authorization: Bearer $TOKEN" \
  -d "https://example.com/article"

# GET, for bookmarklets and anything that cannot send a body
curl "https://your-domain/api/add?token=$TOKEN&url=https%3A%2F%2Fexample.com%2Farticle"
```

The call returns immediately with `202` and a queued article; conversion happens in
the background, usually within a few seconds. The **Connect** page in the web UI
prints the exact iOS Shortcuts recipe and a ready-made bookmarklet with your token
already in it.

RSS subscriptions live on the **Feeds** page. New feed items do **not** convert
automatically — they arrive on the **Prospects** page as candidates, with the title and
teaser the feed published, and nothing is fetched or stored until you press Save. An
optional Summary button reads the article, summarises it and keeps only the summary. See
[docs/prospects.md](docs/prospects.md).

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/articles` | Queue a URL. JSON, form or plain-text body. |
| `GET` | `/api/add?url=` | Queue a URL via GET (bookmarklets). |
| `GET` | `/api/articles` | List articles. `?q=`, `?site=`, `?tag=`, `?limit=`, `?offset=`. |
| `GET` | `/api/articles/:id` | One article. |
| `POST` | `/api/articles/:id/retry` | Fetch and convert it again. |
| `DELETE` | `/api/articles/:id` | Delete the article and its files. |
| `GET` | `/api/prospects` | List feed candidates awaiting a decision. |
| `POST` | `/api/prospects/:id/save` | Convert and store a prospect. |
| `POST` | `/api/prospects/:id/skip` | Discard a prospect. |
| `POST` | `/api/prospects/:id/summary` | Summarise it so you can decide. |
| `GET`/`POST` | `/api/feeds` | List or subscribe to RSS/Atom feeds. |
| `DELETE` | `/api/feeds/:id` | Unsubscribe. |
| `POST` | `/api/feeds/poll` | Poll every feed now. |
| `GET` | `/api/status` | Queue counts and catalogue URL. |
| `GET` | `/healthz` | Unauthenticated liveness probe. |

## Configuration

Everything is environment variables; see [.env.example](.env.example) for the
annotated list. A local `.env` file is read at startup, and real environment
variables always win.

The conversion defaults target small greyscale e-ink screens, because that is the
hardest case: images are re-encoded to **baseline** (non-progressive) greyscale JPEG
at 800px, animated GIFs are flattened to their first frame, and covers are capped at
600×800 so low-powered readers can thumbnail them quickly. On a tablet or a desktop
reader you may prefer:

```bash
EPUB_IMAGE_MODE=colour
EPUB_MAX_IMAGE_WIDTH=1600
EPUB_JPEG_QUALITY=85
```

## Encrypted multi-user vault (in progress)

`src/crypto/` and `src/accounts/` hold a standalone, tested encryption layer for a
multi-user version: per-account master keys wrapped with Argon2id, AES-256-GCM envelope
encryption per article, sealed metadata with a blind index for deduplication, and recovery
codes. It is not yet wired into the server, which still runs single-user and unencrypted.

See [docs/encryption.md](docs/encryption.md) for the threat model, the key hierarchy and
the container format. `npm run vault-demo` walks the whole account lifecycle.

## Notes on security

- Every catalogue, cover and download route is behind HTTP Basic, and the API needs a
  bearer token or the same credentials. Passwords are compared in constant time and
  should be stored as an scrypt hash.
- The ingest pipeline fetches URLs that anyone holding a token can supply, so it
  refuses to connect to private, loopback, link-local and cloud-metadata addresses.
  `FETCH_ALLOW_PRIVATE_ADDRESSES=true` removes that protection — only set it if you
  deliberately want to ingest from your own LAN.
- Browser form posts are rejected unless they come from this origin, so cached Basic
  credentials cannot be replayed from another site.
- Basic auth sends the password on every request, so terminate TLS in front of this
  service and never expose it over plain HTTP on a public domain.

## Data

Everything lives under `DATA_DIR`:

```
data/
  opds-feed.sqlite    metadata, tags, feed subscriptions
  books/              the generated EPUBs
  covers/             cover and thumbnail JPEGs
```

Back up that directory and you have backed up the whole catalogue.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
