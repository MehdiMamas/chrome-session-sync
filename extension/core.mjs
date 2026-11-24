// Pure logic of the session sync extension: no chrome.* calls, so node:test runs it.
// Blob on the hub = [1 byte format][4 byte key check][2 byte aad length][aad JSON {v, from, at}][12 byte iv][AES-GCM ciphertext].
// The plaintext is JSON {counter, entries, sites}. The key is a random 32-byte secret; two non-extractable CryptoKeys derive from it (HKDF).
// Key rule: the keys live in IndexedDB as CryptoKey objects, NEVER in chrome.storage.sync (that would upload them to Google).

export const FORMAT = 1
export const SESSION_DAYS = 7
export const TOMBSTONE_DAYS = 30
const DAY = 86400000
const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64uEncode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const b64uDecode = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

// A new random key as the string the user saves in the password manager.
export const generateKeyString = () => b64uEncode(crypto.getRandomValues(new Uint8Array(32)))

// The key string back to 32 bytes; null when it is not one.
export function parseKeyString(s) {
  try {
    const raw = b64uDecode(String(s).trim())

    return raw.length === 32 ? raw : null
  } catch { return null }
}

// Two non-extractable keys from the 32 secret bytes.
export async function deriveKeys(raw) {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  const salt = enc.encode('session-sync-v1')
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aes') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const mac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('mac') }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])

  return { aes, mac }
}

// 4 bytes of an HMAC of a fixed label: a wrong key is caught before anything is pushed.
export async function keyCheck(keys) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, enc.encode('session-sync key check'))).slice(0, 4)
}

export async function encryptBlob(keys, aad, plain) {
  const aadBytes = enc.encode(JSON.stringify({ v: aad.v, from: aad.from, at: aad.at }))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes }, keys.aes, enc.encode(JSON.stringify(plain))))
  const head = new Uint8Array(1 + 4 + 2)
  head[0] = FORMAT
  head.set(await keyCheck(keys), 1)
  new DataView(head.buffer).setUint16(5, aadBytes.length)
  const out = new Uint8Array(head.length + aadBytes.length + 12 + ct.length)
  out.set(head, 0)
  out.set(aadBytes, head.length)
  out.set(iv, head.length + aadBytes.length)
  out.set(ct, head.length + aadBytes.length + 12)

  return out
}

// Throws an Error whose code is 'corrupt' (not a blob of ours) or 'wrong-key' (key check differs, or GCM fails).
export async function decryptBlob(keys, bytes) {
  const fail = code => Object.assign(new Error(code), { code })
  if (!(bytes instanceof Uint8Array) || bytes.length < 7 + 12 + 16 || bytes[0] !== FORMAT) throw fail('corrupt')
  const aadLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(5)
  if (bytes.length < 7 + aadLen + 12 + 16) throw fail('corrupt')
  const check = await keyCheck(keys)
  if (!check.every((b, i) => b === bytes[1 + i])) throw fail('wrong-key')
  const aadBytes = bytes.slice(7, 7 + aadLen)
  let aad
  try { aad = JSON.parse(dec.decode(aadBytes)) } catch { throw fail('corrupt') }
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(7 + aadLen, 19 + aadLen), additionalData: aadBytes }, keys.aes, bytes.slice(19 + aadLen))

    return { aad, plain: JSON.parse(dec.decode(pt)) }
  } catch { throw fail('corrupt') }
}

// The registrable-ish site of a cookie domain: leading dot dropped, lower case.
export const siteOfDomain = domain => String(domain ?? '').replace(/^\./, '').toLowerCase()

// True when the cookie's domain is the site or a subdomain of it.
export const inSite = (domain, site) => {
  const d = siteOfDomain(domain)

  return d === site || d.endsWith(`.${site}`)
}

export const allowedFor = (domain, sites) => sites.some(s => inSite(domain, s))

// What the user types for a site ("https://www.GitHub.com/x", "github.com") as a bare host; '' when it is not one.
export function normalizeSite(input) {
  let s = String(input ?? '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*?\./, '')

  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s) ? s : ''
}

