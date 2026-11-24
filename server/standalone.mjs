#!/usr/bin/env node
// Runs the session sync server. Node only, no dependencies.
//   node server/standalone.mjs --pair [--dir D]                 print a one-time pairing code (valid 10 min) and exit
//   node server/standalone.mjs [--dir D] [--host H] [--port P]  serve (defaults: dir ./data, host 127.0.0.1, port 8787; port 0 picks a free one)
// State lives in D: devices.json (hashed tokens), pair.json and session-sync.json (the encrypted blob).
// Put it behind HTTPS (e.g. Tailscale Serve); the extension only talks plain http to loopback in its test mode.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionSyncHandler, issuePairCode } from './sync-server.mjs'

const BODY_MAX = 2 * 1024 * 1024
export const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
export const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}
export const tokenOk = (given, stored) => {
  if (typeof given !== 'string' || typeof stored !== 'string' || !given || !stored) return false
  const h = s => createHash('sha256').update(s).digest()

  return timingSafeEqual(h(given), h(stored))
}
// The body as a Buffer, or null when it is over the 2 MB cap.
const readRaw = req => new Promise(done => {
  const chunks = []
  let n = 0
  let over = false
  req.on('data', c => {
    n += c.length
    if (n > 64 * BODY_MAX) req.destroy()
    if (over) return
    if (n > BODY_MAX) { over = true; chunks.length = 0; return }
    chunks.push(c)
  })
  req.on('end', () => done(over ? null : Buffer.concat(chunks)))
  req.on('error', () => done(null))
})

export function start({ dir, host = '127.0.0.1', port = 8787, log = () => {} }) {
  const handler = createSessionSyncHandler({ dir, log, now: Date.now, readJson, writeJson, tokenOk, readRaw })
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path !== '/api/hub/session-sync' && path !== '/api/hub/session-sync/pair') { res.writeHead(404); return res.end() }
    handler(req, res, path).catch(() => { res.writeHead(500); res.end() })
  })

  return new Promise(ok => server.listen(port, host, () => ok(server)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const opt = (name, d) => (a.includes(name) ? a[a.indexOf(name) + 1] : d)
  const dir = resolve(opt('--dir', 'data'))
  if (a.includes('--pair')) {
    console.log(issuePairCode({ dir, writeJson }))
  } else {
    const server = await start({ dir, host: opt('--host', '127.0.0.1'), port: Number(opt('--port', 8787)), log: m => console.log(m) })
    const { address, port } = server.address()
    console.log(`listening http://${address}:${port}`)
  }
}
