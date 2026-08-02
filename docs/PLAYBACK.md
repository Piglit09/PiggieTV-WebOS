# Playback architecture

## Phase-1 ownership

Playback has one authoritative media owner: `PlaybackEngine` in `src/playback/engine.ts`.

Before the Phase-1 stabilization, `PlaybackScreen` resolved playback information, owned a progress timer, tracked a second set of player state, and told a smaller engine when to assign, load, and play the video. An effect restart could leave an older resolution alive, register listeners again, or issue a reset load while a `play()` promise was pending.

After stabilization, ownership is divided as follows:

- `PlaybackScreen` adapts the current route, session, settings, and controls to the engine. It owns presentation only.
- `PlaybackEngine` owns the active attempt, `HTMLVideoElement`, source assignment, readiness, play/pause/seek, media listeners, reporting order, teardown, and playback diagnostics.
- `chooseBestPlaybackSource` owns direct-play, direct-stream, or transcode selection from Jellyfin's response.
- `JellyfinApiClient` owns `PlaybackInfo` and session-report requests.
- `PlaybackLifecycle` exposes the one registered stop owner to global Back and sign-out flows.

There is one persistent `<video>` while the playback route is mounted. Loading and error overlays are rendered after it, so diagnostics or error changes do not replace the media element.

## Start pipeline

One Play intent follows this sequence:

1. `PlaybackScreen` attaches its video element to the engine.
2. `PlaybackEngine.start()` creates a unique attempt ID.
3. Any older attempt is synchronously invalidated and its `AbortController` is aborted.
4. The injected resolver requests `Items/{itemId}/PlaybackInfo` once for the active logical attempt. The request receives the attempt's abort signal.
5. The resolver passes the user's direct-play, direct-stream, and transcode settings plus selected audio/subtitle indexes.
6. `chooseBestPlaybackSource` searches all media sources in mode priority order and returns the selected source ID, mode, container, and codecs.
7. The resolver builds one final stream URL.
8. The engine assigns `video.src` once and calls `load()` once for normal startup.
9. The engine waits for a real readiness condition: `readyState >= HAVE_FUTURE_DATA`, observed through `loadeddata` or `canplay`. Readiness has a bounded timeout.
10. A valid resume position is applied only if duration and seekable ranges permit it.
11. The engine invokes `play()` once for the initial start and handles its promise.
12. Only the still-active attempt may transition to playing or start reporting progress.

Transport-level retries, if any, remain visible in request diagnostics. They do not create a second engine attempt or permit a stale response to mutate the player.

### Player states

The authoritative states are:

- `idle`
- `resolving`
- `loading`
- `ready`
- `playing`
- `paused`
- `buffering`
- `ended`
- `error`
- `stopping`

Media events are registered with stable named handlers. Calling `attach()` again for the same element does not register them twice. Stop/detach removes those exact handlers.

An `AbortError` is ignored only when its attempt was explicitly cancelled, superseded, stopped, or detached. An unexpected `AbortError` on the active attempt remains a real playback failure.

## Source selection and URL resolution

`playback/decision.ts` exports `chooseBestPlaybackSource`. It evaluates the server-supported flags across every returned media source and respects enabled modes.

`playback/deviceProfile.ts` supplies a conservative webOS 5 profile to Jellyfin. It declares MP4/M4V/MOV with H.264 and AAC/MP3 explicitly for direct play and an HLS MPEG-TS H.264/AAC transcode fallback. It contains no wildcard video profile, so an unknown container or codec is not optimistically marked direct-play capable.

The normal preference order is:

1. direct play
2. direct stream
3. transcode

The selection contains:

- mode
- media source ID
- container
- video codec
- audio codec
- bitrate and resolution when supplied
- selection reason

If no enabled mode has a supported source, startup fails before assigning a URL.

`resolvePlaybackStreamUrl` uses:

- the native static video stream URL for direct play;
- Jellyfin's `DirectStreamUrl` for direct stream when supplied;
- Jellyfin's `TranscodingUrl` for transcode when supplied;
- the native stream URL only as a fallback when Jellyfin omitted the mode-specific path.

The stable session device ID is used in media URLs. The access token is added only when the supplied URL does not already contain authentication. Raw stream URLs and query data are never copied into playback diagnostics.

## Playback reporting

The engine injects three Jellyfin reporting callbacks:

