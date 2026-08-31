# Security notes

## Storage

- Jellyfin access tokens are not stored in ordinary `localStorage`. Harmless
  session metadata (server URL and ID, user ID/display name, device ID, and a
  random credential reference) remains there for restoration.
- The access token is AES-256-GCM encrypted in IndexedDB. Its non-extractable
  WebCrypto key is generated on-device and persisted separately as a
  structured-cloned `CryptoKey`. Authenticated additional data binds each
  ciphertext to its credential, server, user, and device metadata.
- On the supported LG webOS 5.x target this is classified as
  `APP_ENCRYPTED_WITH_PLATFORM_KEY`, not Android-equivalent hardware-backed
  storage. The TV exposes WebCrypto and IndexedDB but not the newer webOS
  KeyManager service.
- Legacy plaintext sessions are migrated in this order: protected write,
  protected readback verification, then tokenless metadata activation. A
  failed protected write or readback leaves the legacy session recoverable and
  surfaces `SECURE_STORAGE_FAILURE`.
- A non-secret synchronous logout marker makes local logout fail closed. If the
  app exits during cleanup, startup completes credential/key deletion before
  considering any stored session.
- Browser APIs cannot verify whether obsolete bytes remain in the TV's raw
  LevelDB/SQLite backing files. Logical Web Storage contains no token after a
  successful migration, while IndexedDB contains ciphertext and a
  non-extractable browser-managed key.

## Logging

- Raw tokens, passwords, Authorization headers, Quick Connect secrets, and
  protected credential blobs are not intentionally logged or exported.
- Diagnostic text is redacted before storage, UI display, console fallback, or
  export. Auth diagnostics expose semantic state and status only.

## Network

- Authenticated JSON, playback reporting, and playback URL resolution use the
  shared authenticated Jellyfin client and one credential epoch.
- Current-session HTTP 401 responses converge on the auth coordinator, which
  invalidates once and durably clears local auth. Old-epoch 401 responses are
  ignored; connectivity failures, cancellation, 403, 404, and 5xx responses do
  not log the user out.
- Logout attempts `POST /Sessions/Logout` with the retiring credential, but
  local cleanup does not wait for or depend on server revocation.
