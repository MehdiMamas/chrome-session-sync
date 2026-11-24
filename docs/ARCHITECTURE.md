# Architecture

Chrome Session Sync has two parts: a Chrome (MV3) extension and a small Node server, the hub. Both use only built-in APIs and have no dependencies. If a package manager is ever needed, use pnpm.

## Layout

- `extension/`: the unpacked extension.
  - `manifest.json`: the `key` field pins the extension ID and must never change. `test/extension-id.test.mjs` derives the ID from it and compares it with the Origin the hub accepts.
  - `core.mjs`: pure logic with no `chrome.*` calls, so `node:test` can run it. Blob format, key derivation, cookie identity and hashing, merging, and `planSync`.
  - `background.js`: the service worker. Cookie listeners, alarms, hub requests, key storage in IndexedDB.
  - `options.html`, `options.js`: the setup page (hub address, pairing, key, sites, status).
  - `icons/`: toolbar and extensions-page icons, rendered from `icons/icon.svg` at the top level.
- `server/sync-server.mjs`: `createSessionSyncHandler({ dir, log, now, readJson, writeJson, tokenOk, readRaw, origin })` is the whole route. `issuePairCode({ dir, now, writeJson })` writes `<dir>/pair.json`. The host passes in file access and the body reader, which keeps the handler testable.
- `server/standalone.mjs`: a host for the handler. `node server/standalone.mjs --pair [--dir D]` prints a one-time pairing code and exits. `node server/standalone.mjs [--dir D] [--host H] [--port P]` serves, by default on 127.0.0.1:8787 with state in `./data`. `--port 0` picks a free port and prints `listening <url>`.
- `test/`: unit tests. `scripts/e2e.mjs`: end-to-end test.

## Hub state

All state is in the `--dir` directory:

- `session-sync.json`: `{ rev, blob }`, where `blob` is the base64 of the encrypted blob and `rev` a counter. This is the ETag.
- `devices.json`: one record per paired device, holding the SHA-256 of its bearer token.
- `pair.json`: the current one-time pairing code and its expiry (10 minutes). Removed when used.

Files are written with mode 0600 in a directory with mode 0700. The blob is written to a temp file and renamed.

## Routes

- `POST /api/hub/session-sync/pair`: body `{ code }`, Origin must be the pinned extension. Returns `{ token }`.
- `GET /api/hub/session-sync`: returns the blob with an `ETag`; `304` for a matching `If-None-Match`; `404` when empty.
- `PUT /api/hub/session-sync`: replaces the blob. `If-Match` must equal the current ETag, or the request must be a first write (`If-None-Match: *`). A mismatch is `412`. Bodies over 2 MB are `413`.
- `DELETE /api/hub/session-sync`: clears the blob.

All but pairing need `Authorization: Bearer <64 hex chars>`. There are no CORS headers. Logs carry sizes and status codes only.

## Blob format

`[1 byte format][4 byte key check][2 byte AAD length][AAD JSON {v, from, at}][12 byte IV][AES-GCM ciphertext]`

The plaintext is JSON `{ counter, entries, sites }`. The 32-byte secret goes through HKDF-SHA-256 to two non-extractable keys: an AES-GCM key and an HMAC key. The HMAC key makes the 4-byte key check, so a wrong key is caught before anything is pushed. The AAD is authenticated but not encrypted.

## How merging works

`planSync` in `core.mjs` runs one round and returns what to write to the browser, what to remove, and the blob to push, if any.

- A cookie is identified by name, domain, path and partition key. Its hash covers its value and attributes but not its expiry.
- Each entry has a `seenAt` time. The newest `seenAt` wins; a tie goes to the larger hash; equal content keeps the hub's copy, so a cookie both machines already have does not rewrite the blob.
- Only an explicit removal in the browser becomes a tombstone. Expired, evicted and overwritten cookies do not. Tombstones are dropped after 30 days.
- Sites travel in the same blob as `{ site, at, removed? }` records, last write wins. Each machine still has to grant the browser permission for a site before it touches that site's cookies.
- Session cookies (no expiry) are written on the receiving machine with an expiry of 7 days, renewed at every sync.
- A push happens only when the blob content changed, not on every pull. Changes are debounced with a 30 second alarm, and a pull runs every 5 minutes.

## Gotchas

- First contact: a cookie this machine has never tracked, for example because the site was just added, defers to the hub's copy. A joining machine never overwrites a sign-in with its stale one.
- A client refuses a blob with a lower counter than the highest it has seen, and never pushes over a blob it cannot decrypt. Only the Reset button skips both checks.
- A cookie written by the extension fires `onChanged` too. `isEcho` ignores a change whose hash matches what was just applied.
- The service worker is killed after 30 seconds idle, so timers use `chrome.alarms`, never `setTimeout`.
- Keys must stay in IndexedDB as `CryptoKey` objects. `chrome.storage.sync` would upload them to Google.
- The extension allows plain http only to loopback, and only in its test mode. Real use is HTTPS.
- Branded Chrome ignores `--load-extension` since version 137. Automation uses Chrome for Testing with its own `--user-data-dir`. The e2e script also adds host permissions for loopback to a temp copy of the manifest, because a headless run cannot click the permission prompt.

## Tests

- Unit: `node --test test/*.test.mjs`.
- End to end: `CHROME=<Chrome for Testing binary> node scripts/e2e.mjs`. It runs a hub and two headless profiles, sets a normal and a Secure, HttpOnly cookie in the first, and checks both arrive intact in the second and that the cookie value is not in `session-sync.json`.
- CI (`.github/workflows/ci.yml`) runs both on Node 22 and installs Chrome for Testing with `npx @puppeteer/browsers install chrome@stable`.
