# Finding the article in a page: options

Context: on `claude/confident-cannon-jbyw8h`, `src/ingest/extract.ts` runs every page
through Mozilla Readability (`charThreshold: 250`). If that fails, it tries a fixed list
of selectors (`article`, `main`, `[role="main"]`, `#content`, `.post`, `.entry-content`,
`body`) and takes the first one with more than 50 words. Readability works on most blogs
and news sites. It goes wrong on pages that are mostly link lists, on pages built with
JavaScript, on paywalls, and on sites where the comments or "related" boxes score higher
than the body.

**Status:** the chosen fallback order is 8 → 1 → 4 → 7. Steps 8 (page and selection
sent by the browser), 1 (site rules) and 4 (Readability) are implemented. The
multi-library part of 4 and step 7 are stubs in `src/ingest/locate/stubs.ts`. The chain
itself is in `src/ingest/locate/index.ts`.

The options below can be combined. Each one returns a candidate `Element` that the
existing `sanitize()`, `dropDuplicateHeading()` and the EPUB code can use unchanged.

## 1. Rules for each site

Keep rules per host, saying which element holds the body, what to strip, and which page
to fetch instead:

```
# sites/example.com.txt
body:  //div[@class="article-body"]
strip: //aside | //div[contains(@class,"newsletter")]
single_page_link: //a[@rel="next-all"]
```

- **Existing rule set:** [fivefilters/ftr-site-config](https://github.com/fivefilters/ftr-site-config)
  has rules for about 2,000 sites. Wallabag and FreshRSS use it. You could vendor it, or
  pull it on a schedule.
- **Good:** the result is exact and predictable, and a bad site is fixed with one line
  of config.
- **Bad:** someone has to maintain the rules, and they break when a site is redesigned.
  The format is XPath, which jsdom supports through `document.evaluate`.
- Allow local overrides, for example a `SITE_RULES_DIR` directory checked before the
  vendored set.

## 2. Structured data and markup that says where the body is

Many pages mark their own body. Check these before any guessing:

- JSON-LD `articleBody`. `collectJsonLd()` already parses the JSON-LD. The field is
  often plain text, so it is best used to **check** a candidate rather than as the
  content itself.
- Microdata `[itemprop="articleBody"]`, or `[itemtype*="Article"] [itemprop=articleBody]`.
- A single `<article>` element, `[role="article"]`, or common CMS classes
  (`.entry-content` for WordPress, `.post-content` for Ghost, `.available-content` for
  Substack, `.body.markup` on Substack).
- **Good:** cheap and exact when present. **Bad:** coverage varies and some sites use
  the markup wrongly.

## 3. A better version of the same page

Often the site offers a cleaner copy of the article somewhere else:

- **AMP:** `<link rel="amphtml">`. The markup is minimal and the body is almost always
  in the static HTML.
- **Feeds:** `content:encoded` or Atom `<content>` usually holds the full text.
  `rss.ts` already parses feeds, so a feed item could skip the page fetch entirely.
- **APIs by platform:** WordPress (`/wp-json/wp/v2/posts?slug=…` gives
  `content.rendered`), Ghost Content API, Medium (`?format=json`), and the Substack API.
  Detect the platform from `<meta name="generator">`.
- **Print views and "single page" links** for articles split across several pages.

## 4. Other general-purpose extraction libraries

Readability is one scoring method among several, and each fails in different ways:

| Library | Lang | Notes |
|---|---|---|
| `@mozilla/readability` | JS | Current choice. The same code as Firefox Reader View. |
| `defuddle` | JS | Written for the Obsidian Web Clipper. Keeps footnotes, code and math better, and looks at mobile CSS to find page chrome. |
| `@postlight/parser` (Mercury) | JS | Includes custom extractors for many big sites, plus combining multi-page articles. Maintained less often. |
| `@extractus/article-extractor` | JS | Lightweight. Supports site-specific transforms. |
| `trafilatura` | Python | Scores near the top in extraction benchmarks. Would need a sidecar process. |

**Ensemble:** run two or three of these and score each result on word count, link
density (link text divided by all text), ratio of text to tags, overlap with the JSON-LD
`articleBody` or `og:description`, and whether it contains the headline. Keep the best
one. This removes most "we got the comments section" failures.

## 5. Render JavaScript before extracting

Some pages, such as SPAs and lazy-loaded bodies, have almost no article text in the raw
HTML. Load them in headless Chromium with Playwright, wait for the network to go idle,
and then extract from `page.content()`.

- Use it **only as a fallback**, when the static extraction fails the
  `textContent.length < 120` check or the quality score.
- **Cost:** about 300 MB more in the Docker image, and more CPU per article. SSRF
  protection gets harder too: every request the browser makes needs to go through the
  same private-address check, using `page.route()`.

## 6. Learn the template from pages on the same site

Page chrome (nav, footer, sidebars, "related") is identical across pages on the same
site, and the article is what differs. Fetch one other article from the same host (from
a link on the page or from its feed), line up the DOMs, and drop subtrees that are the
same in both. What is left is the body. Save the resulting selector for that host so
later articles skip the second fetch.

- **Good:** works without any rules. **Bad:** an extra fetch, and more complex.

## 7. Ask an LLM for the selector (and cache it)

Send a pruned outline of the DOM to an LLM: tag, id, class, word count and link density
for each node, with no text. Ask it for a CSS selector for the body and a list of
selectors to strip. Check the answer (the selector matches, the text is long enough, it
contains the headline) and **cache it per host**. That way it is one call per site, not
one per article.

- **Good:** handles unusual sites and turns them into option 1 automatically.
  **Bad:** needs an API key, adds a paid dependency, and needs a check so a bad answer
  is not saved.

## 8. Let the user's browser send the HTML

The existing bookmarklet or share shortcut could POST the page as the user's browser has
already rendered it (`document.documentElement.outerHTML`, or only the current text
selection) instead of just the URL. This handles logins, paywalls the user pays for, bot
walls and JS rendering at no server cost. On iOS, a Shortcuts "Run JavaScript on Web
Page" action can do the same thing.

## Recommended pipeline

```
fetch
  ├─ 1. site rule for host?            → use it
  ├─ 2. itemprop=articleBody / platform API / AMP / feed content
  ├─ 4. Readability (+ defuddle) → score candidates, keep best
  ├─    quality gate failed?
  │     ├─ 5. headless render and retry 2–4
  │     └─ 7. (optional) LLM selector → validate → save as a site rule
  └─ sanitize → EPUB
plus 8. the bookmarklet can send pre-rendered HTML, which skips the fetch
```

A sensible order to build it in:

1. Add a `extractors/` interface (`(doc, url) => Candidate | null`).
2. Add a scoring function (step 4).
3. Add the structured-data and platform checks (step 2), which are cheap.
4. Load the ftr-site-config rules (step 1).
5. Add headless rendering or the LLM step later, only if the failure logs show they are
   needed.

Record which extractor won each article in the database, so failures can be traced to a
cause.