// What the user types for the hub address ("hub.example.ts.net", "https://hub.example.ts.net:8443/") as an origin; '' when it is not usable.
// Plain http is accepted only for 127.0.0.1 / localhost and only in test mode.
export function normalizeHubUrl(input, testMode = false) {
  let s = String(input ?? '').trim()
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u
  try { u = new URL(s) } catch { return '' }
  if (u.protocol === 'https:') return u.origin
  if (testMode && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin

  return ''
}

// Cheap non-cryptographic hash (a change detector, not a security check).
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

const pkOf = c => (c.partitionKey ? JSON.stringify([c.partitionKey.topLevelSite ?? '', c.partitionKey.hasCrossSiteAncestor ?? false]) : '')

// Identity of a cookie across machines.
export const cookieKey = c => `${c.name}|${siteOfDomain(c.domain)}|${c.path}|${pkOf(c)}`

// Content hash. Leaves out expiry, the session flag and storeId: a session cookie we wrote with a 7-day expiry must hash like the original.
export const cookieHash = c => hash53(JSON.stringify([c.name, c.value, siteOfDomain(c.domain), c.path, Boolean(c.secure), Boolean(c.httpOnly), c.sameSite ?? 'unspecified', Boolean(c.hostOnly), pkOf(c)]))

// The part of a Chrome cookie that travels. A session cookie carries no expiry.
export function toStored(c, session = c.session) {
  const o = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), sameSite: c.sameSite ?? 'unspecified', hostOnly: Boolean(c.hostOnly), session: Boolean(session) }
  if (!session && c.expirationDate) o.expirationDate = c.expirationDate
  if (c.partitionKey) o.partitionKey = c.partitionKey
  if (c.storeId) o.storeId = c.storeId

  return o
}

// Arguments for chrome.cookies.set. A session cookie gets an expiry of SESSION_DAYS (refreshed at each sync).
export function toSetDetails(c, now) {
  const host = siteOfDomain(c.domain)
  const hostPrefix = c.name.startsWith('__Host-')
  const secure = hostPrefix || c.name.startsWith('__Secure-') ? true : Boolean(c.secure)
  const path = hostPrefix ? '/' : c.path
  const d = { url: `http${secure ? 's' : ''}://${host}${path}`, name: c.name, value: c.value, path, secure, httpOnly: Boolean(c.httpOnly), sameSite: c.sameSite ?? 'unspecified' }
  if (!c.hostOnly && !hostPrefix) d.domain = c.domain
  if (c.session) d.expirationDate = Math.floor(now / 1000) + SESSION_DAYS * 86400
  else if (c.expirationDate) d.expirationDate = c.expirationDate
  if (c.partitionKey) d.partitionKey = c.partitionKey
  if (c.storeId) d.storeId = c.storeId

  return d
}

// onChanged: what a change means. Only an explicit removal becomes a tombstone; expired, evicted and overwrite never do.
export function changeKind(info) {
  if (!info?.cookie) return null
  if (!info.removed) return 'upsert'

  return info.cause === 'explicit' ? 'tombstone' : null
}

// A change whose content hash equals the one we last applied or saw is ignored (our own set() coming back through onChanged).
export function isEcho(entries, info) {
  if (!info?.cookie || info.removed) return false
  const e = entries?.[cookieKey(info.cookie)]

  return Boolean(e && !e.deleted && e.hash === cookieHash(info.cookie))
}

// Newest seenAt wins; a tie goes to the larger hash; equal content keeps the existing (remote) entry so a cookie both machines already have does not rewrite the blob.
export function pickEntry(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.hash === b.hash && Boolean(a.deleted) === Boolean(b.deleted)) return a
  if (a.seenAt !== b.seenAt) return a.seenAt > b.seenAt ? a : b

  return a.hash >= b.hash ? a : b
}

// remote and local are {key: entry}. Entries of sites this machine does not allow stay as they are in remote.
export function mergeEntries(remote, local) {
  const out = { ...remote }
  for (const [k, e] of Object.entries(local)) out[k] = pickEntry(out[k], e)

  return out
}

// Sites travel as {site: {site, at, removed?}}; last write wins.
export function mergeSites(remote, local) {
  const out = { ...remote }
  for (const [k, s] of Object.entries(local)) if (!out[k] || s.at > out[k].at) out[k] = s

  return out
}

export const activeSites = records => Object.values(records).filter(s => !s.removed).map(s => s.site).sort()

// Hash of what the blob says, without the counter: a push happens only when this changed.
export function plainHash(plain) {
  const keys = Object.keys(plain.entries).sort()

  return hash53(JSON.stringify([keys.map(k => [k, plain.entries[k].hash, Boolean(plain.entries[k].deleted)]), Object.values(plain.sites).map(s => [s.site, s.at, Boolean(s.removed)]).sort()]))
}

// A session cookie we wrote carries an expiry; refresh it when less than this is left.
const REFRESH_BELOW_S = (SESSION_DAYS - 1) * 86400

