// End-to-end smoke test: boots server.js on a spare port and exercises the
// request paths that matter, including the ones that previously regressed.
// Run with: npm test
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3737
const BASE = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(PORT),
    RESEND_API_KEY: '',
    RATE_LIMIT_MAX: '3',
    RATE_LIMIT_BURST_MAX: '200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => process.stdout.write('  [server] ' + d))
child.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d))

await sleep(700)

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
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

const post = (path, body, headers = {}) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const validContact = {
  form: 'contact',
  page: 'http://localhost/support/contact-2',
  _hp: '',
  _t: 9000,
  fields: [
    { name: 'first-name', label: 'First Name', value: 'Ada' },
    { name: 'last-name', label: 'Last Name', value: 'Lovelace' },
    { name: 'email', label: 'Email Address', value: 'ada@example.com' },
    { name: 'business-type', label: 'Business type', value: 'Restaurant' },
  ],
}

await check('health reports forms + email state', async () => {
  const r = await fetch(BASE + '/api/health')
  const j = await r.json()
  eq(r.status, 200, 'status')
  eq(j.emailConfigured, false, 'emailConfigured')
  eq(j.forms.sort(), ['contact', 'pricing-plan', 'pricing-quote'], 'forms')
})

await check('unknown form is rejected', async () => {
  eq((await post('/api/forms/nope', validContact)).status, 404, 'status')
})

await check('GET on a form endpoint is 405', async () => {
  eq((await fetch(BASE + '/api/forms/contact')).status, 405, 'status')
})

await check('missing required fields -> 422 naming them', async () => {
  const r = await post('/api/forms/contact', {
    ...validContact,
    fields: [{ name: 'first-name', label: 'First Name', value: 'Ada' }],
  })
  const j = await r.json()
  eq(r.status, 422, 'status')
  eq(j.fields.sort(), ['email', 'last-name'], 'missing fields')
})

await check('malformed email -> 422', async () => {
  const r = await post('/api/forms/contact', {
    ...validContact,
    fields: validContact.fields.map((f) =>
      f.name === 'email' ? { ...f, value: 'not-an-email' } : f,
    ),
  })
  eq(r.status, 422, 'status')
})

// The regression that the first run caught: repeated validation failures must
// not consume the strict submit budget.
await check('10 validation failures do NOT lock the user out', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await post('/api/forms/contact', {
      ...validContact,
      fields: validContact.fields.map((f) =>
        f.name === 'email' ? { ...f, value: 'still-wrong' } : f,
      ),
    })
    eq(r.status, 422, `attempt ${i + 1} status`)
  }
  // A correct submission right afterwards must still get through to delivery.
  const r = await post('/api/forms/contact', validContact)
  eq(r.status, 502, 'corrected submission reaches delivery')
})

await check('honeypot is silently accepted (bot learns nothing)', async () => {
  const r = await post('/api/forms/contact', { ...validContact, _hp: 'gotcha' })
  eq(r.status, 200, 'status')
  eq((await r.json()).ok, true, 'ok')
})

await check('sub-1.5s submit is silently accepted', async () => {
  eq((await post('/api/forms/contact', { ...validContact, _t: 200 })).status, 200, 'status')
})

await check('no email provider -> 502 naming the fallback inbox', async () => {
  const r = await post('/api/forms/contact', validContact)
  const j = await r.json()
  eq(r.status, 502, 'status')
  if (!j.reference) throw new Error('expected a reference id for recovery')
  if (!j.error.includes('hello@thelabgroup.com')) throw new Error('should name fallback inbox')
})

await check('malformed JSON -> 400', async () => {
  eq((await post('/api/forms/contact', '{oops')).status, 400, 'status')
})

await check('urlencoded (no-JS) submit redirects to thank-you', async () => {
  const r = await fetch(BASE + '/api/forms/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'first-name': 'Grace',
      'last-name': 'Hopper',
      email: 'grace@example.com',
      _hp: '',
    }).toString(),
    redirect: 'manual',
  })
  // No email provider configured, so this lands on the error redirect; either
  // way it must be a 303 to an HTML page, never a JSON blob.
  eq(r.status, 303, 'status')
  if (!r.headers.get('location')) throw new Error('missing Location header')
})

await check('strict tier still stops repeated valid submissions', async () => {
  const codes = []
  for (let i = 0; i < 6; i++) codes.push((await post('/api/forms/contact', validContact)).status)
  if (!codes.includes(429)) throw new Error(`expected a 429 among ${codes}`)
})

await check('oversized body -> 413', async () => {
  const r = await post('/api/forms/contact', {
    ...validContact,
    fields: [{ name: 'x', label: 'x', value: 'A'.repeat(100 * 1024) }],
  })
  eq(r.status, 413, 'status')
})

child.kill('SIGTERM')
await sleep(300)
child.kill('SIGKILL')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
