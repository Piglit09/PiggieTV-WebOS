# Security notes

## Storage

- Credentials are never persisted.
- Session token is persisted locally for restoration.
- Server addresses and session data are persisted only through `storage/`.

## Logging

- Raw tokens and secrets are redacted before insertion in diagnostic logs.

## Network

- `Authorization` header is set per request for authenticated calls.
- `requestJson` supports cancellation and short timeout.
