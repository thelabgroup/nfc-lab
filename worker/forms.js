/**
 * Form handling for the NFC Lab site.
 *
 * Platform-neutral on purpose: it takes a `Request` plus an env bag and returns
 * a `Response`, so one implementation serves both adapters —
 *
 *   worker/index.js   the Cloudflare Worker (production)
 *   api/server.js     a node:http wrapper (local dev and the test suite)
 *
 * Webflow's bundled JS posts every form to https://webflow.com/api/v1/form/<id>,
 * which only accepts submissions from Webflow-hosted domains, so off Webflow
 * every submission fails. This replaces that endpoint.
 *
 * Zero dependencies: only the fetch API and Web Crypto, both of which Workers
 * and Node 20+ provide.
 */

// ---------------------------------------------------------------------------
// Config
//
// Derived per env bag rather than read once at module scope: a Worker receives
// its variables as a fetch() argument, not from a process-wide environment. The
// WeakMap keeps that from re-parsing on every request.
// ---------------------------------------------------------------------------

const configCache = new WeakMap()

export function readConfig(env = {}) {
  const cached = configCache.get(env)
  if (cached) return cached

  const config = {
    to: env.FORM_TO_EMAIL || 'hello@thelabgroup.com',
    from: env.FORM_FROM_EMAIL || 'NFC Lab Website <onboarding@resend.dev>',
    resendKey: env.RESEND_API_KEY || '',
    // Overridable so the test suite can point delivery at a local stub.
    resendUrl: env.RESEND_API_URL || 'https://api.resend.com/emails',
    webhookUrl: env.FORM_WEBHOOK_URL || '',
    // When set, only these origins may submit. Empty = allow any (the normal
    // same-origin path sends no Origin worth checking).
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    successRedirect: env.FORM_SUCCESS_REDIRECT || '/support/thank-you',
    errorRedirect: env.FORM_ERROR_REDIRECT || '/support/contact-2?error=1',
    // Accepted submissions per IP per window.
    rateLimitMax: Number(env.RATE_LIMIT_MAX) || 5,
    // Total requests per IP per window, including ones that fail validation.
    rateLimitBurstMax: Number(env.RATE_LIMIT_BURST_MAX) || 40,
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
  }

  configCache.set(env, config)
  return config
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_FIELDS = 40
const MAX_LABEL_LEN = 120
const MAX_VALUE_LEN = 5000
// Submissions faster than this are almost certainly automated.
const MIN_FILL_MS = 1500

// ---------------------------------------------------------------------------
// Form definitions
//
// `required` uses the field `name` attributes set in the site HTML. Anything
// not listed still gets forwarded — the schema only enforces what we must have
// in order to act on the lead.
// ---------------------------------------------------------------------------

export const FORMS = {
  contact: {
    title: 'Contact enquiry',
    required: ['first-name', 'last-name', 'email'],
    emailField: 'email',
    subject: (f) =>
      `Contact enquiry — ${[f['first-name'], f['last-name']].filter(Boolean).join(' ') || 'no name'}`,
  },
  'pricing-quote': {
    title: 'Pricing quote request',
    required: ['email'],
    emailField: 'email',
    subject: (f) =>
      `Pricing quote — ${f['venue-type'] || 'venue'}${f['quoted-price'] ? ` (${f['quoted-price']})` : ''}`,
  },
  'pricing-plan': {
    title: 'Site plan request',
    required: ['email'],
    emailField: 'email',
    subject: (f) => `Site plan — ${f.account || 'plan'} / ${f.pages || '?'} pages`,
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function log(level, event, data = {}) {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...data }))
}

// Control characters, minus tab/newline/return so multi-line values survive.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/** Strip control characters and cap length. */
function clean(value, maxLen) {
  return String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, maxLen)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The client address.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and overwrites whatever the
 * caller sent, so it cannot be spoofed. X-Forwarded-For is the fallback for the
 * node adapter behind a local proxy; its left-most entry is the original client.
 */
function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return request.headers.get('x-real-ip') || 'unknown'
}

