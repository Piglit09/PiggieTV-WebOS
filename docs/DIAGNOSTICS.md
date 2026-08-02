# Diagnostics

## Phase-1 data flow

`DiagnosticsService` in `src/core/diagnostics.ts` is the bounded, redacted diagnostics owner.

- The request tracker supplies HTTP timing, classification, retry, cancellation, timeout, and duplicate-request evidence.
- The session controller records its latest authentication or restore attempt snapshot.
- `PlaybackEngine` records its latest player snapshot on state and media-event changes.
- The focus manager records bounded route/input transitions.
- Window errors, unhandled non-cancellation rejections, UI errors, and playback errors are retained as bounded logs.

`DiagnosticsScreen` rebuilds the exported snapshot every second while open. The most recent playback snapshot remains available after leaving playback, which makes Back cleanup inspectable from Details or Home.

## Exported top-level fields

The exported `PtvDiagnosticsSnapshot` contains these fields.

Build and platform:

- `appVersion`
- `buildTimestamp`
- `commitHash`
- `mode`
- `webosVersion`
- `tvModel`
- `viewport`
- `dpr`
- `memoryEstimate`

Server and session context:

- `serverVersion`
- `serverUrl`
- `userId`
- `pluginVersion`
- `pluginApiVersion`
- `capabilities`

Route and focus:

- `currentRoute`
- `currentFocusId`
- `previousFocusId`
- `recentFocusTransitions`

Request evidence:

- `activeRequests`
- `peakConcurrentRequests`
- `activeFailures`
- `averageRequestDuration`
- `failedRequestCount`
- `cancelledRequestCount`
- `timeoutRequestCount`
- `duplicateRequestCount`
- `slowestRequestMs`
- `requestDurations`
- `recentFailures`
- `recentCompletions`

Each `recentCompletions` entry contains `id`, `url`, `method`, `status`, `durationMs`, `error`, `timedOut`, `cancelled`, `category`, `route`, `contentType`, and `parseResult`.

Lifecycle and errors:

- `playbackState`
- `playbackDecision`
- `mediaCodecs`
- `currentPositionTicks`
- `lastLifecycleEvent`
- `lastPlaybackError`
- `lastUiError`
- `authentication`
- `playbackDetails`

The authoritative Phase-1 player state is under `playbackDetails`. The older top-level playback summary fields remain for compatibility and may contain their default values when the caller does not provide them.

## Authentication snapshot

The `authentication` object is the latest session-controller snapshot and contains:

- `attemptId`
- `workflow`
- `stage`
- `status`
- `resultClassification`
- `serverOrigin`
- `startedAt`
- `endedAt`
- `durationMs`
- `httpStatus`
- `contentType`
- `userIdSuffix`
- `persistenceSucceeded`
- `apiContextUpdated`
- `authStateCommitted`
- `navigationRequested`
- `stale`
- `cancelled`
- `errorMessage`

It contains evidence about the workflow, not credentials or response bodies.

## Playback snapshot

The `playbackDetails` object is copied from `PlaybackEngine.getDiagnosticsSnapshot()` and contains exactly:

- `attemptId`: unique logical playback attempt.
- `state`: `idle`, `resolving`, `loading`, `ready`, `playing`, `paused`, `buffering`, `ended`, `error`, or `stopping`.
- `itemIdSuffix`: last six characters only.
- `mediaSourceIdSuffix`: last six characters only.
- `container`
- `videoCodec`
- `audioCodec`
- `decision`: `direct-play`, `direct-stream`, `transcode`, or null before selection.
- `finalUrlOrigin`: URL origin only.
- `finalUrlPathCategory`: safe category such as `direct-play`, `direct-stream`, `transcode`, `stream`, `video`, or `media`.
- `readyState`
- `networkState`
- `currentTime`: finite seconds, falling back to zero.
- `duration`: finite positive seconds or null.
- `paused`
- `ended`
- `canSeek`
- `lastMediaEvent`
- `lastPlayerError`
- `sourceAssignments`
- `loadCalls`
- `playCalls`
- `playingReports`
- `progressReports`
- `stoppedReports`

The normal startup invariant is `sourceAssignments: 1`, `loadCalls: 1`, and `playCalls: 1` before any user resume or recovery. Back adds one deliberate reset load, so `loadCalls: 2` is expected after an otherwise normal start and close.

## Focus transition snapshot

Each recent focus transition records:

- `route`
- `previousFocusId`
- `nextFocusId`
- `key`
- `reason`
- `fallbackUsed`

At most 30 transitions are retained internally and the latest 12 are exported.

## Redaction and retention

Diagnostics must never contain passwords, access tokens, authorization headers, Quick Connect secrets, or sensitive response bodies.

`core/redaction.ts` is the shared last-mile sanitizer for diagnostic logs, UI/render errors, playback errors, request-tracker URLs and errors, and exported JSON. Transport-level URL sanitization remains the first boundary; export-time redaction is a final defense. Regression tests cover query tokens, Bearer credentials, authorization values, passwords, and playback error text.

Current redaction behavior is:

- `serverUrl` is reduced to protocol plus a hostname with a leading subdomain masked when present, and is labeled redacted.
- `userId` is reduced to its first six and last four characters.
- playback item and media-source IDs expose only their last six characters.
- the playback stream URL is never stored; only `finalUrlOrigin` and `finalUrlPathCategory` are retained.
- object/string fields named `token`, `accessToken`, `access_token`, `authorization`, `password`, or `secret` are replaced with `***redacted***`.
- URL parameters named `token`, `access_token`, `api_key`, `apikey`, `secret`, or `password` are replaced with `***redacted***`.
- request-tracker URLs independently sanitize token, access-token, API-key, secret, and code query parameters before storage.
- URL fragments are removed by request tracking.

Request paths can still contain Jellyfin resource identifiers, so treat every export as operational data. Do not add raw request headers, response bodies, full authentication results, or raw media URLs to diagnostic records.

Retention is bounded:

- 200 application log entries;
- 20 recent request completions in an exported snapshot;
- 30 request durations;
- 30 focus transitions internally, with 12 exported.

## Export

The Diagnostics route renders formatted JSON and refreshes it once per second. `Copy diagnostics` uses the Clipboard API when the platform exposes it. If clipboard access is unavailable on the TV, use the webOS inspector to select the rendered JSON; a platform-specific file exporter is not implemented in Phase 1.

Review copied diagnostics before sharing them. The built-in sanitizer is defense in depth, not authorization to log new sensitive fields.

## Playback verification with diagnostics

For a repeatable movie test:

1. Start one movie once.
2. During active playback, use the webOS inspector to confirm one attempt and startup counts of one source assignment, one load, and one play.
3. Confirm state reaches `playing`, `lastMediaEvent` reaches `playing`, duration is finite or null, and `canSeek` agrees with actual seekability.
4. Confirm `finalUrlOrigin` and category are present without query data.
5. Pause/resume and confirm the state and report counters change without a new source assignment.
6. Press Back once and wait for the stopped report to settle.
7. Open Diagnostics from the prior route. Confirm state is `idle`, the final reset raised `loadCalls` to two, and `stoppedReports` is one.
8. Confirm expected cancellation did not populate `lastPlayerError`.
9. Start playback again and verify a different attempt ID.

Automated diagnostics tests prove field safety and controller invariants, but they do not prove decoder compatibility or Magic Remote behavior on the LG television. Preserve the exported snapshot alongside manual hardware results when reporting a playback failure.
