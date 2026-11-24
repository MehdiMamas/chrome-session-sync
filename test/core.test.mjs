import test from 'node:test'
import assert from 'node:assert/strict'
import { cookieKey, changeKind, decryptBlob, deriveKeys, encryptBlob, generateKeyString, isEcho, cookieHash, mergeEntries, normalizeHubUrl, normalizeSite, parseKeyString, planSync, toSetDetails, toStored, SESSION_DAYS } from '../extension/core.mjs'

const mk = async () => deriveKeys(parseKeyString(generateKeyString()))
const ck = (name, value, domain = 'github.com', extra = {}) => ({ name, value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'lax', hostOnly: true, session: false, expirationDate: 2000000000, ...extra })
const scanOf = (...cs) => Object.fromEntries(cs.map(c => [cookieKey(c), c]))
const base = (keys, over = {}) => ({ keys, remote: null, state: { highest: 0, entries: {} }, scan: {}, siteRecords: { 'github.com': { site: 'github.com', at: 1 } }, granted: ['github.com'], now: 1000, from: 'a', rev: 1, ...over })

test('a blob round-trips and a wrong key is caught by the key check', async () => {
  const k1 = await mk()
  const k2 = await mk()
  const blob = await encryptBlob(k1, { v: 1, from: 'a', at: 5 }, { counter: 1, entries: {}, sites: {} })
  const r = await decryptBlob(k1, blob)
  assert.deepEqual(r.aad, { v: 1, from: 'a', at: 5 })
  await assert.rejects(decryptBlob(k2, blob), { code: 'wrong-key' })
  const tampered = blob.slice()
  tampered[tampered.length - 1] ^= 1
  await assert.rejects(decryptBlob(k1, tampered), { code: 'corrupt' })
  const aadTampered = blob.slice()
  aadTampered[10] ^= 1
  await assert.rejects(decryptBlob(k1, aadTampered), { code: 'corrupt' })
})

test('the first sync pushes this machine\'s cookies; the blob holds no plain name or value', async () => {
  const keys = await mk()
  const r = await planSync(base(keys, { scan: scanOf(ck('sid', 'SECRETVAL')) }))
  assert.equal(r.status, 'ok')
  assert.ok(r.push)
  const text = Buffer.from(r.push).toString('latin1')
  assert.ok(!text.includes('SECRETVAL') && !text.includes('sid'))
  assert.equal((await decryptBlob(keys, r.push)).plain.counter, 1)
})

test('merge keeps entries of sites this machine does not allow', async () => {
  const keys = await mk()
  const a = await planSync(base(keys, { scan: scanOf(ck('o', 'v', 'other.com')), siteRecords: { 'other.com': { site: 'other.com', at: 1 } }, granted: ['other.com'] }))
  const b = await planSync(base(keys, { remote: a.push, state: { highest: 0, entries: {} }, scan: scanOf(ck('g', 'v')), rev: 2 }))
  const plain = (await decryptBlob(keys, b.push)).plain
  assert.ok(plain.entries[cookieKey(ck('o', 'v', 'other.com'))])
  assert.ok(plain.entries[cookieKey(ck('g', 'v'))])
  assert.equal(plain.counter, 2)
  assert.deepEqual(b.toSet, [])
})

test('a pulled cookie is set; an unchanged round pushes nothing', async () => {
  const keys = await mk()
  const a = await planSync(base(keys, { scan: scanOf(ck('sid', 'v1')) }))
  const b = await planSync(base(keys, { remote: a.push, rev: 2 }))
  assert.equal(b.toSet.length, 1)
  assert.equal(b.toSet[0].name, 'sid')
  assert.equal(b.toSet[0].url, 'https://github.com/')
  assert.equal(b.toSet[0].domain, undefined)
  assert.equal(b.push, null)
  const c = await planSync(base(keys, { remote: a.push, state: b.state, scan: scanOf(ck('sid', 'v1')), rev: 2 }))
  assert.equal(c.push, null)
  assert.deepEqual(c.toSet, [])
})

test('a blob with a lower counter is refused', async () => {
  const keys = await mk()
  const a = await planSync(base(keys, { scan: scanOf(ck('sid', 'v1')) }))
  const r = await planSync(base(keys, { remote: a.push, state: { highest: 5, entries: {} } }))
  assert.equal(r.status, 'rollback')
  assert.equal(r.push, null)
  assert.deepEqual(r.toSet, [])
})

test('echo: a change whose hash equals the applied one is ignored', async () => {
  const c = ck('sid', 'v1')
  const entries = { [cookieKey(c)]: { hash: cookieHash(c), seenAt: 1 } }
  assert.equal(isEcho(entries, { cookie: c, removed: false }), true)
  assert.equal(isEcho(entries, { cookie: { ...c, value: 'v2' }, removed: false }), false)
  assert.equal(isEcho(entries, { cookie: { ...c, session: true, expirationDate: undefined }, removed: false }), true)
})

