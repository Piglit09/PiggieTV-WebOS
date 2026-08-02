# PiggieTV webOS Native Architecture

## Scope and target baseline

PiggieTV is a native TV-oriented Jellyfin client. It communicates with Jellyfin through authenticated HTTP endpoints and renders its own UI and playback controls. It never loads `web/index.html`, embeds the official Jellyfin Web client, or relies on that client's component tree or CSS.

Phase 1 is stabilized against this baseline:

- TV: LG 70UN7070PUA
- webOS SDK: 5.6.2
- input: Magic Remote and directional pad (DPAD)
- Jellyfin URL: `https://piggietv.com`
- Jellyfin version: 10.11.11 as reported for the baseline; confirm the live version during hardware acceptance

## Module boundaries

- `api/` centralizes Jellyfin and PTV plugin HTTP traffic.
- `state/` owns shared app state, services, and navigation route history.
- `auth/` owns username/password and Quick Connect session establishment.
- `focus/` owns TV focus registration, movement, and restoration.
- `playback/` owns playback mode selection, stream URL construction, and player lifecycle.
- `screens/` contains route screens and user-facing views.
- `storage/` owns persistence, validation, and migrations.
- `navigation/` handles route building and navigation intents.
- `diagnostics/` and `core/diagnostics.ts` provide bounded logs and redacted snapshots.

## Single-owner session model

Phase 1 assigns one authoritative owner to each session transition. A screen may collect input and render state, but it must not independently create clients, persist credentials, commit authenticated state, or navigate after authentication.

| Transition | Authoritative owner | View responsibility |
| --- | --- | --- |
| Password sign-in | `auth/sessionController.ts` | `AuthScreen` submits input and subscribes to progress |
| Quick Connect sign-in | `auth/sessionController.ts` | `QuickConnectScreen` displays the code and progress |
| Stored-session restore | startup effect in `app/App.tsx` | startup route prevents a signed-out or Guest flash |
| Sign out / change server | `leaveSession` in `SettingsScreen` | Settings presents the explicit action and any persistence error |
| Authenticated API state | the shared `JellyfinClientContext` service | screens request the configured client from app services |
| Persisted credential state | `StorageRepository` | screens do not write auth records directly |

### Before Phase 1

Session establishment was split between `AuthScreen`, `QuickConnectScreen`, and startup recovery. Each path could construct its own session, persist it, update app state, and navigate. Completion also depended on a view-local mounted flag. This created multiple owners, duplicate Quick Connect work, inconsistent persistence for custom servers, and stale responses that could overwrite newer attempts.

### After Phase 1

Both interactive sign-in methods use one `SessionController`. It owns the attempt identity, cancellation, timeout, response validation, ordered commit, terminal result, and navigation request. The controller uses stable attempt IDs, deduplicates identical in-flight submissions, supersedes older attempts, and rejects stale completion. Password requests have a 15-second default timeout; Quick Connect has one sequential polling loop and a 120-second overall timeout.

The Quick Connect owner follows Jellyfin's server contract exactly: initiate once, poll `GET QuickConnect/Connect` sequentially until `Authenticated` is true, then exchange the secret through `POST Users/AuthenticateWithQuickConnect` once. Every step shares the attempt's abort signal; leaving the route cancels the loop.

The successful commit order is deliberately observable:

1. `VALIDATING_INPUT`
2. `REQUEST_STARTED`
3. `RESPONSE_RECEIVED`
4. `AUTH_JSON_PARSED`
5. `AUTH_RESULT_VALIDATED`
6. `SESSION_PERSIST_STARTED`
7. `SESSION_PERSISTED`
8. `API_CONTEXT_UPDATED`
9. `AUTH_STATE_COMMITTED`
10. `NAVIGATION_REQUESTED`
11. `COMPLETE`

Any failure stops downstream work and ends in `FAILED`; explicit cancellation ends in `CANCELLED`. Persistence therefore completes before the shared client, app state, or route is changed. Navigation to Home is requested once.

Unmounting a subscribing view only unsubscribes that view. It does not invalidate a valid controller-owned commit. Leaving or cancelling an auth flow explicitly calls `cancelCurrentAttempt`, which aborts its network work.

## StrictMode authentication regression

The original development-only stall occurred after `AUTH_JSON_PARSED`. React StrictMode performs an effect setup, cleanup, and setup cycle. The old auth view set `mountedRef.current = false` during the first cleanup and never restored it during the second setup. A valid response was parsed, but the post-request mounted check then skipped persistence, state commit, navigation, and busy-state cleanup.

The fix removes view-mounted state from transaction ownership. The controller remains authoritative across subscriber lifecycle changes, while explicit cancellation is still respected. Startup work has its own run identity and abort signal, so the first StrictMode effect cannot complete after its cleanup. An integration regression test renders the application inside `React.StrictMode` and verifies one valid commit and one Home navigation.

## Canonical persisted session

The storage envelope is schema version 2 and contains one canonical `session` value. The persisted auth record is schema version 1 with exactly these fields:

```ts
interface PersistedSession {
  schemaVersion: 1;
  serverUrl: string;
  accessToken: string;
  userId: string;
  userName: string;
  deviceId: string;
  deviceName: string;
  applicationVersion: string;
  savedAt: number;
}
```

