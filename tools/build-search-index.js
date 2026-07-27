#!/usr/bin/env node
/*
 * Builds search-index.json from the exported HTML pages.
 *
 * Webflow's site search is a hosted feature: on webflow.io the /search route is
 * rendered server-side. A static export keeps the search *form* but drops the
 * results markup and the backend, so search silently returns nothing. This
 * script produces the index that js/site-search.js queries in the browser.
 *
 * Run it after every Webflow re-export, then commit the result:
 *
 *   node tools/build-search-index.js
 *
 * No dependencies - it runs on a bare Node install so the Railway build stays
 * a plain static deploy.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'search-index.json');

// Directories that never contain indexable pages.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'css', 'js', 'images', 'fonts', 'tools']);

// Pages deliberately kept out of results. Error and utility pages are not
// destinations; the rest are scratch/duplicate pages left over from the
// template. Add to this list rather than deleting pages - a Webflow re-export
// would bring them back.
const EXCLUDE = new Set([
  '401.html',
  '404.html',
  'search.html',
  'company/blog-section.html',
  'footer/stuff-from-homepage.html',
  'pricing/pricing-1-copy.html',
]);

// Stub pages (a heading and nothing else) add noise without ever being a useful
// result, so drop anything with less body text than this.
const MIN_BODY_CHARS = 200;

// Cap per-page body text. The privacy policy alone is ~35 KB of prose, which
// would dominate the index for no ranking benefit - matches that far down a
// page are not worth the transfer cost on every search.
const MAX_BODY_CHARS = 8000;

// Site-name suffixes in <title>. Repeating the site name on every result is
// noise. Covers both the unreplaced Webflow template boilerplate and the
// "· NFC Lab" convention the rebranded pages use.
const TITLE_SUFFIX = / *[·|] *(?:Module *[–-] *Webflow HTML website template|NFC Lab) *$/i;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Chrome shared by every page. Indexing it would make "contact" or "pricing"
// match all 27 pages equally. Matched against individual class tokens, plus
// ARIA landmarks - the site has two generations of nav/footer markup
// (navbar-bg/footer-wrap on the newer pages, navbar/footer-black on the older
// template pages) and the landmarks are the one thing common to both.
const DROP_CLASS_TOKENS = new Set([
  'navbar', 'navbar-bg', 'navbar-wrap', 'navbar-container', 'navbar-script', 'navbar-styles',
  'w-nav', 'w-nav-menu', 'w-nav-button', 'mega-menu-items-wrap',
  'footer', 'footer-wrap', 'footer-black', 'footer-info-wrap',
  'preloader',
]);
const DROP_ROLES = new Set(['banner', 'contentinfo', 'navigation']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', copy: '©',
  reg: '®', trade: '™', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·',
  eacute: 'é', egrave: 'è', deg: '°', pound: '£',
  euro: '€', times: '×', shy: '',
};

function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Lone surrogates and out-of-range values would corrupt the JSON.
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ' ';
      if (code >= 0xd800 && code <= 0xdfff) return ' ';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Tags become spaces so adjacent blocks do not run their words together.
function stripTags(html) {
  return collapse(decodeEntities(html.replace(/<[^>]*>/g, ' ')));
}

function collapse(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function classTokens(attrs) {
  const match = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs) || /\bclass\s*=\s*'([^']*)'/i.exec(attrs);
  return match ? match[1].trim().split(/\s+/) : [];
}

function roleOf(attrs) {
  const match = /\brole\s*=\s*"([^"]*)"/i.exec(attrs) || /\brole\s*=\s*'([^']*)'/i.exec(attrs);
  return match ? match[1].trim().toLowerCase() : '';
}

function shouldDrop(attrs) {
  if (DROP_ROLES.has(roleOf(attrs))) return true;
  return classTokens(attrs).some((token) => DROP_CLASS_TOKENS.has(token));
}

/*
 * Returns the page's <body> with script/style blocks and the site chrome
 * removed. Walks tags keeping a depth counter so a dropped element takes its
 * whole subtree with it - Webflow output is well-formed, which is what makes
 * this workable without a real parser.
 */
