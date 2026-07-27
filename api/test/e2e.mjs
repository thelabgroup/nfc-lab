/**
 * End-to-end test across the real request path:
 *
 *   client -> tools/dev-server.mjs (stands in for Caddy) -> api/server.js -> stub Resend
 *
 * Asserts on the email that actually comes out the far end, so a regression in
 * field naming, labelling or serialisation fails here rather than in someone's
 * inbox.
 *
 * Run with: npm --prefix api run test:e2e
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(API_DIR, '..')

const STUB_PORT = 3941
const API_PORT = 3942
const SITE_PORT = 3943

// --- stub Resend -----------------------------------------------------------
const delivered = []
const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    delivered.push({ auth: req.headers.authorization, payload: JSON.parse(body) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'stub-' + delivered.length }))
  })
})
await new Promise((r) => stub.listen(STUB_PORT, r))

// --- services --------------------------------------------------------------
const api = spawn(process.execPath, ['server.js'], {
  cwd: API_DIR,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    RESEND_API_KEY: 'test-key',
    RESEND_API_URL: `http://127.0.0.1:${STUB_PORT}/emails`,
    FORM_TO_EMAIL: 'hello@thelabgroup.com',
    RATE_LIMIT_MAX: '50',
    RATE_LIMIT_BURST_MAX: '200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
api.stderr.on('data', (d) => process.stderr.write('  [api:err] ' + d))

const site = spawn(process.execPath, ['tools/dev-server.mjs'], {
  cwd: REPO,
  env: { ...process.env, DEV_PORT: String(SITE_PORT), FORMS_UPSTREAM: `http://127.0.0.1:${API_PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
site.stderr.on('data', (d) => process.stderr.write('  [site:err] ' + d))

await sleep(900)

const BASE = `http://127.0.0.1:${SITE_PORT}`
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name}: ${err.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

// --- the site still serves ------------------------------------------------
await check('contact page is served and loads forms.js', async () => {
  const r = await fetch(`${BASE}/support/contact-2`)
  const html = await r.text()
  assert(r.status === 200, `status ${r.status}`)
  assert(html.includes('js/forms.js'), 'forms.js script tag missing')
  assert(html.includes('action="/api/forms/contact"'), 'form action missing')
  assert(html.includes('method="post"'), 'form method missing')
  assert(!html.includes('data-wf-element-id'), 'stale Webflow form binding left behind')
})

await check('extensionless URLs resolve (try_files parity)', async () => {
  assert((await fetch(`${BASE}/pricing/pricing-1`)).status === 200, 'pricing-1')
  assert((await fetch(`${BASE}/support/thank-you`)).status === 200, 'thank-you')
})

await check('forms.js is served as JavaScript', async () => {
  const r = await fetch(`${BASE}/js/forms.js`)
  assert(r.status === 200, `status ${r.status}`)
  assert(/javascript/.test(r.headers.get('content-type')), 'wrong content-type')
})

// --- contact form, the AJAX path -----------------------------------------
await check('contact submission is delivered with labelled fields', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'contact',
      page: `${BASE}/support/contact-2`,
      _hp: '',
      _t: 12000,
      fields: [
        { name: 'first-name', label: 'First Name', value: 'Ada' },
        { name: 'last-name', label: 'Last Name', value: 'Lovelace' },
        { name: 'email', label: 'Email Address', value: 'ada@example.com' },
        { name: 'phone', label: 'Phone Number', value: '+44 7700 900123' },
        { name: 'city', label: 'City', value: 'London' },
        { name: 'postcode', label: 'Postcode', value: 'EC1A 1BB' },
        { name: 'business-type', label: 'Business type', value: 'Restaurant' },
        { name: 'locations', label: 'Number of locations', value: '2-10' },
        { name: 'existing-customer', label: 'Existing customer', value: 'Yes' },
      ],
    }),
  })
  assert(r.status === 200, `status ${r.status}`)
  assert((await r.json()).ok === true, 'ok flag')
  assert(delivered.length === 1, `expected 1 email, got ${delivered.length}`)

  const { payload, auth } = delivered[0]
  assert(auth === 'Bearer test-key', 'auth header not forwarded')
  assert(payload.to[0] === 'hello@thelabgroup.com', `wrong recipient: ${payload.to}`)
  assert(payload.reply_to === 'ada@example.com', `reply-to should be the submitter: ${payload.reply_to}`)
  assert(payload.subject.includes('Ada Lovelace'), `subject: ${payload.subject}`)

  // The labels, not the raw Webflow field names, must reach the inbox.
  for (const expected of ['Business type', 'Restaurant', 'EC1A 1BB', '2-10', 'Existing customer']) {
    assert(payload.text.includes(expected), `text missing "${expected}"`)
    assert(payload.html.includes(expected), `html missing "${expected}"`)
  }
  assert(!payload.text.includes('name-3'), 'raw Webflow field name leaked into the email')
})

await check('HTML email escapes injected markup', async () => {
  delivered.length = 0
  await fetch(`${BASE}/api/forms/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'contact',
      _hp: '',
      _t: 12000,
      fields: [
        { name: 'first-name', label: 'First Name', value: '<img src=x onerror=alert(1)>' },
        { name: 'last-name', label: 'Last Name', value: 'X' },
        { name: 'email', label: 'Email Address', value: 'x@example.com' },
      ],
    }),
  })
  const { payload } = delivered[0]
  assert(!payload.html.includes('<img src=x'), 'unescaped HTML reached the email body')
  assert(payload.html.includes('&lt;img'), 'expected the markup to be escaped, not stripped')
})

// --- pricing forms --------------------------------------------------------
await check('pricing quote carries the calculated price', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/pricing-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'pricing-quote',
      _hp: '',
      _t: 20000,
      fields: [
        { name: 'venue-type', label: 'Venue type', value: 'Tables, table service' },
        { name: 'tables', label: 'Number of tables', value: '12' },
        { name: 'payment-model', label: 'Payment model', value: 'Pay on order' },
        { name: 'billing', label: 'Billing', value: 'Monthly' },
        { name: 'quoted-price', label: 'Quoted price', value: '£49/month' },
        { name: 'email', label: 'Email Address', value: 'venue@example.com' },
      ],
    }),
  })
  assert(r.status === 200, `status ${r.status}`)
  const { payload } = delivered[0]
  assert(payload.text.includes('£49/month'), 'quoted price missing from email')
  assert(payload.subject.includes('£49/month'), `subject should carry the quote: ${payload.subject}`)
  assert(payload.reply_to === 'venue@example.com', 'reply-to missing')
})

await check('pricing quote without an email is rejected', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/pricing-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'pricing-quote',
      _hp: '',
      _t: 20000,
      fields: [{ name: 'venue-type', label: 'Venue type', value: 'Counter service' }],
    }),
  })
  assert(r.status === 422, `status ${r.status}`)
  assert(delivered.length === 0, 'should not have sent an unactionable lead')
})

await check('site plan submission is delivered', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/pricing-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'pricing-plan',
      _hp: '',
      _t: 20000,
      fields: [
        { name: 'account', label: 'Account', value: 'Business' },
        { name: 'pages', label: 'Pages', value: '50' },
        { name: 'monthly-visits', label: 'Monthly visits', value: '25,000' },
        { name: 'email', label: 'Email Address', value: 'plan@example.com' },
      ],
    }),
  })
  assert(r.status === 200, `status ${r.status}`)
  assert(delivered[0].payload.subject.includes('Business'), 'subject should name the plan')
  assert(delivered[0].payload.text.includes('25,000'), 'visits missing')
})

// --- no-JavaScript path ---------------------------------------------------
await check('no-JS urlencoded POST delivers and redirects to thank-you', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'first-name': 'Grace',
      'last-name': 'Hopper',
      email: 'grace@example.com',
      'business-type': 'Cafe',
      _hp: '',
    }).toString(),
    redirect: 'manual',
  })
  assert(r.status === 303, `status ${r.status}`)
  assert(r.headers.get('location') === '/support/thank-you', `location ${r.headers.get('location')}`)
  assert(delivered.length === 1, 'email not sent on the no-JS path')
  assert(delivered[0].payload.text.includes('Grace'), 'submission content missing')
})

await check('the thank-you redirect target actually exists', async () => {
  const r = await fetch(`${BASE}/support/thank-you`)
  assert(r.status === 200, `status ${r.status}`)
  const html = await r.text()
  assert(/thank you/i.test(html), 'thank-you page has no confirmation copy')
  assert(html.includes('noindex'), 'confirmation page should not be indexable')
})

await check('honeypot submissions are dropped, not delivered', async () => {
  delivered.length = 0
  const r = await fetch(`${BASE}/api/forms/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form: 'contact',
      _hp: 'http://spam.example',
      _t: 12000,
      fields: [
        { name: 'first-name', label: 'First Name', value: 'Bot' },
        { name: 'last-name', label: 'Last Name', value: 'Net' },
        { name: 'email', label: 'Email Address', value: 'bot@example.com' },
      ],
    }),
  })
  assert(r.status === 200, 'bot should see a success shape')
  assert(delivered.length === 0, 'spam reached the inbox')
})

// --- teardown -------------------------------------------------------------
api.kill('SIGTERM')
site.kill('SIGTERM')
await sleep(250)
api.kill('SIGKILL')
site.kill('SIGKILL')
stub.close()

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall end-to-end checks passed')
process.exit(failures ? 1 : 0)
