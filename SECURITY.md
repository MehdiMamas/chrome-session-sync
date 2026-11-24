# Security policy

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases yet.

## Report a vulnerability

Use GitHub's private reporting: open the [Security tab](https://github.com/MehdiMamas/chrome-session-sync/security) of the repository and choose "Report a vulnerability". Please do not open a public issue or discussion for a security problem.

Include what you found, the steps to reproduce it, and the impact you expect. Do not include real cookies, keys or pairing codes.

## Scope

In scope:

- The extension in `extension/`: key handling, encryption, how cookies are read and written.
- The hub in `server/`: authentication, pairing, the pinned Origin, how the blob is stored.
- The way the two talk to each other.

Out of scope:

- A hub exposed over plain http on the open internet. Put it behind HTTPS.
- A machine that is already compromised. Anyone who controls a browser profile holds its sign-ins.
- Sites that keep their sign-in outside cookies, or that bind sessions to a device. See "Limits" in the [README](README.md#limits).

## Threat model in short

- The hub is not trusted with cookies. It stores one encrypted blob and sees only its size, its revision and the times it is read or written.
- Cookies are encrypted in the browser with AES-256-GCM. The keys come from HKDF over one random 32-byte key that you create and carry between your machines yourself. The keys are non-extractable `CryptoKey` objects in IndexedDB and never go to `chrome.storage.sync` or to the hub.
- Each device gets its own bearer token by pairing with a one-time code that is valid for 10 minutes. The hub stores only a hash of the token.
- The hub accepts writes and pairing only from the extension's pinned Origin, and a write must carry the current ETag, so two devices cannot silently overwrite each other.
- A client refuses a blob whose counter is lower than one it has already seen, and never pushes over a blob it cannot decrypt.
- Whoever holds the key and a device token can read and replace the blob. Treat the key like a password.
