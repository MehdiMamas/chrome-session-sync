# Contributing to Chrome Session Sync

Thanks for helping. Questions and ideas are welcome in [Discussions](https://github.com/MehdiMamas/chrome-session-sync/discussions); bugs and concrete requests go in [Issues](https://github.com/MehdiMamas/chrome-session-sync/issues). Security problems go through the private route in [SECURITY.md](SECURITY.md), not Issues.

## Setup

You need Node.js 22 or newer. There are no dependencies, so there is nothing to install.

```bash
git clone https://github.com/MehdiMamas/chrome-session-sync.git
cd chrome-session-sync
```

Load `extension/` unpacked from `chrome://extensions` with Developer mode on. How the code is laid out is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

To try it end to end, start a hub with `node server/standalone.mjs --port 0` and print a pairing code with `node server/standalone.mjs --pair`. Both use `./data` unless you pass `--dir`.

## Tests

- Unit tests: `node --test test/*.test.mjs`.
- End to end (also run in CI): `CHROME=<path to Chrome for Testing> node scripts/e2e.mjs`. It starts a hub on loopback and two headless Chrome profiles, sets a cookie in one and checks it reaches the other. Use Chrome for Testing, not branded Chrome: branded Chrome ignores `--load-extension`. Install it with `npx @puppeteer/browsers install chrome@stable`.

Run both before opening a pull request. A behavior change comes with a test.

## Rules for changes

- Keep the server free of dependencies: Node built-ins only.
- The `key` in `extension/manifest.json` pins the extension ID. Do not change it; `test/extension-id.test.mjs` checks it.
- Encryption keys stay in the browser as non-extractable `CryptoKey` objects. Never put them in `chrome.storage.sync` or send them to the hub.
- Logs carry sizes and status codes only. Never log tokens, keys or blobs.

## Pull requests

- Branch from `main`, keep one change per pull request, and say what it fixes and how you checked it.
- Link the issue it closes (`Closes #123`).
- CI must be green.
- Update `README.md` or `docs/ARCHITECTURE.md` when you change how something works.
- By contributing you agree your work is released under the project's [GPL-3.0 license](LICENSE).