/**
 * Read the body, refusing anything over the cap.
 *
 * Content-Length is checked first so an oversized upload is rejected before it
 * is buffered; the post-read check catches chunked bodies that declare no
 * length. Throws with a statusCode the caller turns into a real 413 rather than
 * dropping the connection — a network error is not something a visitor can act
 * on.
 */
async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
  }
  return raw
}

// ---------------------------------------------------------------------------
// Rate limiting, per IP
//
// Two tiers, because they defend against different things:
//   burst  — every request counts. Stops a bot hammering the endpoint.
//   submit — only submissions that pass validation count. Keeps someone who
//            mistypes their email a few times from locking themselves out.
//
// Enforced by Cloudflare's Rate Limiting bindings (FORM_BURST_LIMIT and
// FORM_SUBMIT_LIMIT in wrangler.jsonc) when they are present. They count per
// Cloudflare location rather than per isolate, which is what this needs now
// that the endpoint is public: it used to sit behind the site's basic auth
// gate, where an isolate-local counter was defence in depth rather than the
// only thing between a bot and the inbox.
//
// The in-memory counters below are the fallback for anything without those
// bindings — api/server.js under node, and the test suite, which drives the
// limits through RATE_LIMIT_MAX and friends.
//
// One difference worth knowing: the binding's period can only be 10 or 60
// seconds, so the strict tier is now "5 per minute" rather than the old "5 per
// 10 minutes". Faster to recover from, more forgiving of a real person who
// submits twice, and still far below what a bot needs to be worth its time.
// ---------------------------------------------------------------------------

const hits = new Map()
// Pruned on write rather than on a timer: a Worker isolate has no long-lived
// setInterval to hang one off, and the map only grows while traffic arrives.
const PRUNE_AT = 5000

function prune(cutoff) {
  for (const [key, times] of hits) {
    const recent = times.filter((t) => t > cutoff)
    if (recent.length) hits.set(key, recent)
    else hits.delete(key)
  }
}

/** Records a hit in the in-process counters and reports whether `max` is now exceeded. */
function rateLimitedLocally(config, ip, tier, max) {
  const cutoff = Date.now() - config.rateLimitWindowMs
  if (hits.size > PRUNE_AT) prune(cutoff)

  const key = `${tier}:${ip}`
  const recent = (hits.get(key) || []).filter((t) => t > cutoff)
  if (recent.length >= max) {
    hits.set(key, recent)
    return true
  }
  recent.push(Date.now())
  hits.set(key, recent)
  return false
}

/** Records a hit and reports whether the caller has now exceeded the tier's budget. */
async function rateLimited(env, config, ip, tier, max) {
  const limiter = tier === 'burst' ? env.FORM_BURST_LIMIT : env.FORM_SUBMIT_LIMIT

  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key: ip })
      return !success
    } catch (err) {
      // A limiter that errors must not take the form down with it. Fall
      // through to the in-process counters rather than rejecting the lead.
      log('warn', 'rate_limiter_failed', { tier, error: err.message })
    }
  }

  return rateLimitedLocally(config, ip, tier, max)
}

// ---------------------------------------------------------------------------
// Submission parsing
// ---------------------------------------------------------------------------

/**
 * Normalises both payload shapes into an ordered list of labelled fields:
 *   - application/json      → what js/forms.js sends (carries display labels)
 *   - urlencoded form POST  → the no-JavaScript fallback (names only)
 */
function parseSubmission(contentType, raw) {
  if (contentType.includes('application/json')) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw Object.assign(new Error('Malformed JSON body'), { statusCode: 400 })
    }
    const fields = Array.isArray(parsed.fields) ? parsed.fields : []
    return {
      isAjax: true,
      page: clean(parsed.page, 500),
      honeypot: clean(parsed._hp, 200),
      elapsedMs: Number(parsed._t) || 0,
      fields: fields.slice(0, MAX_FIELDS).map((f) => ({
        name: clean(f?.name, MAX_LABEL_LEN),
        label: clean(f?.label || f?.name, MAX_LABEL_LEN),
        value: clean(f?.value, MAX_VALUE_LEN),
      })),
    }
  }

  const params = new URLSearchParams(raw)
  const fields = []
  for (const [name, value] of params) {
    if (name === '_hp' || name === '_t' || name === '_page') continue
    if (fields.length >= MAX_FIELDS) break
    const label = clean(name, MAX_LABEL_LEN)
    fields.push({ name: label, label, value: clean(value, MAX_VALUE_LEN) })
  }
  return {
    isAjax: false,
    page: clean(params.get('_page'), 500),
    honeypot: clean(params.get('_hp'), 200),
    elapsedMs: Number(params.get('_t')) || 0,
    fields,
  }
}

