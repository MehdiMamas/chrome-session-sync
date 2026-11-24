// The session sync route: one encrypted blob in <dir>/session-sync.json, version = a counter; the server never sees a cookie.
// Auth is a per-device bearer token made by pairing (stored hashed in <dir>/devices.json as `ext`). PUT, DELETE and pairing need Origin = the
// pinned extension; a GET with an Origin must match too (Chrome sends none on a service-worker GET). No CORS headers; logs carry sizes and
// status codes only. Zero dependencies. A host such as server/standalone.mjs injects file access and the body reader.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The extension id is pinned by the `key` in extension/manifest.json (test/extension-id.test.mjs).
export const SESSION_SYNC_ORIGIN = 'chrome-extension://mblkfibdlfkahdlfobdodioffhihambj'
export const PAIR_MS = 10 * 60 * 1000

const sha = s => createHash('sha256').update(s).digest('hex')

// Writes <dir>/pair.json with a one-time code (valid PAIR_MS) and returns the code.
export function issuePairCode({ dir, now = Date.now(), writeJson }) {
  const code = randomBytes(16).toString('hex')
  writeJson(`${dir}/pair.json`, { code, exp: now + PAIR_MS })

  return code
}

// Returns async (req, res, path) for the routes ending in /pair or anything else under the session-sync path.
// now is a function; readRaw(req) resolves a Buffer, or null when the body is over the cap.
export function createSessionSyncHandler({ dir, log, now, readJson, writeJson, tokenOk, readRaw, origin = SESSION_SYNC_ORIGIN }) {
  const syncFile = join(dir, 'session-sync.json')
  const syncToken = req => {
    const t = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1]

    return Boolean(t) && readJson(`${dir}/devices.json`, []).some(d => typeof d.ext === 'string' && tokenOk(sha(t), d.ext))
  }
  const syncDone = (res, code, method, bytes, headers = {}, body = '') => {
    log(`session-sync ${method} ${code} ${bytes} bytes`)
    res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })

    return res.end(body)
  }
  const syncWrite = value => {
    mkdirSync(dirname(syncFile), { recursive: true, mode: 0o700 })
    writeFileSync(`${syncFile}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(`${syncFile}.tmp`, syncFile)
  }

  return async (req, res, path) => {
    const m = req.method
    const got = req.headers.origin
    if (path.endsWith('/pair')) {
      if (m !== 'POST') return syncDone(res, 405, m, 0)
      if (got !== origin) return syncDone(res, 403, m, 0)
      const raw = await readRaw(req)
      let code = ''
      try { code = String(JSON.parse(raw?.toString('utf8') ?? '{}').code ?? '') } catch { /* bad body */ }
      const pairing = readJson(`${dir}/pair.json`, null)
      if (!pairing || pairing.exp < now() || !tokenOk(code, pairing.code)) return syncDone(res, 403, m, raw?.length ?? 0)
      rmSync(`${dir}/pair.json`, { force: true })
      const token = randomBytes(32).toString('hex')
      writeJson(`${dir}/devices.json`, [...readJson(`${dir}/devices.json`, []), { ext: sha(token), at: now() }])

      return syncDone(res, 200, m, 64, { 'Content-Type': 'application/json' }, JSON.stringify({ token }))
    }
    if (!syncToken(req)) return syncDone(res, 401, m, 0)
    if (m === 'GET' ? got !== undefined && got !== origin : (m === 'PUT' || m === 'DELETE') && got !== origin) return syncDone(res, 403, m, 0)
    if (m !== 'GET' && m !== 'PUT' && m !== 'DELETE') return syncDone(res, 405, m, 0)
    if (m === 'GET') {
      const cur = readJson(syncFile, null)
      if (!cur?.blob) return syncDone(res, 404, m, 0)
      const etag = `"${cur.rev}"`
      if (req.headers['if-none-match'] === etag) return syncDone(res, 304, m, 0, { ETag: etag })
      const body = Buffer.from(cur.blob, 'base64')

      return syncDone(res, 200, m, body.length, { ETag: etag, 'Content-Type': 'application/octet-stream' }, body)
    }
    // From here no await between the compare and the write, so two PUTs cannot both win.
    if (m === 'DELETE') {
      const cur = readJson(syncFile, { rev: 0 })
      syncWrite({ rev: cur.rev + 1, blob: null })

      return syncDone(res, 204, m, 0)
    }
    const body = await readRaw(req)
    if (!body) return syncDone(res, 413, m, 0)
    if (!body.length) return syncDone(res, 400, m, 0)
    const cur = readJson(syncFile, { rev: 0, blob: null })
    const ifMatch = req.headers['if-match']
    const ok = ifMatch === '*' || (ifMatch === undefined || req.headers['if-none-match'] === '*' ? !cur.blob : ifMatch === `"${cur.rev}"`)
    if (!ok) return syncDone(res, 412, m, body.length)
    syncWrite({ rev: cur.rev + 1, blob: body.toString('base64') })

    return syncDone(res, 200, m, body.length, { ETag: `"${cur.rev + 1}"` })
  }
}
