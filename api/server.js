/**
 * node:http adapter for the form handler.
 *
 * Production runs on Cloudflare Workers (worker/index.js), which speaks the
 * fetch API natively. This wrapper exists so the same handler can be exercised
 * without wrangler: `tools/dev-server.mjs` proxies /api/* here while developing,
 * and the test suite in api/test drives it directly.
 *
 * All of the behaviour lives in worker/forms.js — this file only converts
 * between node:http's req/res pair and the Request/Response the handler wants.
 *
 * Local use:
 *   npm --prefix api start
 *   npm --prefix api test
 */

import http from 'node:http'
import { Readable } from 'node:stream'

import { handleApiRequest, readConfig, log } from '../worker/forms.js'

const PORT = Number(process.env.PORT) || 3000

/** node:http request -> fetch Request. */
function toRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry)
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url, {
    method: req.method,
    headers,
    // Streamed rather than buffered, so an oversized upload is refused on its
    // Content-Length without being read into memory first.
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  })
}

/** fetch Response -> node:http response. */
async function send(req, res, response) {
  const headers = Object.fromEntries(response.headers)
  res.writeHead(response.status, headers)

  // We refused mid-upload, so the client is probably still sending. Close the
  // connection once the response is safely flushed - destroying it any earlier
  // reaches the browser as a network error rather than as the 413 it needs to
  // see.
  if (response.status === 413) res.on('finish', () => res.socket?.destroy())

  if (response.body) {
    for await (const chunk of response.body) res.write(chunk)
  }
  res.end()
}

const server = http.createServer((req, res) => {
  handleApiRequest(toRequest(req), process.env)
    .then((response) => send(req, res, response))
    .catch((err) => {
      log('error', 'adapter_failed', { error: err.message, stack: err.stack })
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'Something went wrong on our end.' }))
      } else {
        res.end()
      }
    })
})

// Bind on :: so both address families reach it; dual-stack sockets accept IPv4
// as well, which covers whichever shape a local proxy resolves.
server.listen(PORT, '::', () => {
  const config = readConfig(process.env)
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