The server URL is normalized before storage. The stable device ID is also retained under its dedicated device-ID storage key so new requests retain the same Jellyfin device identity. `StorageRepository.saveSession` writes a complete replacement record, then reads it back and verifies the important identity fields. The in-memory storage snapshot is not advanced if the write fails.

Older version-1 stores containing `users[]` are migrated by selecting the latest usable user session. Malformed, unsupported, or incomplete sessions are discarded rather than partially restored. Access tokens and passwords are sensitive values and must never appear in diagnostics.

The authenticated response may include a server ID, and the controller validates it against the selected server when available. Server identity belongs to the server-session metadata; it is not duplicated in the canonical persisted credential record above.

## Startup restore

`app/App.tsx` is the sole restore coordinator:

1. Stay on the startup route so unauthenticated UI and the label `Guest` are not rendered briefly.
2. Choose the canonical session URL when present, otherwise the last server URL, otherwise `https://piggietv.com`.
3. Normalize the URL, clear shared authorization, configure the shared client, and validate the public server endpoint with an abortable 10-second request.
4. Persist the validated server metadata.
5. If no matching session exists, route to sign-in.
6. Configure the shared client with the stored token and validate `Users/{userId}` with an abortable 8-second request.
7. Require the returned user ID to match the stored user; commit the restored user session and reset the route stack to Home.

A `401` or `403` proves the stored token is rejected, so startup clears the shared authorization, app user state, and canonical persisted session before routing to sign-in with an expired-session message. A timeout, network failure, or other transient validation failure clears only in-memory/shared authorization and routes to sign-in without destroying the stored session. Capability discovery is cancellable and begins after authentication; it does not block the session commit or Home navigation.

## Sign out and change server

Settings owns the leave-session transaction. It performs these steps in order:

1. Cancel the active interactive session attempt.
2. Stop the global playback owner and release playback work.
3. Clear the canonical persisted session.
4. Reset the shared Jellyfin client and its access token.
5. Clear authenticated app state, playback intent, and capabilities.
6. Reset route history to sign-in for **Sign out**, or server selection for **Change server**.

If persistence cannot be cleared, the action shows an error and stops before clearing the in-memory session. This avoids presenting a successful sign-out that would restore the old credential at the next launch.

## State and navigation ownership

`state/appContext.tsx` owns:

- current route and route history
- active user and server session
- library and capability metadata
- UI settings
- playback intent

Screen-local details that do not need persistence stay inside each screen. `buildRoute` and `ScreenRouter` in `navigation/` and `app/App.tsx` control routing. Screens dispatch route intents; authenticated commit, restore, and sign-out use `reset_route` so stale login or authenticated routes cannot be reached with Back.

## Shared API ownership

`JellyfinClientContext` is created once with the stable device ID and request tracker. It owns the one active `JellyfinApiClient`, normalized server URL, and access token. `configureServer`, `configureSession`, `clearAuthorization`, and `reset` update this shared context instead of allowing screens or workflows to create competing clients.

All network traffic should flow through:

- `api/jellyfin/context.ts` and `api/jellyfin/client.ts`
- `api/jellyfin/mappers.ts`
- `api/ptv/client.ts`

Screens obtain API access from app services and do not perform direct `fetch` calls. This keeps device identity, authorization, request diagnostics, cancellation, and server switching consistent.

## Playback ownership

Playback remains isolated in `playback/` and `screens/playback/PlaybackScreen.tsx`:

- request playback information from Jellyfin
- choose direct play, direct stream, or transcode
- resolve and assign one source for the current attempt
- wait for readiness before calling play
- report progress and stop state
- ignore or abort superseded work
- detach media listeners and release the global playback owner on stop

The playback engine guards against duplicate load/play work, stale asynchronous responses, non-finite duration or seek values, and expected abort errors. The global `PlaybackLifecycle` gives sign-out, route Back, and the playback screen one coordinated stop path.

## Focus and remote ownership

`focus/FocusManager` stores registered focus nodes, rejects hidden or disabled candidates, resolves directional movement, and restores focus by route. `FocusableButton` registers focusable controls and updates the global focus ID. One global remote-input controller normalizes arrows, Enter, and webOS Back key code 461, prevents page scrolling, ignores repeated Enter activation, and invokes a single action target.

Back pops route history once. Leaving playback also stops playback and clears its intent. At root Home or server selection, Back requests `window.close()`; from sign-in it returns to server selection.

## Cache and diagnostics ownership

- session and recent-server storage: `storage/sessionStore.ts` and `storage/repository.ts`
- request diagnostics: `core/requestTracker.ts`
- bounded application logs and auth/focus snapshots: `core/diagnostics.ts` and `diagnostics/`

Auth diagnostics use attempt IDs, stages, classifications, and a redacted user suffix. Passwords, access tokens, Quick Connect secrets, and token-bearing URLs must not be logged.

## Cleanup responsibilities

- Abort superseded, timed-out, explicitly cancelled, and StrictMode-stale auth/startup requests.
- Keep only one sequential Quick Connect poll owner and abort it when the flow is left.
- Stop playback, clear timers, and detach media listeners on Back, sign-out, and unmount.
- Clear recurring screen intervals and abort their requests on cleanup.
- Unsubscribe session observers without cancelling an otherwise valid transaction.
- Remove stale focus registrations and restore only visible, enabled targets.
- Remove global remote and error listeners during their matching effect cleanup.
