/**
 * Checks the canonical-host redirect and the noindex marking that goes with it.
 *
 * Four hostnames reach the Worker and only nfclab.co serves the site. Both
 * behaviours need their own test because `wrangler dev` cannot exercise either:
 * it reports the hostname as the first configured route, so every local request
 * looks like it arrived on the canonical host and both branches are dead. A
 * request sent to the dev server as bogus.example.com came back 200 and
 * unmarked, which is exactly what a broken redirect would also look like.
 *
 * Run with: node worker/test/canonical.mjs
 */

import { canonicalRedirect, shouldNoindex } from '../index.js'

const env = { CANONICAL_HOST: 'nfclab.co' }

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name}: ${err.message}`)
  }
}

function redirects(from, to) {
  const response = canonicalRedirect(new URL(from), env)
  if (!response) throw new Error(`${from} was not redirected`)
  if (response.status !== 301) throw new Error(`expected 301, got ${response.status}`)
  const location = response.headers.get('location')
  if (location !== to) throw new Error(`expected ${to}, got ${location}`)
}

function serves(from) {
  const response = canonicalRedirect(new URL(from), env)
  if (response) throw new Error(`${from} should be served, got ${response.status} to ${response.headers.get('location')}`)
}

check('the canonical host serves', () => serves('https://nfclab.co/'))
check('www of the canonical host redirects', () =>
  redirects('https://www.nfclab.co/', 'https://nfclab.co/'))
check('the .com apex redirects', () => redirects('https://nfclab.com/', 'https://nfclab.co/'))
check('www.nfclab.com redirects', () =>
  redirects('https://www.nfclab.com/', 'https://nfclab.co/'))

// The old site's URLs have to survive the move, so the path and query come
// along rather than everyone landing on the homepage.
check('the path is preserved', () =>
  redirects('https://www.nfclab.com/solutions/pubs.html', 'https://nfclab.co/solutions/pubs.html'))
check('the query string is preserved', () =>
  redirects('https://nfclab.com/search.html?q=ndef', 'https://nfclab.co/search.html?q=ndef'))
check('an extensionless path is preserved', () =>
  redirects('https://nfclab.com/solutions/pubs', 'https://nfclab.co/solutions/pubs'))

// http:// inbound must not redirect to http:// on the canonical host, or the
// visitor takes an extra hop through plaintext before Cloudflare upgrades them.
check('http is upgraded to https', () =>
  redirects('http://nfclab.com/pricing/pricing.html', 'https://nfclab.co/pricing/pricing.html'))

// The generated hostname stays usable, so the Worker can be checked without a
// custom domain in front of it.
check('workers.dev is exempt', () => serves('https://nfc-lab.dry-sky-b32b.workers.dev/'))
check('localhost is exempt', () => serves('http://localhost:8787/'))
check('127.0.0.1 is exempt', () => serves('http://127.0.0.1:8787/solutions/pubs'))

// With no canonical configured nothing should redirect, so a misconfigured
// deploy degrades to "serves on every hostname" rather than to a loop.
check('no CANONICAL_HOST means no redirect', () => {
  const response = canonicalRedirect(new URL('https://nfclab.com/'), {})
  if (response) throw new Error('redirected with no CANONICAL_HOST set')
})

// --- noindex marking ---------------------------------------------------------
//
// The custom domains redirect and never serve, so in practice this is about
// workers.dev: it is exempt from the redirect to stay usable, which leaves it
// free to be indexed alongside nfclab.co and compete with it.

function noindexed(url, expected) {
  const actual = shouldNoindex(new URL(url), env)
  if (actual !== expected) {
    throw new Error(`expected shouldNoindex=${expected} for ${url}, got ${actual}`)
  }
}

check('the canonical host is indexable', () => noindexed('https://nfclab.co/', false))
check('workers.dev is marked noindex', () =>
  noindexed('https://nfc-lab.dry-sky-b32b.workers.dev/', true))
check('a preview URL is marked noindex', () =>
  noindexed('https://abc123-nfc-lab.dry-sky-b32b.workers.dev/solutions/pubs', true))
check('a non-canonical custom domain would be marked', () =>
  noindexed('https://www.nfclab.com/', true))
check('no CANONICAL_HOST means nothing is marked', () => {
  if (shouldNoindex(new URL('https://nfclab.co/'), {})) {
    throw new Error('marked noindex with no CANONICAL_HOST set')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
