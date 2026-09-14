/**
 * The NFC Lab site, served from Cloudflare Workers static assets.
 *
 * Replaces the Caddy config this repo used on Railway. The four things Caddy
 * did that a bare asset host does not are done here instead:
 *
 *   1. HTTP basic auth in front of everything except /health
 *   2. /api/* handled in-process by worker/forms.js
 *   3. try_files — /solutions/pubs resolves to /solutions/pubs.html
 *   4. security headers, the cache policy, and the exported 401/404 pages
 *
 * `run_worker_first` is true in wrangler.jsonc, so every request lands here
 * before the asset host answers it. That is what makes the gate a gate: with
 * the default routing, assets are served before the Worker ever runs and the
 * whole site would be public.
 */

import { handleApiRequest } from './forms.js'

// ---------------------------------------------------------------------------
// Security headers
//
// The CSP is deliberately permissive: the site pulls scripts, fonts and styles
// from jsdelivr, Google Fonts/Tag Manager, Crisp chat and the Webflow CDN, and
// Crisp opens a wss: connection.
//
// Applied to every response including the error pages — the 401 is what every
// unauthenticated visitor sees first, so it must not be the one response that
// ships without a CSP.
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  // Enable cross-site filter (XSS) and tell browsers to block detected attacks
  'X-XSS-Protection': '1; mode=block',
  // Prevent some browsers from MIME-sniffing away from the declared Content-Type
  'X-Content-Type-Options': 'nosniff',
  // Keep referrer data off of HTTP connections
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Enable strict Content Security Policy
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https: *; style-src 'self' 'unsafe-inline' https: *; script-src 'self' 'unsafe-inline' https: *; font-src 'self' data: https: *; connect-src 'self' https: *; media-src 'self' https: *; object-src 'none'; frame-src 'self' https: *;",
}

// ---------------------------------------------------------------------------
// Cache policy
//
// Webflow exports are NOT content-hashed — a re-export reuses the same
// filenames — so only fonts are safe to treat as immutable. Everything else
// trades a shorter TTL for updates that actually reach visitors. Pages
// revalidate every request and the asset host answers with a cheap 304 from
// its ETag, so a re-export goes live immediately.
//
// First match wins, so the order here is the policy.
// ---------------------------------------------------------------------------