/** Collapse the ordered field list into a name→value map for schema checks. */
function toMap(fields) {
  const map = {}
  for (const f of fields) {
    if (!f.name) continue
    // Repeated names (checkbox groups) accumulate rather than overwrite.
    map[f.name] = map[f.name] ? `${map[f.name]}, ${f.value}` : f.value
  }
  return map
}

// ---------------------------------------------------------------------------
// Email rendering + delivery
// ---------------------------------------------------------------------------

function renderEmail(form, submission, meta) {
  const rows = submission.fields.filter((f) => f.value !== '')

  const text = [
    form.title,
    '='.repeat(form.title.length),
    '',
    ...rows.map((f) => `${f.label}: ${f.value}`),
    '',
    '---',
    `Page: ${submission.page || 'unknown'}`,
    `Submitted: ${meta.receivedAt}`,
    `Reference: ${meta.id}`,
  ].join('\n')

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:24px 28px;background:#1a1a1a;color:#ffffff;">
          <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;">NFC Lab website</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px;">${escapeHtml(form.title)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 28px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
            ${rows
              .map(
                (f) => `<tr>
              <td style="padding:12px 0;border-bottom:1px solid #eef0f3;font-size:13px;color:#6b7280;width:40%;vertical-align:top;">${escapeHtml(f.label)}</td>
              <td style="padding:12px 0;border-bottom:1px solid #eef0f3;font-size:15px;color:#111827;vertical-align:top;">${escapeHtml(f.value)}</td>
            </tr>`,
              )
              .join('\n')}
          </table>
          <div style="margin-top:20px;font-size:12px;color:#9ca3af;line-height:1.6;">
            Page: ${escapeHtml(submission.page || 'unknown')}<br>
            Submitted: ${escapeHtml(meta.receivedAt)}<br>
            Reference: ${escapeHtml(meta.id)}
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { text, html }
}

async function sendEmail(config, { subject, text, html, replyTo }) {
  if (!config.resendKey) {
    throw Object.assign(new Error('RESEND_API_KEY is not set'), { code: 'NO_EMAIL_PROVIDER' })
  }

  const res = await fetch(config.resendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 500)}`)
  }
  return res.json().catch(() => ({}))
}

/** Optional secondary sink (Slack incoming webhook, Zapier, etc.). */
async function sendWebhook(config, payload) {
  if (!config.webhookUrl) return
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    log('warn', 'webhook_failed', { error: err.message })
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

/**
 * A relative Location, built by hand rather than with Response.redirect(),
 * which insists on an absolute URL. Browsers resolve it against the request,
 * so the redirect works on workers.dev and on the custom domain without either
 * hostname being configured anywhere.
 */
function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  })
}

function corsHeaders(config, request) {
  const origin = request.headers.get('origin')
  if (!origin) return {}
  if (config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': config.allowedOrigins.length ? origin : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function originAllowed(config, request) {
  if (!config.allowedOrigins.length) return true
  const origin = request.headers.get('origin')
  // Same-origin form posts and no-JS submissions may omit Origin entirely.
  if (!origin) return true
  return config.allowedOrigins.includes(origin)
}

/** Success response, shaped for the caller (AJAX gets JSON, browsers a redirect). */
function respondSuccess(config, submission, cors) {
  return submission.isAjax ? json(200, { ok: true }, cors) : redirect(config.successRedirect)
}

async function handleSubmission(request, env, config, formName) {
  const cors = corsHeaders(config, request)
  const id = crypto.randomUUID()
  const receivedAt = new Date().toISOString()
  const ip = clientIp(request)

  const form = FORMS[formName]
  if (!form) {
    log('warn', 'unknown_form', { id, formName, ip })
    return json(404, { ok: false, error: 'Unknown form' }, cors)
  }

  if (!originAllowed(config, request)) {
    log('warn', 'origin_rejected', { id, formName, origin: request.headers.get('origin'), ip })
    return json(403, { ok: false, error: 'Origin not allowed' }, cors)
  }

  if (await rateLimited(env, config, ip, 'burst', config.rateLimitBurstMax)) {
    log('warn', 'rate_limited', { id, formName, ip, tier: 'burst' })
    return json(429, { ok: false, error: 'Too many requests. Please try again shortly.' }, cors)
  }

  const raw = await readBody(request)
  const contentType = request.headers.get('content-type') || ''
  const submission = parseSubmission(contentType, raw)

  // Spam gates. Both answer with a success shape so bots learn nothing.
  if (submission.honeypot) {
    log('info', 'spam_honeypot', { id, formName, ip })
    return respondSuccess(config, submission, cors)
  }
  if (submission.isAjax && submission.elapsedMs > 0 && submission.elapsedMs < MIN_FILL_MS) {
    log('info', 'spam_too_fast', { id, formName, ip, elapsedMs: submission.elapsedMs })
    return respondSuccess(config, submission, cors)
  }

  const values = toMap(submission.fields)

  const missing = form.required.filter((name) => !values[name])
  if (missing.length) {
    log('warn', 'validation_failed', { id, formName, missing })
    return json(
      422,
      { ok: false, error: `Please complete: ${missing.join(', ')}`, fields: missing },
      cors,
    )
  }

  const replyTo = form.emailField ? values[form.emailField] : ''
  if (replyTo && !EMAIL_RE.test(replyTo)) {
    log('warn', 'invalid_email', { id, formName })
    return json(
      422,
      { ok: false, error: 'That email address does not look valid.', fields: [form.emailField] },
      cors,
    )
  }

  // Only now, with a well-formed submission in hand, spend the strict budget.
  if (await rateLimited(env, config, ip, 'submit', config.rateLimitMax)) {
    log('warn', 'rate_limited', { id, formName, ip, tier: 'submit' })
    return json(429, { ok: false, error: 'Too many submissions. Please try again shortly.' }, cors)
  }

  const meta = {
    id,
    receivedAt,
    ip,
    userAgent: clean(request.headers.get('user-agent'), 300),
  }

  // Log the full submission before attempting delivery. If email is down the
  // lead is still recoverable from the Workers logs.
  log('info', 'submission', { id, formName, page: submission.page, fields: values })

  const { text, html } = renderEmail(form, submission, meta)
  const subject = form.subject(values)

  await sendWebhook(config, {
    id,
    form: formName,
    receivedAt,
    page: submission.page,
    fields: values,
  })

  try {
    await sendEmail(config, { subject, text, html, replyTo })
  } catch (err) {
    log('error', 'email_failed', { id, formName, error: err.message, code: err.code })
    if (submission.isAjax) {
      return json(
        502,
        {
          ok: false,
          error: `We could not deliver your message. Please email ${config.to} directly.`,
          reference: id,
        },
        cors,
      )
    }
    return redirect(config.errorRedirect)
  }

  log('info', 'delivered', { id, formName, to: config.to })
  return respondSuccess(config, submission, cors)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handles everything under /api/. Returns a Response for every path it owns,
 * including a JSON 404, so a caller can route the whole prefix here and never
 * have an API path fall through to the static site.
 */
export async function handleApiRequest(request, env = {}) {
  const config = readConfig(env)
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(config, request) })
  }

  if (path === '/api/health' || path === '/health') {
    return json(200, {
      ok: true,
      emailConfigured: Boolean(config.resendKey),
      forms: Object.keys(FORMS),
    })
  }

  const match = path.match(/^\/api\/forms\/([a-z0-9-]{1,40})$/)
  if (match) {
    if (request.method !== 'POST') {
      return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' })
    }
    try {
      return await handleSubmission(request, env, config, match[1])
    } catch (err) {
      const status = err.statusCode || 500
      log('error', 'unhandled', { path, error: err.message, stack: err.stack })
      return json(status, {
        ok: false,
        error: status === 500 ? 'Something went wrong on our end.' : err.message,
      })
    }
  }

  return json(404, { ok: false, error: 'Not found' })
}
