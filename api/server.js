/**
 * Form handler for the NFC Lab static site.
 *
 * The site is a Webflow export served as static files by Caddy. Webflow's
 * bundled JS posts every form to https://webflow.com/api/v1/form/<site-id>,
 * which only accepts submissions originating from Webflow-hosted domains, so
 * off Webflow every submission fails. This service replaces that endpoint.
 *
 * Caddy reverse-proxies /api/* here over Railway's private network, so requests
 * arrive same-origin and no CORS is needed in the normal path.
 *
 * Zero runtime dependencies: node:http plus global fetch.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000

const config = {
  to: process.env.FORM_TO_EMAIL || 'hello@thelabgroup.com',
  from: process.env.FORM_FROM_EMAIL || 'NFC Lab Website <onboarding@resend.dev>',
  resendKey: process.env.RESEND_API_KEY || '',
  // Overridable so the test suite can point delivery at a local stub.
  resendUrl: process.env.RESEND_API_URL || 'https://api.resend.com/emails',
  webhookUrl: process.env.FORM_WEBHOOK_URL || '',
  // When set, only these origins may submit. Empty = allow any (the normal
  // same-origin path through Caddy sends no Origin worth checking).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  successRedirect: process.env.FORM_SUCCESS_REDIRECT || '/support/thank-you',
  errorRedirect: process.env.FORM_ERROR_REDIRECT || '/support/contact-2?error=1',
  // Accepted submissions per IP per window.
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 5,
  // Total requests per IP per window, including ones that fail validation.
  rateLimitBurstMax: Number(process.env.RATE_LIMIT_BURST_MAX) || 40,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
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

const FORMS = {
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
    subject: (f) => `Pricing quote — ${f['venue-type'] || 'venue'}${f['quoted-price'] ? ` (${f['quoted-price']})` : ''}`,
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

function log(level, event, data = {}) {
  process.stdout.write(JSON.stringify({ level, event, ts: new Date().toISOString(), ...data }) + '\n')
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

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length) {
    // Left-most entry is the original client; the rest are our own proxies.
    return fwd.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop consuming, but leave the socket open long enough to send a real
        // 413. Destroying here would surface to the browser as a network error
        // instead of a message the visitor can act on.
        req.pause()
        fail(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP)
//
// Two tiers, because they defend against different things:
//   burst  — every request counts. Stops a bot hammering the endpoint.
//   submit — only submissions that pass validation count. Keeps someone who
//            mistypes their email a few times from locking themselves out.
//
// Single-instance only. If this service is ever scaled past one replica the
// effective limit multiplies by the replica count — acceptable for a contact
// form, but worth replacing with Redis if that changes.
// ---------------------------------------------------------------------------

const hits = new Map()

function bucketKey(ip, tier) {
  return `${tier}:${ip}`
}

/** Records a hit and reports whether the caller has now exceeded `max`. */
function rateLimited(ip, tier, max) {
  const key = bucketKey(ip, tier)
  const cutoff = Date.now() - config.rateLimitWindowMs
  const recent = (hits.get(key) || []).filter((t) => t > cutoff)
  if (recent.length >= max) {
    hits.set(key, recent)
    return true
  }
  recent.push(Date.now())
  hits.set(key, recent)
  return false
}

// Prune idle buckets so the map cannot grow without bound.
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - config.rateLimitWindowMs
  for (const [key, times] of hits) {
    const recent = times.filter((t) => t > cutoff)
    if (recent.length) hits.set(key, recent)
    else hits.delete(key)
  }
}, 60 * 1000)
pruneTimer.unref()

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

