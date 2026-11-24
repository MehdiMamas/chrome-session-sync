#!/usr/bin/env node
// End-to-end check of the session sync extension: the standalone server on loopback, two headless Chrome for Testing profiles with the extension loaded.
// A cookie set in profile 1 must appear in profile 2, and the server file must not hold its value. No windows, never branded Chrome.
//   CHROME=/path/to/chrome [LD_LIBRARY_PATH=...] node scripts/e2e.mjs
// The extension is loaded from a temp copy whose manifest also lists host_permissions for the loopback hub and localhost (a headless run
// can not click the permission prompt); the server address is allowed as plain http only through the extension's test-mode flag.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSION_SYNC_ORIGIN } from '../server/sync-server.mjs'

const CHROME = process.env.CHROME
if (!CHROME || !existsSync(CHROME)) { console.error('Set CHROME to a Chrome for Testing binary (never branded Chrome).'); process.exit(3) }
const here = dirname(fileURLToPath(import.meta.url))
const EXT_ID = SESSION_SYNC_ORIGIN.replace('chrome-extension://', '')
const root = mkdtempSync(join(tmpdir(), 'session-sync-e2e-'))
const procs = []
const VALUE = `E2E_VALUE_${Math.random().toString(36).slice(2, 12)}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const { ok, bad } = waiting.get(m.id); waiting.delete(m.id); m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result) } }
  const opened = new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
  const call = (method, params = {}, sessionId) => new Promise((ok, bad) => { const i = ++id; waiting.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })

  return { opened, call, close: () => ws.close() }
}

async function launch(n, extDir) {
  const dir = join(root, `profile${n}`)
  mkdirSync(dir)
  const p = spawn(CHROME, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${dir}`, '--remote-debugging-port=0', `--load-extension=${extDir}`, 'about:blank'], { stdio: 'ignore', windowsHide: true })
  procs.push(p)
  let ws = ''
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(200)
    try { const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n'); ws = `ws://127.0.0.1:${port}${path}` } catch { /* not yet */ }
  }
  if (!ws) throw new Error(`profile ${n}: Chrome did not start`)
  const c = cdp(ws)
  await c.opened
  // An extension page of ours: the place to send messages and read cookies from.
  let target
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await c.call('Target.createTarget', { url: `chrome-extension://${EXT_ID}/options.html` })).targetId } catch { await sleep(200) }
  }
  const { sessionId } = await c.call('Target.attachToTarget', { targetId: target, flatten: true })
  await sleep(500)
  const run = async expression => {
    const r = await c.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))

    return r.result.value
  }
  const send = m => run(`chrome.runtime.sendMessage(${JSON.stringify(m)})`)

  return { n, c, run, send }
}

let server
let code = 1
try {
  const ext = join(root, 'ext')
  cpSync(join(here, '..', 'extension'), ext, { recursive: true, filter: s => !s.endsWith('.test.mjs') })
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  manifest.host_permissions = ['http://127.0.0.1/*', '*://localhost/*']
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))

  const home = join(root, 'home')
  mkdirSync(home)
  const standalone = join(here, '..', 'server', 'standalone.mjs')
  server = spawn(process.execPath, [standalone, '--dir', home, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  procs.push(server)
  const hubUrl = await new Promise((ok, bad) => {
    let out = ''
    server.stdout.on('data', c => { out += c; const m = /listening (http:\/\/\S+)/.exec(out); if (m) ok(m[1]) })
    server.on('exit', () => bad(new Error('the server exited')))
    setTimeout(() => bad(new Error('the server did not start')), 10000)
  })
  const newCode = () => spawnSync(process.execPath, [standalone, '--dir', home, '--pair'], { encoding: 'utf8', windowsHide: true }).stdout.trim()

  const p1 = await launch(1, ext)
  const p2 = await launch(2, ext)
  let key
  for (const p of [p1, p2]) {
    await p.send({ type: 'set-test-mode', on: true })
    const saved = await p.send({ type: 'save-hub', hubUrl })
    if (saved.error) throw new Error(saved.error)
    const paired = await p.send({ type: 'pair', code: newCode() })
    if (paired.error) throw new Error(paired.error)
    const k = await p.send({ type: 'set-key', ...(key ? { key } : {}) })
    if (k.error) throw new Error(k.error)
    key ??= k.key
  }

  // Cookies in profile 1: one plain, one Secure + HttpOnly (the real shape of a sign-in).
  const url = 'http://localhost/'
  await p1.c.call('Storage.setCookies', { cookies: [
    { name: 'e2e_plain', value: VALUE, url },
    { name: 'e2e_secure', value: `${VALUE}_S`, url, secure: true, httpOnly: true, sameSite: 'Lax' },
  ] })
  await p1.send({ type: 'add-site', site: 'localhost' })
  console.log('profile 1 sync:', JSON.stringify(await p1.send({ type: 'sync-now' })))
  console.log('profile 2 sync:', JSON.stringify(await p2.send({ type: 'sync-now' })))
  const got = await p2.run('chrome.cookies.getAll({domain: "localhost"}).then(l => l.map(c => ({name: c.name, value: c.value, secure: c.secure, httpOnly: c.httpOnly})))')
  console.log('profile 2 cookies:', got.map(c => `${c.name}${c.secure ? ' [secure]' : ''}${c.httpOnly ? ' [httpOnly]' : ''}`).join(', '))
  const plain = got.find(c => c.name === 'e2e_plain')
  const sec = got.find(c => c.name === 'e2e_secure')
  if (plain?.value !== VALUE) throw new Error('the plain cookie did not reach profile 2')
  if (sec?.value !== `${VALUE}_S` || !sec.secure || !sec.httpOnly) throw new Error('the Secure HttpOnly cookie did not reach profile 2 intact')

  const file = join(home, 'session-sync.json')
  const g = spawnSync('grep', ['-c', VALUE, file], { encoding: 'utf8', windowsHide: true })
  console.log(`grep -c <value> session-sync.json: ${g.stdout.trim()}`)
  if (g.stdout.trim() !== '0') throw new Error('the cookie value is in the server file')
  console.log('PASS')
  code = 0
} catch (e) {
  console.error('FAIL:', e.message)
} finally {
  for (const p of procs) p.kill('SIGKILL')
  await sleep(300)
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
