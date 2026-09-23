/**
 * Feeds worth trying, grouped. Every URL here answered with a real RSS/Atom document
 * when the list was made (2026-09-23); a source that stopped is a bug in this file.
 * `paywall` marks sources whose full text usually needs a subscription — they still
 * work as prospects, and a stub that slips through is flagged at conversion.
 */
export interface FeedSuggestion {
  url: string;
  title: string;
  note?: string;
  tags: string;
  paywall?: boolean;
}

export interface FeedCategory {
  name: string;
  blurb: string;
  feeds: FeedSuggestion[];
}

export const FEED_SUGGESTIONS: FeedCategory[] = [
  {
    name: 'Aggregators',
    blurb: 'Other people’s front pages. Expect a third of items to be repos, PDFs or videos that will not convert.',
    feeds: [
      { url: 'https://hnrss.org/frontpage?points=150', title: 'Hacker News, 150+ points', note: 'only what held the front page', tags: 'hn' },
      { url: 'https://hnrss.org/best', title: 'Hacker News, best', note: 'slower-moving', tags: 'hn' },
      { url: 'https://lobste.rs/rss', title: 'Lobsters', note: 'HN’s quieter, more technical cousin', tags: 'tech' },
    ],
  },
  {
    name: 'Longform & essays',
    blurb: 'What an e-reader is actually for: one column of text and a few images.',
    feeds: [
      { url: 'https://en.wikipedia.org/w/api.php?action=featuredfeed&feed=featured&feedformat=atom', title: 'Wikipedia featured article', note: 'one long, well-written article a day', tags: 'wikipedia longread' },
      { url: 'https://aeon.co/feed.rss', title: 'Aeon', note: 'philosophy, science, culture', tags: 'longread essay' },
      { url: 'https://nautil.us/feed/', title: 'Nautilus', note: 'science essays', tags: 'longread science' },
      { url: 'https://longreads.com/feed/', title: 'Longreads', note: 'curated from everywhere', tags: 'longread' },
      { url: 'https://longform.org/feed', title: 'Longform.org', tags: 'longread' },
      { url: 'https://www.themarginalian.org/feed/', title: 'The Marginalian', note: 'Maria Popova on books and ideas', tags: 'longread culture' },
      { url: 'https://waitbutwhy.com/feed', title: 'Wait But Why', note: 'rare, very long', tags: 'longread' },
      { url: 'https://fs.blog/feed/', title: 'Farnam Street', tags: 'ideas' },
      { url: 'https://www.raptitude.com/feed/', title: 'Raptitude', tags: 'ideas' },
      { url: 'https://www.atlasobscura.com/feeds/latest', title: 'Atlas Obscura', tags: 'culture' },
      { url: 'https://www.smithsonianmag.com/rss/latest_articles/', title: 'Smithsonian Magazine', tags: 'history science' },
      { url: 'https://lithub.com/feed/', title: 'Literary Hub', tags: 'books' },
      { url: 'https://www.mcsweeneys.net/rss', title: 'McSweeney’s', note: 'short, funny', tags: 'fun' },
      { url: 'https://www.newyorker.com/feed/everything', title: 'The New Yorker', tags: 'longread', paywall: true },
    ],
  },
  {
    name: 'Technology',
    blurb: 'Features and analysis rather than the news firehose where a choice exists.',
    feeds: [
      { url: 'https://feeds.arstechnica.com/arstechnica/features', title: 'Ars Technica, features only', tags: 'tech longread' },
      { url: 'https://arstechnica.com/feed/', title: 'Ars Technica, everything', tags: 'tech news' },
      { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', tags: 'tech news' },
      { url: 'https://www.technologyreview.com/feed/', title: 'MIT Technology Review', tags: 'tech' },
      { url: 'https://spectrum.ieee.org/feeds/feed.rss', title: 'IEEE Spectrum', tags: 'tech engineering' },
      { url: 'https://hackaday.com/blog/feed/', title: 'Hackaday', tags: 'hardware' },
      { url: 'https://www.404media.co/rss/', title: '404 Media', note: 'some posts members-only', tags: 'tech', paywall: true },
      { url: 'https://daringfireball.net/feeds/main', title: 'Daring Fireball', note: 'many items are links, not articles', tags: 'apple' },
      { url: 'https://stratechery.com/feed/', title: 'Stratechery', note: 'weekly free article', tags: 'tech business', paywall: true },
      { url: 'https://www.wired.com/feed/rss', title: 'Wired', tags: 'tech', paywall: true },
    ],
  },
  {
    name: 'Programming',
    blurb: 'Individual writers first — they convert best and post rarely.',
    feeds: [
      { url: 'https://danluu.com/atom.xml', title: 'Dan Luu', tags: 'programming longread' },
      { url: 'https://jvns.ca/atom.xml', title: 'Julia Evans', tags: 'programming' },
      { url: 'https://simonwillison.net/atom/everything/', title: 'Simon Willison', note: 'frequent, short', tags: 'programming ai' },
      { url: 'https://newsletter.pragmaticengineer.com/feed', title: 'The Pragmatic Engineer', note: 'paid posts give a teaser', tags: 'engineering', paywall: true },
      { url: 'https://martinfowler.com/feed.atom', title: 'Martin Fowler', tags: 'programming' },
      { url: 'https://www.joelonsoftware.com/feed/', title: 'Joel on Software', tags: 'programming' },
      { url: 'https://overreacted.io/rss.xml', title: 'Overreacted (Dan Abramov)', tags: 'programming' },
      { url: 'https://kentcdodds.com/blog/rss.xml', title: 'Kent C. Dodds', tags: 'programming' },
      { url: 'https://www.smashingmagazine.com/feed/', title: 'Smashing Magazine', tags: 'web' },
      { url: 'https://stackoverflow.blog/feed/', title: 'Stack Overflow Blog', tags: 'programming' },
      { url: 'https://github.blog/feed/', title: 'GitHub Blog', tags: 'programming' },
      { url: 'https://blog.cloudflare.com/rss/', title: 'Cloudflare Blog', note: 'deep, long', tags: 'infrastructure' },
      { url: 'https://engineering.fb.com/feed/', title: 'Engineering at Meta', tags: 'engineering' },
      { url: 'https://netflixtechblog.com/feed', title: 'Netflix Tech Blog', tags: 'engineering' },
      { url: 'https://lwn.net/headlines/rss', title: 'LWN', note: 'features free after a week', tags: 'linux', paywall: true },
      { url: 'https://this-week-in-rust.org/rss.xml', title: 'This Week in Rust', tags: 'rust' },
      { url: 'https://blog.rust-lang.org/feed.xml', title: 'Rust Blog', tags: 'rust' },
      { url: 'https://go.dev/blog/feed.atom', title: 'Go Blog', tags: 'go' },
      { url: 'https://nodejs.org/en/feed/blog.xml', title: 'Node.js Blog', tags: 'node' },
    ],
  },
  {
    name: 'Security',
    blurb: '',
    feeds: [
      { url: 'https://krebsonsecurity.com/feed/', title: 'Krebs on Security', tags: 'security' },
      { url: 'https://www.schneier.com/feed/atom/', title: 'Schneier on Security', tags: 'security' },
    ],
  },
  {
    name: 'Science',
    blurb: '',
    feeds: [
      { url: 'https://www.quantamagazine.org/feed/', title: 'Quanta Magazine', note: 'maths and physics, superb on e-ink', tags: 'science longread' },
      { url: 'https://www.sciencedaily.com/rss/all.xml', title: 'ScienceDaily', note: 'high volume', tags: 'science' },
      { url: 'https://phys.org/rss-feed/', title: 'Phys.org', note: 'high volume', tags: 'science' },
    ],
  },
  {
    name: 'Economics & ideas',
    blurb: '',
    feeds: [
      { url: 'https://www.bitsaboutmoney.com/archive/rss/', title: 'Bits about Money', note: 'Patrick McKenzie, long', tags: 'finance longread' },
      { url: 'https://www.marginalrevolution.com/feed', title: 'Marginal Revolution', note: 'many short link posts', tags: 'economics' },
      { url: 'https://astralcodexten.substack.com/feed', title: 'Astral Codex Ten', tags: 'ideas longread' },
      { url: 'https://www.lesswrong.com/feed.xml', title: 'LessWrong', tags: 'ideas' },
      { url: 'https://pluralistic.net/feed/', title: 'Pluralistic (Cory Doctorow)', note: 'daily, long', tags: 'ideas' },
      { url: 'https://seths.blog/feed/', title: 'Seth Godin', note: 'daily, very short', tags: 'ideas' },
      { url: 'https://www.mrmoneymustache.com/feed/', title: 'Mr. Money Mustache', tags: 'finance' },
    ],
  },
  {
    name: 'News',
    blurb: 'High volume. Better as a shelf you dip into than a queue you clear.',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC News', tags: 'news' },
      { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian, world', tags: 'news' },
      { url: 'https://www.theguardian.com/uk/technology/rss', title: 'The Guardian, technology', tags: 'news tech' },
      { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR', tags: 'news' },
      { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera', tags: 'news' },
      { url: 'https://www.propublica.org/feeds/propublica/main', title: 'ProPublica', note: 'investigations, long', tags: 'news longread' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'The New York Times', tags: 'news', paywall: true },
      { url: 'https://feeds.washingtonpost.com/rss/world', title: 'The Washington Post, world', tags: 'news', paywall: true },
      { url: 'https://www.ft.com/rss/home', title: 'Financial Times', tags: 'news finance', paywall: true },
      { url: 'https://www.economist.com/the-economist-explains/rss.xml', title: 'The Economist explains', tags: 'news', paywall: true },
    ],
  },
  {
    name: 'Danish',
    blurb: '',
    feeds: [
      { url: 'https://www.dr.dk/nyheder/service/feeds/allenyheder', title: 'DR Nyheder', tags: 'dk news' },
      { url: 'https://politiken.dk/rss/senestenyt.rss', title: 'Politiken', tags: 'dk news', paywall: true },
      { url: 'https://www.information.dk/feed', title: 'Information', tags: 'dk news', paywall: true },
      { url: 'https://ing.dk/rss', title: 'Ingeniøren', note: 'PRO articles are stubs', tags: 'dk tech', paywall: true },
      { url: 'https://www.version2.dk/rss', title: 'Version2', note: 'PRO articles are stubs', tags: 'dk tech', paywall: true },
    ],
  },
  {
    name: 'Games & fun',
    blurb: '',
    feeds: [
      { url: 'https://www.rockpapershotgun.com/feed', title: 'Rock Paper Shotgun', tags: 'games' },
      { url: 'https://www.eurogamer.net/feed', title: 'Eurogamer', tags: 'games' },
      { url: 'https://xkcd.com/atom.xml', title: 'xkcd', note: 'one image; the alt text is the joke', tags: 'fun' },
      { url: 'https://www.oglaf.com/feeds/rss/', title: 'Oglaf', note: 'NSFW', tags: 'fun' },
      { url: 'https://www.theonion.com/rss', title: 'The Onion', tags: 'fun' },
    ],
  },
];