async function sendEmail({ subject, text, html, replyTo }) {
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
async function sendWebhook(payload) {
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

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
  // If we bailed out mid-upload (an oversized body), the client may still be
  // sending. Close the connection once our response is safely flushed.
  if (status === 413) res.on('finish', () => res.socket?.destroy())
}

function corsHeaders(req) {
  const origin = req.headers.origin
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

function originAllowed(req) {
  if (!config.allowedOrigins.length) return true
  const origin = req.headers.origin
  // Same-origin form posts and no-JS submissions may omit Origin entirely.
  if (!origin) return true
  return config.allowedOrigins.includes(origin)
}

/** Success response, shaped for the caller (AJAX gets JSON, browsers get a redirect). */
function respondSuccess(res, submission, cors) {
  if (submission.isAjax) {
    sendJson(res, 200, { ok: true }, cors)
  } else {
    res.writeHead(303, { Location: config.successRedirect, 'Cache-Control': 'no-store' })
    res.end()
  }
}

async function handleSubmission(req, res, formName) {
  const cors = corsHeaders(req)
  const id = randomUUID()
  const receivedAt = new Date().toISOString()
  const ip = clientIp(req)

  const form = FORMS[formName]
  if (!form) {
    log('warn', 'unknown_form', { id, formName, ip })
    return sendJson(res, 404, { ok: false, error: 'Unknown form' }, cors)
  }

  if (!originAllowed(req)) {
    log('warn', 'origin_rejected', { id, formName, origin: req.headers.origin, ip })
    return sendJson(res, 403, { ok: false, error: 'Origin not allowed' }, cors)
  }

  if (rateLimited(ip, 'burst', config.rateLimitBurstMax)) {
    log('warn', 'rate_limited', { id, formName, ip, tier: 'burst' })
    return sendJson(
      res,
      429,
      { ok: false, error: 'Too many requests. Please try again shortly.' },
      cors,
    )
  }

  const raw = await readBody(req)
  const contentType = String(req.headers['content-type'] || '')
  const submission = parseSubmission(contentType, raw)

  // Spam gates. Both answer with a success shape so bots learn nothing.
  if (submission.honeypot) {
    log('info', 'spam_honeypot', { id, formName, ip })
    return respondSuccess(res, submission, cors)
  }
  if (submission.isAjax && submission.elapsedMs > 0 && submission.elapsedMs < MIN_FILL_MS) {
    log('info', 'spam_too_fast', { id, formName, ip, elapsedMs: submission.elapsedMs })
    return respondSuccess(res, submission, cors)
  }

  const values = toMap(submission.fields)

  const missing = form.required.filter((name) => !values[name])
  if (missing.length) {
    log('warn', 'validation_failed', { id, formName, missing })
    return sendJson(
      res,
      422,
      { ok: false, error: `Please complete: ${missing.join(', ')}`, fields: missing },
      cors,
    )
  }

  const replyTo = form.emailField ? values[form.emailField] : ''
  if (replyTo && !EMAIL_RE.test(replyTo)) {
    log('warn', 'invalid_email', { id, formName })
    return sendJson(
      res,
      422,
      { ok: false, error: 'That email address does not look valid.', fields: [form.emailField] },
      cors,
    )
  }

  // Only now, with a well-formed submission in hand, spend the strict budget.
  if (rateLimited(ip, 'submit', config.rateLimitMax)) {
    log('warn', 'rate_limited', { id, formName, ip, tier: 'submit' })
    return sendJson(
      res,
      429,
      { ok: false, error: 'Too many submissions. Please try again shortly.' },
      cors,
    )
  }

  const meta = { id, receivedAt, ip, userAgent: clean(req.headers['user-agent'], 300) }

  // Log the full submission before attempting delivery. If email is down the
  // lead is still recoverable from Railway's logs.
  log('info', 'submission', { id, formName, page: submission.page, fields: values })

  const { text, html } = renderEmail(form, submission, meta)
  const subject = form.subject(values)

  await sendWebhook({ id, form: formName, receivedAt, page: submission.page, fields: values })

  try {
    await sendEmail({ subject, text, html, replyTo })
  } catch (err) {
    log('error', 'email_failed', { id, formName, error: err.message, code: err.code })
    if (submission.isAjax) {
      return sendJson(
        res,
        502,
        {
          ok: false,
          error: `We could not deliver your message. Please email ${config.to} directly.`,
          reference: id,
        },
        cors,
      )
    }
    res.writeHead(303, { Location: config.errorRedirect, 'Cache-Control': 'no-store' })
    return res.end()
  }

  log('info', 'delivered', { id, formName, to: config.to })
  return respondSuccess(res, submission, cors)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req))
    return res.end()
  }

  if (path === '/api/health' || path === '/health') {
    return sendJson(res, 200, {
      ok: true,
      emailConfigured: Boolean(config.resendKey),
      forms: Object.keys(FORMS),
    })
  }

  const match = path.match(/^\/api\/forms\/([a-z0-9-]{1,40})$/)
  if (match) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' })
    }
    return handleSubmission(req, res, match[1]).catch((err) => {
      const status = err.statusCode || 500
      log('error', 'unhandled', { path, error: err.message, stack: err.stack })
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          error: status === 500 ? 'Something went wrong on our end.' : err.message,
        })
      } else {
        res.end()
      }
    })
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' })
})

// Bind on :: so Railway's private network (IPv6) can reach us. Dual-stack
// sockets also accept IPv4, so this covers both DNS shapes.
server.listen(PORT, '::', () => {
  log('info', 'listening', {
    port: PORT,
    to: config.to,
    emailConfigured: Boolean(config.resendKey),
    webhookConfigured: Boolean(config.webhookUrl),
  })
  if (!config.resendKey) {
    log('warn', 'email_not_configured', {
      message: 'RESEND_API_KEY is unset — submissions will be logged but not emailed.',
    })
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('info', 'shutting_down', { signal })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10000).unref()
  })
}
