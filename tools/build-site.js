#!/usr/bin/env node
/*
 * Stages the deployable site into dist/.
 *
 * The Webflow export lands in the repo root, alongside everything the repo
 * carries for its own sake - the Worker, the form handler, this script, the
 * docs. Cloudflare uploads an asset directory wholesale, so the two have to be
 * separated before deploying. dist/ is that separation: it holds the site and
 * nothing else.
 *
 * Pointing Cloudflare at the repo root instead was tried and rejected. Beyond
 * needing an ignore list that silently ships anything it forgets, wrangler
 * watches its asset directory during `wrangler dev` - and its own .wrangler/
 * state lives in the root, so every request reloaded the server in a loop.
 *
 * Run after a Webflow re-export, before deploying:
 *
 *   node tools/build-site.mjs
 *
 * No dependencies, and dist/ is gitignored - it is a build artefact, rebuilt
 * from the repo on every deploy.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/*
 * Pages kept out of sitemap.xml.
 *
 * Deliberately a shorter list than the one in build-search-index.js. That
 * script is answering "would this be a useful search result"; this one is
 * answering "is this a page we want crawled", and the orphaned pages are
 * exactly what we most want in here - nothing links to them, so the sitemap is
 * the only way a crawler finds them at all.
 *
 * What is excluded: the error pages, the post-submit confirmation, the search
 * page itself (a deep link by design, and an indexed search page is just an
 * empty results screen), and the template leftovers that were never real
 * pages.
 */
const SITEMAP_EXCLUDE = new Set([
  '401.html',
  '404.html',
  'search.html',
  'support/thank-you.html',
  'company/blog-section.html',
  'footer/stuff-from-homepage.html',
  'pricing/pricing-1-copy.html',
]);

/*
 * Top-level entries that are not the site.
 *
 * An exclude list rather than an include list on purpose: a re-export that adds
 * a new page or folder should ship without anyone remembering to list it, and
 * the failure mode of forgetting to exclude something is caught by the DENIED
 * list in worker/index.js, which refuses these paths a second time.
 */
const EXCLUDE = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.assetsignore',
  '.wrangler',
  '.vscode',
  '.idea',
  'node_modules',
  'dist',
  'worker',
  'api',
  'tools',
  'docs',
  'README.md',
  'package.json',
  'package-lock.json',
  'wrangler.jsonc',
  'wrangler.toml',
  '_external',
  // Left over from the Railway deploy; excluded so it cannot be served even
  // while it is still in the repo.
  'Caddyfile',
  'Staticfile',
]);

/** Anything matching these is skipped at any depth. */
const EXCLUDE_ANYWHERE = [/^\.dev\.vars/, /^\.DS_Store$/, /^Thumbs\.db$/, /^node_modules$/];

function excluded(name, depth) {
  if (EXCLUDE_ANYWHERE.some((pattern) => pattern.test(name))) return true;
  return depth === 0 && EXCLUDE.has(name);
}

function copyDir(from, to, depth) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (excluded(entry.name, depth)) continue;

    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);

    if (entry.isDirectory()) copyDir(src, dest, depth + 1);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
    // Symlinks and device files are not something a Webflow export produces;
    // skipping them keeps anything odd out of the upload.
  }
}

function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = countFiles(full);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

/*
 * Empty dist/ by deleting its children rather than the directory itself.
 *
 * `wrangler dev` watches the asset directory and holds a handle on it, so
 * removing the directory fails with EPERM on Windows while a dev server is
 * running - which is exactly when someone is most likely to rebuild.
 */
function emptyDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

// ---------------------------------------------------------------------------
// sitemap.xml and robots.txt
//
// Webflow generated both on its own hosting and neither is part of an export,
// so self-hosting lost them silently. Generated here rather than committed so
// they cannot drift out of date the way search-index.json can - that one is a
// committed artefact that has to be rebuilt by hand after a re-export, and
// this is the same trap avoided.
// ---------------------------------------------------------------------------

/** The canonical origin, read from wrangler.jsonc so the two cannot disagree. */
function canonicalOrigin() {
  const config = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const match = config.match(/"CANONICAL_HOST"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error('CANONICAL_HOST not found in wrangler.jsonc');
  return `https://${match[1]}`;
}

/**
 * Last commit date per file, as one `git log` pass rather than a call per page.
 *
 * The mtime in dist/ is useless here - every file was copied moments ago, so
 * it would date the whole site to the last deploy. If git is unavailable the
 * map comes back empty and the entries simply carry no <lastmod>, which is
 * valid and better than a date that is wrong.
 */
function lastModifiedByFile() {
  const dates = new Map();
  try {
    const log = execFileSync('git', ['log', '--format=%cI', '--name-only', '--no-renames'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    let current = null;
    for (const line of log.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) current = trimmed;
      else if (current && !dates.has(trimmed)) dates.set(trimmed, current);
    }
  } catch {
    // Not a git checkout, or git is not installed. No lastmod, no problem.
  }
  return dates;
}

function htmlPages(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    if (entry.isDirectory()) out.push(...htmlPages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

function writeSitemap() {
  const origin = canonicalOrigin();
  const modified = lastModifiedByFile();

  const pages = htmlPages(DIST)
    .filter((rel) => !SITEMAP_EXCLUDE.has(rel))
    // Respect the page's own wishes. Several template pages carry noindex, and
    // a sitemap entry for a noindexed page is a contradiction crawlers report.
    .filter((rel) => !/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(
      fs.readFileSync(path.join(DIST, rel), 'utf8').slice(0, 4000),
    ))
    .sort();

  const urls = pages.map((rel) => {
    // The export links internally with the .html extension, so that is the form
    // to advertise - listing the extensionless twin would put two URLs for one
    // page in front of the crawler, which is the duplicate-content problem the
    // canonical redirect exists to avoid.
    const loc = `${origin}/${rel === 'index.html' ? '' : rel}`;
    const lastmod = modified.get(rel);
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      '  </url>',
    ].join('\n');
  });

  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
  );

  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    [
      'User-agent: *',
      'Allow: /',
      '',
      '# Not destinations: the API, and the search page, which only ever renders',
      '# an empty results screen without a query.',
      'Disallow: /api/',
      'Disallow: /search.html',
      '',
      `Sitemap: ${canonicalOrigin()}/sitemap.xml`,
      '',
    ].join('\n'),
  );

  return { pages: pages.length, dated: pages.filter((p) => modified.has(p)).length };
}

emptyDir(DIST);
copyDir(ROOT, DIST, 0);

const sitemap = writeSitemap();

const { files, bytes } = countFiles(DIST);
console.log(`dist/  ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`       sitemap.xml: ${sitemap.pages} pages (${sitemap.dated} with lastmod), robots.txt`);

// The site search fetches this at runtime; without it every query returns
// nothing, and it is generated by a separate script that is easy to forget.
if (!fs.existsSync(path.join(DIST, 'search-index.json'))) {
  console.warn('WARNING: search-index.json is missing - run: node tools/build-search-index.js');
}
