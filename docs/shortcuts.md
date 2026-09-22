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

The **Connect** page in the web UI prints two bookmarklets with your own host and
token filled in. Drag one to the bookmarks bar and click it on any article.

**Send the page** (recommended) posts the page as your browser currently shows it.
The server converts that copy, so it works for sites you are logged in to, paywalls
you pay for, bot walls and pages built by JavaScript. If you highlight part of the
page first, only that part becomes the article:

```js
javascript:(function(){var f=document.createElement('form');f.method='post';f.enctype='multipart/form-data';f.acceptCharset='utf-8';f.target='_blank';f.action='https://books.example.com/api/add?token=YOUR_TOKEN';function a(n,v){var t=document.createElement('textarea');t.name=n;t.value=v;f.appendChild(t);}var s=window.getSelection(),d=document.createElement('div');if(s&&!s.isCollapsed){for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());}a('url',location.href);a('title',document.title);a('html',document.documentElement.outerHTML);if(d.innerHTML)a('selection',d.innerHTML);f.style.display='none';document.body.appendChild(f);f.submit();f.remove();})()
```

Some sites have a Content Security Policy that stops pages from submitting forms to
other sites, and there the click does nothing. Use **Send the link** instead, which
only passes the URL and lets the server fetch the page:

```js
javascript:(function(){window.open('https://books.example.com/api/add?token=YOUR_TOKEN&url='+encodeURIComponent(location.href),'_blank');})()
```

Both open a small tab confirming the article was queued.

Note that the token is visible in the bookmarklet and in the URL, so it ends up in
browser history. Issue a separate token for it if that bothers you. `API_TOKENS`
takes a comma-separated list, and you can drop one without touching the others.

### Sending the page from iOS

In Shortcuts, add **Run JavaScript on Web Page** before **Get Contents of URL**, with:

```js
completion(JSON.stringify({ url: location.href, title: document.title,
  html: document.documentElement.outerHTML,
  selection: (() => { const s = getSelection(), d = document.createElement('div');
    for (let i = 0; i < s.rangeCount; i++) d.appendChild(s.getRangeAt(i).cloneContents());
    return d.innerHTML; })() }));
```

Then, in **Get Contents of URL**, set the method to POST, add the header `Content-Type: application/json`, and set **Request Body** to **File** with the JavaScript result. The
shortcut must accept **Safari web pages** as input.

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
