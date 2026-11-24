// Chrome Session Sync service worker. Listeners and alarms are registered at the top level; timers use chrome.alarms, never setTimeout
// (the worker is killed after 30 s idle). The pure logic is in core.mjs. The encryption keys are CryptoKeys in IndexedDB, never chrome.storage.sync.
import { activeSites, changeKind, cookieKey, deriveKeys, generateKeyString, isEcho, normalizeHubUrl, normalizeSite, parseKeyString, planSync, SESSION_DAYS } from './core.mjs'

const PATH = '/api/hub/session-sync'
const get = async keys => chrome.storage.local.get(keys)
const set = async obj => chrome.storage.local.set(obj)

// IndexedDB: the two derived non-extractable keys.
const idb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open('session-sync', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('keys')
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})
const idbRun = async (mode, fn) => {
  const db = await idb()

  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('keys', mode).objectStore('keys'))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const loadKeys = () => idbRun('readonly', s => s.get('keys'))
const saveKeys = keys => idbRun('readwrite', s => s.put(keys, 'keys'))

let chain = Promise.resolve()
const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }

const status = async (state, detail = '') => set({ status: { state, detail, at: Date.now() } })

async function grantedSites(records) {
  const origins = (await chrome.permissions.getAll()).origins ?? []

  return activeSites(records).filter(s => origins.includes(`*://${s}/*`))
}

async function scanAll() {
  const out = {}
  const add = list => { for (const c of list) out[cookieKey(c)] = c }
  add(await chrome.cookies.getAll({}))
  try { add(await chrome.cookies.getAll({ partitionKey: {} })) } catch { /* partitioned cookies not supported here */ }

  return out
}

async function syncRound(reset = false, again = false) {
  const st = await get(['hubUrl', 'token', 'etag', 'state', 'siteRecords', 'seen', 'removed', 'dirty', 'device'])
  const keys = await loadKeys()
  if (!st.hubUrl || !st.token || !keys) return status('not-set-up', 'Set the hub address, pair, and set the key.')
  const headers = { Authorization: `Bearer ${st.token}` }
  const fetchBlob = async etag => fetch(`${st.hubUrl}${PATH}`, { cache: 'no-store', headers: etag ? { ...headers, 'If-None-Match': etag } : headers })
  let res
  try {
    res = await fetchBlob(st.dirty || reset ? null : st.etag)
    if (res.status === 304 && st.dirty) res = await fetchBlob(null)
  } catch { return status('offline', 'The hub did not answer.') }
  if (res.status === 304) return status('ok', 'Up to date.')
  if (res.status === 401 || res.status === 403) return status('unauthorised', 'The hub refused this machine. Pair again.')
  if (res.status !== 200 && res.status !== 404) return status('hub-error', `Hub answered ${res.status}.`)
  const remote = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null
  const rev = res.status === 200 ? Number(/"(\d+)"/.exec(res.headers.get('etag') ?? '')?.[1] ?? 0) : 0
  const records = st.siteRecords ?? {}
  const now = Date.now()
  const plan = await planSync({
    keys, remote, reset, now, from: st.device ?? 'device', rev: rev + 1,
    state: st.state ?? { highest: 0, entries: {} }, scan: await scanAll(), siteRecords: records,
    granted: await grantedSites(records), removedKeys: new Set(st.removed ?? []), seen: st.seen ?? {},
  })
  if (plan.status !== 'ok') return status(plan.status, { 'wrong-key': 'The key does not match the one that wrote the hub blob. Paste the right key, or Reset.', rollback: 'The hub holds an older blob than this machine has seen. Reset if that is expected.', corrupt: 'The hub blob can not be read. Reset to replace it.' }[plan.status] ?? plan.status)
  // plan.siteRecords holds sites added on other machines; one already granted here is synced in a second pass of this round.
  const before = await grantedSites(records)
  const after = await grantedSites(plan.siteRecords)
  if (!again && after.length > before.length) { await set({ siteRecords: plan.siteRecords }); return syncRound(reset, true) }
  for (const d of plan.toSet) { try { await chrome.cookies.set(d) } catch { /* one bad cookie does not stop the round */ } }
  for (const d of plan.toRemove) { try { await chrome.cookies.remove(d) } catch { /* already gone */ } }
  let etag = st.etag
  if (plan.push) {
    const put = await fetch(`${st.hubUrl}${PATH}`, { method: 'PUT', cache: 'no-store', headers: { ...headers, ...(reset ? { 'If-Match': '*' } : rev ? { 'If-Match': `"${rev}"` } : { 'If-None-Match': '*' }) }, body: plan.push })
    if (put.status === 412) { await set({ dirty: true }); chrome.alarms.create('push', { delayInMinutes: 0.5 }); return status('conflict', 'Another machine wrote first; retrying.') }
    if (!put.ok) return status('hub-error', `Hub answered ${put.status} to the push.`)
    etag = put.headers.get('etag')
  } else if (res.status === 200) etag = res.headers.get('etag')
  await set({ state: plan.state, siteRecords: plan.siteRecords, etag, dirty: false, seen: {}, removed: [], lastSync: now })

  return status('ok', plan.push ? 'Pushed a change.' : 'Up to date.')
}
const runSync = (reset = false) => serial(() => syncRound(reset).catch(e => status('error', String(e?.message ?? e))))