const CACHE_RULES = [
  [/^\/fonts\//, 'public, max-age=31536000, immutable'],
  [/^\/images\//, 'public, max-age=604800'],
  [/^\/(css|js)\//, 'public, max-age=3600, must-revalidate'],
]
const DEFAULT_CACHE_CONTROL = 'no-cache'

function cacheControlFor(pathname) {
  for (const [pattern, value] of CACHE_RULES) {
    if (pattern.test(pathname)) return value
  }
  return DEFAULT_CACHE_CONTROL
}

// ---------------------------------------------------------------------------
// Paths that must never be served
//
// .assetsignore already keeps these out of the upload, so this is the second
// lock rather than the first: an .assetsignore edit that accidentally ships the
// build tooling or a stray .env should not also make it reachable. Matched
// against the pathname before anything is looked up.
// ---------------------------------------------------------------------------

const DENIED = [
  /^\/\.git(\/|$)/,
  /^\/\.env(\.|$)/,
  /^\/\.assetsignore$/,
  /^\/\.gitignore$/,
  /^\/tools(\/|$)/,
  /^\/worker(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/node_modules(\/|$)/,
  /^\/(Caddyfile|Staticfile|README\.md|wrangler\.jsonc?|wrangler\.toml|package(-lock)?\.json)$/i,
]

function isDenied(pathname) {
  return DENIED.some((pattern) => pattern.test(pathname))
}

// ---------------------------------------------------------------------------
// Basic auth
//
// The Webflow export ships a password page (401.html) whose form posts to
// /.wf_auth, an endpoint that only exists on Webflow's own hosting — self-
// hosted, nothing enforced the gate and the whole site was public. HTTP basic
// auth restores it: the browser's native credential prompt stands in for the
// exported form, and 401.html is the body served to anyone who dismisses it.
//
// Credentials come from Worker secrets, so no hash is committed:
//   SITE_USER             username, defaults to "nfclab"
//   SITE_PASSWORD_SHA256  hex SHA-256 of the password (preferred)
//   SITE_PASSWORD         the password itself (fallback)
//
// Neither password variable has a default. With both unset the Worker answers
// 503 rather than serving the site — the same reasoning as the Caddy config
// refusing to start: a deploy that fails loudly beats a site that quietly goes
// public. A Worker cannot fail its own deploy over a missing secret, so it
// fails closed at request time instead.
//
// Caddy verified a bcrypt hash. Workers has no bcrypt, and running one per
// request would spend real CPU on every page load, so the stored form is a
// SHA-256 digest instead. The threat model is different from a password
// database: this is a single site-wide password held as an encrypted secret,
// not a table of user hashes that leaks wholesale.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Length-independent comparison — no early return on the first differing byte. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function parseBasicAuth(header) {
  if (!header || !/^basic /i.test(header)) return null
  try {
    const raw = atob(header.slice(6).trim())
    // atob yields one char per byte; decode those bytes as UTF-8 so a password
    // with non-ASCII characters compares equal to the one that was configured.
    const decoded = new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))
    const separator = decoded.indexOf(':')
    if (separator === -1) return null
    // Split on the FIRST colon only: a password may contain them, a username
    // may not.
    return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return null
  }
}

/** 'ok' | 'unauthorized' | 'unconfigured' */
async function checkAuth(request, env) {
  const expectedHash = (env.SITE_PASSWORD_SHA256 || '').trim().toLowerCase()
  const plaintext = env.SITE_PASSWORD || ''
  if (!expectedHash && !plaintext) return 'unconfigured'

  const credentials = parseBasicAuth(request.headers.get('authorization'))
  if (!credentials) return 'unauthorized'

  const expectedUser = env.SITE_USER || 'nfclab'
  // Hash both sides so the comparison is fixed-length and the username cannot
  // be probed a character at a time either.
  const userOk = timingSafeEqual(await sha256Hex(credentials.user), await sha256Hex(expectedUser))
  const passwordOk = timingSafeEqual(
    await sha256Hex(credentials.password),
    expectedHash || (await sha256Hex(plaintext)),
  )

  return userOk && passwordOk ? 'ok' : 'unauthorized'
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Copy a response so its headers can be edited (they are immutable as returned). */
function withHeaders(response, headers) {
  const out = new Response(response.body, response)
  for (const [key, value] of Object.entries(headers)) out.headers.set(key, value)
  return out
}

/**
 * The exported error page for a status, or a plain-text stand-in if the asset
 * is missing. Never recurses: the page is fetched by its exact path.
 */
async function errorPage(env, status, extraHeaders = {}) {
  const headers = {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  }

  try {
    const page = await env.ASSETS.fetch(new URL(`https://assets.local/${status}.html`))
    if (page.ok) return new Response(page.body, { status, headers })
  } catch {
    // fall through to the text stand-in
  }

  return new Response(`${status}\n`, {
    status,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Static file lookup, mirroring Caddy's
 *   try_files {path} {path}.html {path}/index.html
 *
 * No SPA fallback: this is a multi-page site, and an unmatched path should 404
 * rather than silently rendering the homepage.
 */
async function serveStatic(request, env, url) {
  const trimmed = url.pathname.replace(/\/+$/, '')
  const candidates = trimmed === '' ? ['/index.html'] : [trimmed, `${trimmed}.html`, `${trimmed}/index.html`]

  for (const candidate of candidates) {
    const target = new URL(url)
    target.pathname = candidate
    const response = await env.ASSETS.fetch(new Request(target, request))
    if (response.status === 404) continue
    return withHeaders(response, {
      ...SECURITY_HEADERS,
      'Cache-Control': cacheControlFor(url.pathname),
    })
  }

  return errorPage(env, 404)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // Unauthenticated on purpose, so an uptime check can reach it without
    // credentials. Returns no site content.
    if (url.pathname === '/health') {
      return new Response('OK\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    const auth = await checkAuth(request, env)

    if (auth === 'unconfigured') {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'auth_unconfigured',
          ts: new Date().toISOString(),
          message:
            'Neither SITE_PASSWORD_SHA256 nor SITE_PASSWORD is set — refusing to serve the site.',
        }),
      )
      return errorPage(env, 503)
    }

    if (auth === 'unauthorized') {
      return errorPage(env, 401, { 'WWW-Authenticate': 'Basic realm="restricted"' })
    }

    // Inside the gate on purpose: everyone who can see a form has already
    // authenticated, so gating the endpoint costs nothing and keeps drive-by
    // spam off it entirely.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const response = await handleApiRequest(request, env)
      return withHeaders(response, SECURITY_HEADERS)
    }

    if (isDenied(url.pathname)) return errorPage(env, 404)

    return serveStatic(request, env, url)
  },
}
