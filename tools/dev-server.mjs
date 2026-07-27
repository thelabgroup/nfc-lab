/**
 * Local stand-in for the Caddy config, so the site and its forms can be
 * exercised without deploying.
 *
 * Mirrors the two routing rules that matter:
 *   /api/*  -> proxied to the forms service (Caddy: reverse_proxy)
 *   /*      -> static files, with .html extension fallback (Caddy: try_files)
 *
 * It deliberately does NOT reproduce basic auth, the cache policy or the
 * security headers — those are Caddy's job and are verified on deploy.
 *
 * Usage:
 *   node api/server.js &          # or: npm --prefix api start
 *   node tools/dev-server.mjs     # serves http://localhost:8080
 */

import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DEV_PORT) || 8080
const API_UPSTREAM = process.env.FORMS_UPSTREAM || 'http://127.0.0.1:3000'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

async function readFileIfPresent(candidate) {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return null
    return await fs.readFile(candidate)
  } catch {
    return null
  }
}

async function proxyToApi(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  try {
    const upstream = await fetch(API_UPSTREAM + req.url, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'X-Forwarded-For': req.socket.remoteAddress || '127.0.0.1',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    })
    const text = await upstream.text()
    const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/json' }
    const location = upstream.headers.get('location')
    if (location) headers.Location = location
    res.writeHead(upstream.status, headers)
    res.end(text)
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `forms service unreachable: ${err.message}` }))
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname.startsWith('/api/')) return proxyToApi(req, res)

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const base = path.resolve(ROOT, rel || 'index.html')

  // Refuse to serve anything outside the repo.
  if (!base.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  // Caddy's try_files {path} {path}.html {path}/index.html
  const candidates = [base, `${base}.html`, path.join(base, 'index.html')]
  for (const candidate of candidates) {
    const body = await readFileIfPresent(candidate)
    if (body) {
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
      })
      res.end(body)
      return
    }
  }

  const notFound = await readFileIfPresent(path.join(ROOT, '404.html'))
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(notFound || 'Not found')
})

server.listen(PORT, () => {
  console.log(`site   http://localhost:${PORT}`)
  console.log(`  contact  http://localhost:${PORT}/support/contact-2`)
  console.log(`  pricing  http://localhost:${PORT}/pricing/pricing-1`)
  console.log(`  search   http://localhost:${PORT}/search`)
  console.log(`api    proxying /api/* -> ${API_UPSTREAM}`)
})
