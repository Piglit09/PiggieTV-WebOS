# Known limitations (Phase 1)

- Focus and playback controls are functional but do not yet cover all edge cases.
- Home cards currently use resolved item IDs for placeholders in some paths.
- Not all browse filters (genre/year/genre/quality) are implemented yet.
- Full TV-safe motion policies still need polishing.
- Native audio/subtitle stream selection UI is intentionally basic in this phase.
- Full remote diagnostics export fallback (no-clipboard environments) not yet implemented.
- The supported LG webOS 5.x runtime has no available KeyManager/TEE API for
  this packaged web app. Session credentials therefore use AES-GCM with a
  non-extractable WebCrypto key persisted in the app's IndexedDB sandbox. This
  raises the extraction bar but is not hardware-backed storage and cannot
  protect against malicious code executing in the app's own origin.
- The public browser APIs can prove that ordinary `localStorage` no longer
  exposes a migrated token, but cannot inspect obsolete bytes in the TV's raw
  Web Storage/IndexedDB backing files. Raw historical-remanence verification is
  unavailable without device-filesystem access.
- Raw Chromium network/resource-cache remanence for Quick Connect query URLs
  and same-origin token-bearing image/video URLs is also `UNKNOWN` without
  device-filesystem access.
- Superseded encrypted credential records are deleted best-effort. A failed
  background deletion can retain an unreferenced ciphertext until full logout
  clears the credential store and key; adding a durable orphan-cleanup queue is
  a P1 hardening item.
