# Sending articles from a phone or browser

All of these hit the same endpoint. Anything that can make an authenticated HTTP
request can add an article.

## iOS / iPadOS — Shortcuts

1. Shortcuts &rarr; **+** &rarr; rename it something like "Send to Reader".
2. Add **Get Contents of URL** and set:
   - URL: `https://books.example.com/api/articles`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer YOUR_TOKEN`
   - Request Body: **JSON**, one field `url` (Text) = **Shortcut Input**
3. Open the shortcut's settings (ⓘ), enable **Show in Share Sheet**, and set
   *Accepted Types* to **URLs** only.

Now the shortcut appears in the share sheet of Safari and any app that shares links.

To tag on the fly, add a second JSON field `tags` with a comma-separated string, or
make several shortcuts with different fixed tags.

## Android

**HTTP Shortcuts** (open source) or **Tasker** both work:

- Method: `POST`
- URL: `https://books.example.com/api/articles`
- Header: `Authorization: Bearer YOUR_TOKEN`
- Body type: plain text, body: the shared URL

The API accepts a bare URL as a `text/plain` body precisely so this setup needs no
JSON templating.

## Browser bookmarklet

The **Connect** page in the web UI prints this with your own host and token filled
in. Drag it to the bookmarks bar and click it on any article:

```js
javascript:(function(){window.open('https://books.example.com/api/add?token=YOUR_TOKEN&url='+encodeURIComponent(location.href),'_blank');})()
```

It opens a small tab confirming the article was queued.

Note that the token is visible in the bookmarklet and in the URL, so it ends up in
browser history. Issue a separate token for it if that bothers you — `API_TOKENS`
takes a comma-separated list, and you can drop one without touching the others.

## Command line

```bash
alias read-later='curl -sS -X POST https://books.example.com/api/articles \
  -H "Authorization: Bearer $OPDS_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<< "{\"url\": \"$1\"}"'
```

## RSS

Anything you subscribe to on the **Feeds** page is polled on a timer
(`RSS_POLL_INTERVAL_MINUTES`, default 30). Each new item is fetched and converted
like a manually submitted URL, tagged with the feed's tag if you set one.

On the first poll of a feed only the newest `RSS_MAX_ITEMS_PER_POLL` items are
queued, so subscribing to a large archive does not flood the queue.