// Debounce: one push alarm at most every 30 s (the alarm minimum), however many cookies change.
const schedulePush = () => chrome.alarms.get('push', a => { if (!a) chrome.alarms.create('push', { delayInMinutes: 0.5 }) })
const ensurePull = () => chrome.alarms.get('pull', a => { if (!a) chrome.alarms.create('pull', { periodInMinutes: 5 }) })

chrome.cookies.onChanged.addListener(info => serial(async () => {
  const st = await get(['state', 'siteRecords', 'seen', 'removed'])
  const kind = changeKind(info)
  if (!kind || isEcho(st.state?.entries, info)) return
  const sites = activeSites(st.siteRecords ?? {})
  const d = String(info.cookie.domain).replace(/^\./, '').toLowerCase()
  if (!sites.some(s => d === s || d.endsWith(`.${s}`))) return
  const k = cookieKey(info.cookie)
  await set({ dirty: true, seen: { ...(st.seen ?? {}), [k]: Date.now() }, ...(kind === 'tombstone' ? { removed: [...(st.removed ?? []), k] } : {}) })
  schedulePush()
}))
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'push' || a.name === 'pull') runSync() })
chrome.runtime.onInstalled.addListener(ensurePull)
chrome.runtime.onStartup.addListener(ensurePull)
ensurePull()

const handlers = {
  async 'get-state'() {
    const st = await get(['hubUrl', 'token', 'testMode', 'siteRecords', 'status', 'lastSync'])
    const origins = (await chrome.permissions.getAll()).origins ?? []

    return { hubUrl: st.hubUrl ?? '', paired: Boolean(st.token), hasKey: Boolean(await loadKeys()), testMode: Boolean(st.testMode), status: st.status ?? null, lastSync: st.lastSync ?? null, sessionDays: SESSION_DAYS,
      sites: activeSites(st.siteRecords ?? {}).map(site => ({ site, granted: origins.includes(`*://${site}/*`) })) }
  },
  async 'set-test-mode'(m) { await set({ testMode: Boolean(m.on) }); return { ok: true } },
  async 'save-hub'(m) {
    const hubUrl = normalizeHubUrl(m.hubUrl, (await get('testMode')).testMode)
    if (!hubUrl) return { error: 'That is not a usable address. Use the hub\'s HTTPS address, for example hub.example.ts.net.' }
    await set({ hubUrl })

    return { hubUrl }
  },
  async pair(m) {
    const { hubUrl } = await get('hubUrl')
    if (!hubUrl) return { error: 'Save the hub address first.' }
    let r
    try { r = await fetch(`${hubUrl}${PATH}/pair`, { method: 'POST', cache: 'no-store', body: JSON.stringify({ code: String(m.code ?? '').trim().replace(/^.*code=/, '') }) }) } catch { return { error: 'The hub did not answer.' } }
    if (!r.ok) return { error: 'The pairing code is wrong or expired. Make a new one on the hub machine.' }
    await set({ token: (await r.json()).token, device: crypto.randomUUID() })

    return { ok: true }
  },
  // A new key is shown once; a pasted one is only checked and stored.
  async 'set-key'(m) {
    const given = String(m.key ?? '').trim()
    const key = given || generateKeyString()
    const raw = parseKeyString(key)
    if (!raw) return { error: 'That is not a key from this extension.' }
    await saveKeys(await deriveKeys(raw))

    return given ? { ok: true } : { ok: true, key }
  },
  async 'add-site'(m) {
    const site = normalizeSite(m.site)
    if (!site) return { error: 'That is not a site name. Use something like github.com.' }
    const st = await get('siteRecords')
    await set({ siteRecords: { ...(st.siteRecords ?? {}), [site]: { site, at: Date.now() } }, dirty: true })
    runSync()

    return { site }
  },
  async 'remove-site'(m) {
    const site = normalizeSite(m.site)
    const st = await get('siteRecords')
    await set({ siteRecords: { ...(st.siteRecords ?? {}), [site]: { site, at: Date.now(), removed: true } }, dirty: true })
    runSync()

    return { ok: true }
  },
  async 'sync-now'() { await set({ dirty: true }); await runSync(); return (await get('status')).status },
  async reset() { await set({ dirty: true }); await runSync(true); return (await get('status')).status },
}
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  const h = handlers[m?.type]
  if (!h) return false
  h(m).then(reply, e => reply({ error: String(e?.message ?? e) }))

  return true
})