- `Sessions/Playing` after the first successful start;
- `Sessions/Playing/Progress` on the controlled interval and on meaningful pause changes;
- `Sessions/Playing/Stopped` once for Back, stop, supersession, detach, or natural end after playback started.

Reports are serialized through one promise chain. A progress report already in flight completes before Stopped, and repeated progress requests are coalesced instead of overlapping. A report failure is logged as a warning and does not turn otherwise healthy media playback into a fatal player error.

Pause/resume can legitimately increase `playCalls`; the one-call invariant applies to normal initial startup. Likewise, a normal active start has one `loadCalls` entry. Full teardown adds one intentional reset load, so a completed start followed by Back normally ends with `sourceAssignments: 1`, `playCalls: 1`, and `loadCalls: 2` when no pause/resume or recovery occurred.

## Time and seek safety

Media time helpers live in `src/utils/format.ts`.

- Unknown, zero, negative, NaN, or infinite duration renders as `--:--`.
- Position formatting never emits NaN or Infinity.
- Seconds-to-Jellyfin-ticks conversion accepts only finite, non-negative values.
- Duration must be finite and greater than zero before progress division.
- Seek is disabled until the video exposes at least one seekable range.
- Seek targets must be finite and are clamped to the nearest valid seekable boundary.
- Resume positions follow the same validation.

## Back, close, and teardown

Phase 1 uses a direct-exit Back model: Back exits playback rather than first dismissing visible controls.

The Close control calls the engine directly; global webOS Back and sign-out use the registered stop owner. Route and session callers clear the playback intent synchronously, while the engine independently completes ordered Jellyfin reporting. The stop owner never performs a delayed global state mutation, so an old report cannot clear a newer playback intent. Stop performs this order:

1. invalidate and abort the active attempt;
2. clear the readiness waiter and progress timer;
3. enter `stopping`;
4. capture and queue the final Stopped report after earlier reports;
5. pause the video;
6. remove `src`;
7. call `load()` once as the final media reset;
8. detach all media listeners;
9. enter `idle`;
10. allow the route/session caller to return to the prior route with its already-cleared intent.

The focus manager then restores the remembered Details action, normally `details-play`. Effect cleanup calls `detach()` defensively; the engine's invalidation and stopped-report guards make that cleanup idempotent.

## Automated coverage

`tests/playbackEngine.test.ts` covers:

- one normal source assignment/load/play after readiness;
- idempotent listener attachment;
- stale resolution blocked after supersession;
- expected cancellation `AbortError` treated as nonfatal;
- full Back reset and exact listener removal;
- finite duration and seek-range enforcement;
- safe NaN/Infinity formatting;
- safe diagnostic URL representation.

`tests/playbackDecision.test.ts` covers direct-play, direct-stream, and transcode selection.

`tests/deviceProfile.test.ts` rejects wildcard video declarations and verifies the explicit H.264/AAC HLS fallback. The startup integration test also proves one `PlaybackInfo` request, one source load, one initial play, a persistent video DOM node across media-state updates, one stopped report, final reset load, and focus restoration to Details after webOS Back.

## Manual verification

Automated DOM tests cannot prove LG decoder compatibility, moving video, audio output, Magic Remote behavior, or hardware-specific media events. Repeat this test on the target LG TV after packaging:

1. Open one known playable movie and press Play once.
2. Confirm one attempt ID and one `PlaybackInfo` logical request.
3. While playback is active, inspect through the webOS inspector if available:
   - `state` reaches `playing`;
   - `sourceAssignments` is `1`;
   - `loadCalls` is `1`;
   - `playCalls` is `1`;
   - `readyState` reflects actual readiness;
   - the selected mode, container, and codecs match the source.
4. Confirm moving video and audible sound appear; a successful request or `play()` promise alone is insufficient.
5. Confirm duration is finite or `--:--`, never NaN or Infinity.
6. Confirm seek buttons remain disabled until `canSeek` becomes true.
7. Pause and resume, then seek forward and backward within valid ranges.
8. Press the Magic Remote Back key once.
9. Confirm video and audio stop immediately and Details regains focus.
10. Open Diagnostics after the final report settles. For a simple start then Back, expect one source assignment, one initial play call, two load calls including reset, and one stopped report.
11. Start the same movie again. Confirm a new attempt ID and no event, source, timer, or report from the previous attempt.

Record the exact item, media source, codecs, selected mode, and any LG media error. Do not mark hardware playback verified until moving video, audio, pause/resume, seek, Back cleanup, and a second clean start have all been observed on the television.