/**
 * One sync round, pure. Input:
 *   keys, remote (Uint8Array|null), state {highest, entries:{k:{hash,seenAt,deleted?,session?}}}, scan {k: Chrome cookie} of this machine's allowed sites,
 *   siteRecords (this machine's site records), granted (sites this machine may touch), removedKeys (Set of keys the user removed), seen {k: ms} (onChanged times),
 *   now, from, rev (the server revision after the push), reset (user clicked Reset).
 * Output: {status:'ok'|'wrong-key'|'corrupt'|'rollback', toSet, toRemove, push (Uint8Array|null), state, siteRecords}.
 * A client never pushes over a blob it can't decrypt, and refuses a lower counter; only reset=true skips both.
 */
export async function planSync({ keys, remote, state, scan, siteRecords, granted, removedKeys = new Set(), seen = {}, now, from, rev, reset = false }) {
  let remotePlain = null
  if (remote && !reset) {
    try {
      remotePlain = (await decryptBlob(keys, remote)).plain
    } catch (e) { return { status: e.code ?? 'corrupt', toSet: [], toRemove: [], push: null, state, siteRecords } }
    if (remotePlain.counter < state.highest) return { status: 'rollback', toSet: [], toRemove: [], push: null, state, siteRecords }
  }
  const remoteEntries = remotePlain?.entries ?? {}
  const sites = mergeSites(remotePlain?.sites ?? {}, siteRecords)
  const allow = activeSites(sites).filter(s => granted.includes(s))

  // This machine's view: unchanged cookies keep their seenAt; changed or new ones get the time onChanged saw them (else now).
  const local = {}
  for (const [k, c] of Object.entries(scan)) {
    if (!allowedFor(c.domain, allow)) continue
    const h = cookieHash(c)
    const prev = state.entries[k]
    // First contact (site just added here, or first sync): a cookie of unknown age defers to the hub's copy, so a stale or signed-out
    // cookie on a joining machine can not overwrite the sign-in another machine pushed.
    if (!prev && seen[k] === undefined && remoteEntries[k]) continue
    const keep = prev && !prev.deleted && prev.hash === h
    const session = keep && prev.session !== undefined ? prev.session : c.session
    local[k] = { k, hash: h, seenAt: keep ? prev.seenAt : seen[k] ?? now, cookie: toStored(c, session) }
  }
  for (const [k, prev] of Object.entries(state.entries)) {
    if (local[k] || scan[k]) continue
    if (prev.deleted) local[k] = prev
    else if (removedKeys.has(k)) local[k] = { k, hash: 'deleted', seenAt: seen[k] ?? now, deleted: true }
  }

  const merged = mergeEntries(remoteEntries, local)
  for (const [k, e] of Object.entries(merged)) if (e.deleted && e.seenAt < now - TOMBSTONE_DAYS * DAY) delete merged[k]

  const toSet = []
  const toRemove = []
  const newEntries = {}
  for (const [k, e] of Object.entries(merged)) {
    const domain = e.cookie?.domain ?? k.split('|')[1]
    if (!allowedFor(domain, allow)) continue
    newEntries[k] = { hash: e.hash, seenAt: e.seenAt, ...(e.deleted ? { deleted: true } : {}), ...(e.cookie?.session ? { session: true } : {}) }
    const here = scan[k]
    if (e.deleted) {
      if (here) toRemove.push({ url: toSetDetails(toStored(here), now).url, name: here.name, ...(here.storeId ? { storeId: here.storeId } : {}), ...(here.partitionKey ? { partitionKey: here.partitionKey } : {}) })
    } else if (!here || cookieHash(here) !== e.hash) {
      toSet.push(toSetDetails(e.cookie, now))
    } else if (e.cookie.session && (here.session || (here.expirationDate ?? 0) - now / 1000 < REFRESH_BELOW_S)) {
      toSet.push(toSetDetails(e.cookie, now))
    }
  }

  const next = { counter: 0, entries: merged, sites }
  const changed = reset || !remotePlain ? Object.keys(merged).length > 0 || Object.keys(sites).length > 0 : plainHash(next) !== plainHash(remotePlain)
  let push = null
  const highest = Math.max(state.highest, remotePlain?.counter ?? 0)
  let counter = highest
  if (changed) {
    counter = reset ? Math.max(highest + 1, now) : highest + 1
    next.counter = counter
    push = await encryptBlob(keys, { v: rev, from, at: now }, next)
  }

  return { status: 'ok', toSet, toRemove, push, state: { highest: counter, entries: newEntries }, siteRecords: sites }
}
