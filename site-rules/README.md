# Site rules

Rules for sites where general-purpose extraction (Readability) picks the wrong part
of the page. They use the [FiveFilters / ftr-site-config](https://github.com/fivefilters/ftr-site-config)
format, so rules from that collection work unchanged.

## Where rules are read from

`SITE_RULES_DIRS` is a comma-separated list of directories, searched in order. When it
is unset, the defaults are:

1. `$DATA_DIR/site-rules`: your own rules. They survive upgrades.
2. This directory (`site-rules/` in the app): rules shipped with opds-feed.

To use the whole FiveFilters collection, clone it and add it after your own directory:

```bash
git clone --depth 1 https://github.com/fivefilters/ftr-site-config data/ftr-site-config
SITE_RULES_DIRS=./data/site-rules,./data/ftr-site-config,./site-rules
```

## File names

The file name is the host plus `.txt`, with any leading `www.` removed:

| File | Matches |
|---|---|
| `example.com.txt` | `example.com`, `www.example.com` |
| `.example.com.txt` | any subdomain, e.g. `blog.example.com` |

The most specific name wins. If two directories have a file with the same name, the
one in the earlier directory wins.

## Directives

```
# The article body. Several `body:` lines are tried in order; the first that matches wins.
# If an expression matches several elements, they are joined in page order.
body: //div[contains(concat(' ',normalize-space(@class),' '),' article-body ')]

# Optional metadata. These win over the page's own meta tags.
title: //h1[@class='headline']
author: //a[@rel='author']
date: //time/@datetime

# Removed before the body is taken.
strip: //aside
strip: //div[@class='newsletter-signup']
strip_id_or_class: related
strip_image_src: /tracking-pixel.gif

# Plain-text replacements in the raw HTML, applied before anything else.
find_string: <br /><br />
replace_string: </p><p>
replace_string(<noscript>): <div>
```

Expressions are XPath 1.0. Other ftr-site-config directives (`prune`, `tidy`,
`single_page_link`, `http_header`, `test_url`, …) are accepted and ignored.

A rule without a `body:` line is skipped. If no `body:` expression matches, the next
step in the chain (Readability) takes over, and the log line
`site rule body did not match` names the rule file so you can fix it.
