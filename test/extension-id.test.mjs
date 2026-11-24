import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SESSION_SYNC_ORIGIN } from '../server/sync-server.mjs'

// Chrome derives the extension id from the manifest key: first 16 bytes of sha256(DER), each hex digit shifted to a-p.
test('the manifest key gives the pinned extension id', () => {
  const { key } = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  const id = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')
  assert.equal(SESSION_SYNC_ORIGIN, `chrome-extension://${id}`)
})