function contentHtml(html) {
  let body = html;
  const bodyOpen = /<body\b[^>]*>/i.exec(body);
  if (bodyOpen) body = body.slice(bodyOpen.index + bodyOpen[0].length);
  const bodyClose = body.search(/<\/body\s*>/i);
  if (bodyClose !== -1) body = body.slice(0, bodyClose);

  // Removed up front: their contents are not markup, so the tag scanner below
  // would misread any '<' inside them.
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const kept = [];
  let depth = 0;
  let dropDepth = -1;
  let cursor = 0;
  let match;

  while ((match = tagRe.exec(body)) !== null) {
    const [full, closing, rawTag, rawAttrs = ''] = match;
    const tag = rawTag.toLowerCase();
    const selfClosing = VOID_TAGS.has(tag) || /\/\s*$/.test(rawAttrs);

    if (closing) {
      if (VOID_TAGS.has(tag)) continue;
      depth = Math.max(0, depth - 1);
      if (dropDepth !== -1 && depth <= dropDepth) {
        // End of the dropped subtree - resume keeping text after this tag.
        dropDepth = -1;
        cursor = match.index + full.length;
      }
      continue;
    }

    if (dropDepth === -1 && shouldDrop(rawAttrs)) {
      kept.push(body.slice(cursor, match.index));
      // A self-closing element has no subtree, so skip only the tag itself.
      if (selfClosing) cursor = match.index + full.length;
      else dropDepth = depth;
    }

    if (!selfClosing) depth += 1;
  }

  if (dropDepth === -1) kept.push(body.slice(cursor));
  return kept.join(' ');
}

function extractHeadings(html) {
  const headings = [];
  const seen = new Set();
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = stripTags(match[2]);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    headings.push(text);
  }
  return headings;
}

function metaContent(html, attr, value) {
  // Webflow writes content= before name=/property=, so match either order.
  const patterns = [
    new RegExp(`<meta[^>]*\\b${attr}\\s*=\\s*"${value}"[^>]*\\bcontent\\s*=\\s*"([^"]*)"`, 'i'),
    new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*"([^"]*)"[^>]*\\b${attr}\\s*=\\s*"${value}"`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return collapse(decodeEntities(match[1]));
  }
  return '';
}

function isNoIndex(html) {
  const robots = metaContent(html, 'name', 'robots');
  return /\bnoindex\b/i.test(robots);
}

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

function buildDoc(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (EXCLUDE.has(rel)) return { rel, skipped: 'excluded' };

  const html = fs.readFileSync(file, 'utf8');
  if (isNoIndex(html)) return { rel, skipped: 'noindex' };

  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = rawTitle
    ? collapse(decodeEntities(rawTitle[1])).replace(TITLE_SUFFIX, '').trim()
    : '';

  const content = contentHtml(html);
  const headings = extractHeadings(content);
  const text = stripTags(content);

  if (text.length < MIN_BODY_CHARS) return { rel, skipped: 'too short' };

  const description =
    metaContent(html, 'name', 'description') ||
    metaContent(html, 'property', 'og:description');

  return {
    rel,
    doc: {
      url: '/' + rel,
      title: title || headings[0] || rel,
      description,
      headings: headings.slice(0, 20),
      text: text.slice(0, MAX_BODY_CHARS),
    },
  };
}

function main() {
  const files = walk(ROOT).sort();
  const docs = [];
  const skipped = [];

  for (const file of files) {
    const result = buildDoc(file);
    if (result.skipped) skipped.push(`${result.rel} (${result.skipped})`);
    else docs.push(result.doc);
  }

  fs.writeFileSync(OUT, JSON.stringify({ pages: docs }) + '\n', 'utf8');

  const bytes = fs.statSync(OUT).size;
  console.log(`Indexed ${docs.length} pages -> ${path.relative(ROOT, OUT)} (${(bytes / 1024).toFixed(1)} KB)`);
  if (skipped.length) console.log(`Skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
}

main();
