import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveKeys, encryptBlob, generateKeyString, parseKeyString } from '../extension/core.mjs'
import { SESSION_SYNC_ORIGIN, issuePairCode } from '../server/sync-server.mjs'
import { start, writeJson } from '../server/standalone.mjs'

// A standalone server on a free loopback port; home is its state dir.
async function boot({ log = () => {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'css-'))
  const s = await start({ dir: home, port: 0, log })
  const close = s.close.bind(s)
  s.close = () => { close(); rmSync(home, { recursive: true, force: true }) }

  return { home, s, hub: `http://127.0.0.1:${s.address().port}` }
}
const pairCode = t => issuePairCode({ dir: t.home, writeJson })

test('session sync route: pairing, bearer auth, origin guard, ETag, If-Match, no plaintext on disk, quiet logs', async () => {
    const logs = []
  const t = await boot({ log: m => logs.push(m) })
  const url = `${t.hub}/api/hub/session-sync`
  const O = { Origin: SESSION_SYNC_ORIGIN }
  try {
    // pairing: wrong origin and wrong code are refused; the right pair gives a token, once
    const code = pairCode(t)
    assert.equal((await fetch(`${url}/pair`, { method: 'POST', body: JSON.stringify({ code }) })).status, 403)
    assert.equal((await fetch(`${url}/pair`, { method: 'POST', headers: O, body: JSON.stringify({ code: 'nope' }) })).status, 403)
    const paired = await fetch(`${url}/pair`, { method: 'POST', headers: O, body: JSON.stringify({ code }) })
    assert.equal(paired.status, 200)
    const { token } = await paired.json()
    assert.equal((await fetch(`${url}/pair`, { method: 'POST', headers: O, body: JSON.stringify({ code }) })).status, 403)
    const devices = readFileSync(join(t.home, 'devices.json'), 'utf8')
    assert.ok(!devices.includes(token), 'the token is stored hashed')
    const A = { Authorization: `Bearer ${token}` }

    // auth and origin guard
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401)
    assert.equal((await fetch(url, { headers: A })).status, 404, 'no blob yet, no Origin on GET passes on the token')
    assert.equal((await fetch(url, { headers: { ...A, Origin: 'https://evil.test' } })).status, 403)
    assert.equal((await fetch(url, { method: 'PUT', headers: A, body: 'x' })).status, 403, 'PUT without Origin')
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...A, Origin: 'https://evil.test' }, body: 'x' })).status, 403)
    assert.equal((await fetch(url, { method: 'DELETE', headers: A })).status, 403)
    assert.equal((await fetch(url, { method: 'PUT', headers: O, body: 'x' })).status, 401)
    const PH = { ...A, ...O }

    // a real blob: no cookie name or value in the stored file
    const keys = await deriveKeys(parseKeyString(generateKeyString()))
    const blob = await encryptBlob(keys, { v: 1, from: 'a', at: 1 }, { counter: 1, entries: { 'FAKE_NAME|x.test|/|': { cookie: { name: 'FAKE_NAME', value: 'FAKE_VALUE_123' } } }, sites: {} })
    const put = await fetch(url, { method: 'PUT', headers: PH, body: blob })
    assert.equal(put.status, 200)
    assert.equal(put.headers.get('etag'), '"1"')
    const file = join(t.home, 'session-sync.json')
    const stored = readFileSync(file, 'utf8')
    assert.ok(!stored.includes('FAKE_NAME') && !stored.includes('FAKE_VALUE_123'))
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.ok(!existsSync(`${file}.tmp`))

    // a second first-write is refused; stale If-Match is 412; the right one wins
    assert.equal((await fetch(url, { method: 'PUT', headers: PH, body: blob })).status, 412)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...PH, 'If-None-Match': '*' }, body: blob })).status, 412)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...PH, 'If-Match': '"7"' }, body: blob })).status, 412)
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...PH, 'If-Match': '"1"' }, body: blob })).status, 200)

    // GET: bytes back, ETag, 304
    const got = await fetch(url, { headers: A })
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('etag'), '"2"')
    assert.equal(got.headers.get('access-control-allow-origin'), null)
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), Buffer.from(blob))
    assert.equal((await fetch(url, { headers: { ...A, 'If-None-Match': '"2"' } })).status, 304)

    // reset with If-Match *, then DELETE
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...PH, 'If-Match': '*' }, body: blob })).status, 200)
    assert.equal((await fetch(url, { method: 'DELETE', headers: PH })).status, 204)
    assert.equal((await fetch(url, { headers: A })).status, 404)
    assert.equal((await fetch(url, { method: 'PUT', headers: PH, body: blob })).status, 200, 'a deleted blob takes a first write again')
    assert.equal((await fetch(url, { method: 'POST', headers: PH, body: 'x' })).status, 405)

    // revoke: removing the entry from devices.json stops the token
    const devFile = join(t.home, 'devices.json')
    writeFileSync(devFile, JSON.stringify(JSON.parse(devices).filter(d => !d.ext)))
    assert.equal((await fetch(url, { headers: A })).status, 401)

    // logs hold sizes and status codes only
    assert.ok(logs.some(l => l.includes('session-sync')))
    const all = logs.join('\n')
    assert.ok(!all.includes(token) && !all.includes('FAKE_') && !all.includes('"1"') && !all.includes(Buffer.from(blob).toString('base64').slice(0, 20)))
  } finally { t.s.close() }
})

test('session sync route: a body over 2 MB is 413', async () => {
  const t = await boot()
  try {
    const code = pairCode(t)
    const url = `${t.hub}/api/hub/session-sync`
    const { token } = await (await fetch(`${url}/pair`, { method: 'POST', headers: { Origin: SESSION_SYNC_ORIGIN }, body: JSON.stringify({ code }) })).json()
    const r = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, Origin: SESSION_SYNC_ORIGIN }, body: Buffer.alloc(2 * 1024 * 1024 + 10) })
    assert.equal(r.status, 413)
  } finally { t.s.close() }
})


