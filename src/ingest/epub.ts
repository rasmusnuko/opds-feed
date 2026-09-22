import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { escapeXml, formatDate, stripControlChars } from '../util/text.js';
import type { PreparedImage } from './images.js';

const VOID_ELEMENTS = new Set(['br', 'hr', 'img']);

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_CDATA = 4;

/**
 * Serialises the sanitised DOM as XML rather than HTML. An EPUB content document must be
 * well-formed XHTML -- an unclosed <br> or a bare & makes strict readers reject the file.
 */
function serializeXml(node: Node): string {
  switch (node.nodeType) {
    case NODE_TEXT:
    case NODE_CDATA:
      return escapeXml(node.nodeValue ?? '');
    case NODE_ELEMENT: {
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      const attributes = [...element.attributes]
        .map((attribute) => ` ${attribute.name.toLowerCase()}="${escapeXml(attribute.value)}"`)
        .join('');

      if (VOID_ELEMENTS.has(tag)) return `<${tag}${attributes}/>`;

      const children = [...element.childNodes].map(serializeXml).join('');
      return `<${tag}${attributes}>${children}</${tag}>`;
    }
    default:
      return ''; // comments, processing instructions, doctypes
  }
}

export function serializeBody(content: Element): string {
  return stripControlChars([...content.childNodes].map(serializeXml).join(''));
}

export interface EpubInput {
  id: string;
  title: string;
  author: string | null;
  site: string | null;
  language: string;
  sourceUrl: string;
  publishedAt: string | null;
  addedAt: string;
  readingMinutes: number;
  wordCount: number;
  bodyXhtml: string;
  images: PreparedImage[];
  cover: Buffer;
}

const STYLESHEET = `@charset "utf-8";

body {
  margin: 0 5%;
  line-height: 1.45;
  text-align: left;
  widows: 2;
  orphans: 2;
}

h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1em 0 0.4em; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.1em; }

p { margin: 0 0 0.75em; }

a { text-decoration: none; }

.byline {
  margin: 0 0 0.35em;
  font-size: 0.9em;
}

.meta {
  margin: 0 0 1.5em;
  font-size: 0.8em;
  border-bottom: 1px solid #999999;
  padding-bottom: 0.75em;
  word-wrap: break-word;
}

blockquote {
  margin: 0.8em 1.2em;
  padding-left: 0.6em;
  border-left: 2px solid #999999;
  font-style: italic;
}

pre {
  font-size: 0.85em;
  white-space: pre-wrap;
  word-wrap: break-word;
}

code { font-size: 0.9em; }

img {
  max-width: 100%;
  height: auto;
}

figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.8em; font-style: italic; margin-top: 0.3em; }

table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
th, td { border: 1px solid #999999; padding: 0.25em 0.4em; text-align: left; }

hr { border: 0; border-top: 1px solid #999999; margin: 1.5em 0; }

.cover { margin: 0; padding: 0; text-align: center; }
.cover img { max-width: 100%; max-height: 100%; }
`;

function xhtmlDocument(title: string, language: string, body: string, bodyClass?: string): string {
  const classAttribute = bodyClass ? ` class="${escapeXml(bodyClass)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(
    language,
  )}" xml:lang="${escapeXml(language)}">
  <head>
    <meta charset="utf-8"/>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body${classAttribute}>
${body}
  </body>
</html>
`;
}

function opf(input: EpubInput, uuid: string, modified: string): string {
  const imageItems = input.images
    .map(
      (image, index) =>
        `    <item id="img${index + 1}" href="${escapeXml(image.href)}" media-type="${image.mediaType}"/>`,
    )
    .join('\n');

  const creator = input.author ?? input.site ?? 'Unknown';
  const dateLine = input.publishedAt
    ? `    <dc:date>${escapeXml(input.publishedAt)}</dc:date>\n`
    : `    <dc:date>${escapeXml(input.addedAt)}</dc:date>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(
    input.language,
  )}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
    <dc:creator>${escapeXml(creator)}</dc:creator>
    <dc:language>${escapeXml(input.language)}</dc:language>
    <dc:source>${escapeXml(input.sourceUrl)}</dc:source>
${dateLine}${input.site ? `    <dc:publisher>${escapeXml(input.site)}</dc:publisher>\n` : ''}    <meta property="dcterms:modified">${modified}</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="content" href="article.xhtml" media-type="application/xhtml+xml"/>
${imageItems}${imageItems ? '\n' : ''}  </manifest>
  <spine toc="ncx">
    <itemref idref="cover" linear="no"/>
    <itemref idref="content"/>
  </spine>
  <guide>
    <reference type="cover" title="Cover" href="cover.xhtml"/>
    <reference type="text" title="Article" href="article.xhtml"/>
  </guide>
</package>
`;
}

function ncx(title: string, uuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${escapeXml(title)}</text></navLabel>
      <content src="article.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`;
}

function navDocument(title: string, language: string): string {
  const body = `    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
        <li><a href="article.xhtml">${escapeXml(title)}</a></li>
      </ol>
    </nav>`;
  return xhtmlDocument(title, language, body);
}

function articleDocument(input: EpubInput): string {
  const metaBits = [
    input.site,
    formatDate(input.publishedAt),
    `${input.readingMinutes} min read`,
    `${input.wordCount} words`,
  ].filter((bit): bit is string => Boolean(bit && bit.length > 0));

  const byline = input.author
    ? `    <p class="byline">${escapeXml(input.author)}</p>\n`
    : '';

  const body = `    <h1>${escapeXml(input.title)}</h1>
${byline}    <p class="meta">${escapeXml(metaBits.join(' · '))}<br/>
      <a href="${escapeXml(input.sourceUrl)}">${escapeXml(input.sourceUrl)}</a>
    </p>
${input.bodyXhtml}`;

  return xhtmlDocument(input.title, input.language, body);
}

function coverDocument(title: string, language: string): string {
  const body = `    <div class="cover"><img src="cover.jpg" alt="${escapeXml(title)}"/></div>`;
  return xhtmlDocument(title, language, body, 'cover');
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

export async function buildEpub(input: EpubInput): Promise<Buffer> {
  const uuid = randomUUID();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const zip = new JSZip();

  // The spec requires `mimetype` to be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('OEBPS/content.opf', opf(input, uuid, modified));
  zip.file('OEBPS/toc.ncx', ncx(input.title, uuid));
  zip.file('OEBPS/nav.xhtml', navDocument(input.title, input.language));
  zip.file('OEBPS/style.css', STYLESHEET);
  zip.file('OEBPS/cover.xhtml', coverDocument(input.title, input.language));
  zip.file('OEBPS/article.xhtml', articleDocument(input));
  zip.file('OEBPS/cover.jpg', input.cover);

  for (const image of input.images) {
    zip.file(`OEBPS/${image.href}`, image.data);
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}