test('tombstone rules: only an explicit removal', async () => {
  const c = ck('sid', 'v1')
  assert.equal(changeKind({ cookie: c, removed: true, cause: 'explicit' }), 'tombstone')
  for (const cause of ['expired', 'evicted', 'overwrite', 'expired_overwrite']) assert.equal(changeKind({ cookie: c, removed: true, cause }), null)
  assert.equal(changeKind({ cookie: c, removed: false, cause: 'explicit' }), 'upsert')
  const keys = await mk()
  const first = await planSync(base(keys, { scan: scanOf(c), now: 1 }))
  const state = first.state
  const evicted = await planSync(base(keys, { remote: first.push, state, scan: {}, rev: 2 }))
  assert.equal(evicted.push, null)
  const removed = await planSync(base(keys, { remote: first.push, state, scan: {}, rev: 2, removedKeys: new Set([cookieKey(c)]) }))
  const e = (await decryptBlob(keys, removed.push)).plain.entries[cookieKey(c)]
  assert.equal(e.deleted, true)
  // the tombstone removes the cookie on another machine
  const other = await planSync(base(keys, { remote: removed.push, state: { highest: 0, entries: { [cookieKey(c)]: { hash: cookieHash(c), seenAt: 1 } } }, scan: scanOf(c), now: 2000 }))
  assert.equal(other.toRemove.length, 1)
})

test('newest seenAt wins, a tie goes to the hash', () => {
  const a = { hash: 'a', seenAt: 5 }
  const b = { hash: 'b', seenAt: 9 }
  assert.equal(mergeEntries({ k: a }, { k: b }).k, b)
  assert.equal(mergeEntries({ k: { hash: 'a', seenAt: 5 } }, { k: { hash: 'b', seenAt: 5 } }).k.hash, 'b')
})

test('never pushes over a blob it cannot decrypt; reset replaces it with a higher counter', async () => {
  const k1 = await mk()
  const k2 = await mk()
  const theirs = await planSync(base(k1, { scan: scanOf(ck('sid', 'v1')) }))
  const mine = base(k2, { remote: theirs.push, scan: scanOf(ck('x', 'y')), state: { highest: 3, entries: {} } })
  const refused = await planSync(mine)
  assert.equal(refused.status, 'wrong-key')
  assert.equal(refused.push, null)
  const reset = await planSync({ ...mine, reset: true })
  assert.equal(reset.status, 'ok')
  const plain = (await decryptBlob(k2, reset.push)).plain
  assert.ok(plain.counter > 3)
  assert.ok(plain.entries[cookieKey(ck('x', 'y'))])
  assert.ok(!plain.entries[cookieKey(ck('sid', 'v1'))])
})

test('session cookies are written with a 7-day expiry; __Host- and partitioned cookies keep their rules', () => {
  const now = 1_700_000_000_000
  const s = toSetDetails(toStored(ck('s', 'v', 'github.com', { session: true, expirationDate: undefined })), now)
  assert.equal(s.expirationDate, now / 1000 + SESSION_DAYS * 86400)
  const h = toSetDetails(toStored(ck('__Host-h', 'v', 'a.test', { secure: false, path: '/x' })), now)
  assert.equal(h.secure, true)
  assert.equal(h.path, '/')
  assert.equal(h.domain, undefined)
  const d = toSetDetails(toStored(ck('d', 'v', '.github.com', { hostOnly: false })), now)
  assert.equal(d.domain, '.github.com')
  assert.equal(d.url, 'https://github.com/')
  const p = toSetDetails(toStored(ck('p', 'v', 'a.test', { partitionKey: { topLevelSite: 'https://a.test', hasCrossSiteAncestor: false } })), now)
  assert.deepEqual(p.partitionKey, { topLevelSite: 'https://a.test', hasCrossSiteAncestor: false })
})

test('typed hub addresses and sites are normalised; plain http only in test mode', () => {
  assert.equal(normalizeHubUrl('hub.example.ts.net'), 'https://hub.example.ts.net')
  assert.equal(normalizeHubUrl(' https://hub.example.ts.net:8443/ '), 'https://hub.example.ts.net:8443')
  assert.equal(normalizeHubUrl('http://127.0.0.1:5'), '')
  assert.equal(normalizeHubUrl('http://127.0.0.1:5', true), 'http://127.0.0.1:5')
  assert.equal(normalizeHubUrl('http://evil.test', true), '')
  assert.equal(normalizeSite('https://www.GitHub.com/x?y'), 'www.github.com')
  assert.equal(normalizeSite('*.github.com'), 'github.com')
  assert.equal(normalizeSite('not a site'), '')
})

test('a joining machine\'s cookie of unknown age defers to the hub; one changed here still wins', async () => {
  const keys = await mk()
  const a = await planSync(base(keys, { scan: scanOf(ck('sid', 'signed-in')), now: 1000 }))
  const join = await planSync(base(keys, { remote: a.push, scan: scanOf(ck('sid', 'signed-out')), now: 5000, rev: 2 }))
  assert.equal(join.push, null)
  assert.equal(join.toSet.length, 1)
  assert.equal(join.toSet[0].value, 'signed-in')
  const k = cookieKey(ck('sid', 'x'))
  const changed = await planSync(base(keys, { remote: a.push, scan: scanOf(ck('sid', 'newer')), seen: { [k]: 4000 }, now: 5000, rev: 2 }))
  assert.ok(changed.push)
  assert.equal(changed.toSet.length, 0)
})
