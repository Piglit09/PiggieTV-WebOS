# webOS Testing

## Phase 1 target matrix

| Item | Acceptance target |
| --- | --- |
| Television | LG 70UN7070PUA |
| webOS toolchain | webOS SDK 5.6.2 |
| Input | Magic Remote and DPAD |
| Jellyfin URL | `https://piggietv.com` |
| Jellyfin version | 10.11.11 reported baseline; record the live version at test time |
| Application ID | `com.piggietv.webosnative` |
| Application version | `0.1.0` |
| Package | `dist/pkgs/com.piggietv.webosnative_0.1.0_all.ipk` |
| Configured TV alias | `PiggieTV-LG` |
| Configured TV endpoint | `10.16.0.231:9922` |

## Evidence policy and current hardware status

Automated tests, a production build, and package inspection are software evidence. They do not prove behavior on an LG television. Emulator and desktop/jsdom runs also cannot certify the hardware decoder, media-format support, real Magic Remote event behavior, webOS application exit, TLS/network conditions, overscan, or on-device performance.

Record physical-TV execution in the acceptance report for the exact candidate IPK. Every unchecked item in the manual checklist below remains unexecuted until a tester runs it on the named LG model and records the result. Do not convert an automated pass into a checked hardware item.

## Automated validation gate

Run the complete gate from the repository root for every candidate package:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run package
npm run package:inspect
```

The automated suite exercises the following stabilized behavior in a simulated environment:

- ordered session-controller commit, timeouts, duplicate submissions, cancellation, stale-response rejection, redaction, persistence failure, and one sequential Quick Connect owner
- the Jellyfin Quick Connect contract: one initiation, sequential state polls, and one final authentication exchange only after approval
- startup restore, rejected-token clearing, canonical persistence, StrictMode cleanup/remount, one Home navigation, server normalization, sign-out cleanup, and route-history reset
- one playback load/source/play attempt, readiness gating, superseded-attempt cleanup, finite/clamped seeking, duration fallback, and listener removal
- persistent playback video ownership, full Back cleanup, Details focus restoration, and protection against stale stop ownership
- DPAD, Enter, webOS Back key code 461, editable-field Backspace, repeat suppression, one global listener, focus movement, hidden/disabled filtering, and route focus restoration
- end-to-end diagnostic redaction and ErrorBoundary recovery without losing remote-input ownership

Record command, exit code, and artifact path in the acceptance report. These assertions are necessary software checks, but the physical-TV checklist is a separate gate.

## Packaging and install flow

1. Commit the candidate source, confirm the Git worktree is clean, run the automated validation gate, and retain the exact candidate package. `npm run package` refuses a dirty source tree and performs a production build before invoking the webOS packager; diagnostics embed the authoritative `appinfo.json` identity and committed Git revision.
2. List configured aliases with `npm run webos:devices`. This wrapper deliberately omits credential and passphrase fields.
3. Confirm the physical target with `npm run webos:device:info -- --device PiggieTV-LG`.
4. Install the exact existing package with `npm run webos:install -- --device PiggieTV-LG`.
5. Launch it with `npm run webos:launch -- --device PiggieTV-LG`.
6. Route to Web Inspector Console with `npm run webos:logs -- --device PiggieTV-LG` while running the checklist.

The current local mapping is `PiggieTV-LG` to `10.16.0.231:9922`; the alias, rather than the IP address, is passed to `--device`. An explicit `--device` value takes precedence over the optional `PTV_WEBOS_TEST_DEVICE` fallback. Do not use or paste raw `ares-setup-device --list` output because the installed CLI includes the Developer Mode passphrase column. Do not commit credentials, developer-mode keys, passwords, access tokens, or Quick Connect secrets.

The Node helpers do not load `.env`. Export `PTV_WEBOS_TEST_DEVICE` in the active shell or use the explicit `--device` form shown above. Hosted mode builds and serves only `dist/.ptv-webos-hosted`; pass the workstation address reachable by the TV with `--host-ip <ip>` or `PTV_WEBOS_HOST_IP`.

Close and relaunch without relying on the CLI's default device:

```powershell
npm run webos:close -- --device PiggieTV-LG
npm run webos:launch -- --device PiggieTV-LG
```

The removed `webos:install:release` command passed an undocumented `--force` flag. Use the normal install command above for both first installation and updates.

## Web Inspector and log capture

`npm run webos:inspect -- --device PiggieTV-LG` invokes `ares-inspect` for `com.piggietv.webosnative`. It prints an inspector URL and intentionally does not open a browser. `npm run webos:logs -- --device PiggieTV-LG` routes to the same supported workflow with Console instructions; it does not run a broad device-log tail.

1. Launch PiggieTV on the named target.
2. Run either inspector command and open the printed URL locally.
3. Select **Console** and enable **Preserve log** before reproducing the issue.
4. Save or copy only the relevant interval and redact it before sharing.

Keep local captures under the ignored repository roots `evidence/`, `artifacts/`, `diagnostics/`, or `screenshots/`. Do not save credentials, private keys, raw HAR files, or unreviewed inspector exports elsewhere in the source tree.

The inspector's Network and Storage panels can reveal request bodies, authorization headers, persisted access tokens, and Quick Connect secrets. Treat the inspector URL and all captured output as private test evidence. Never attach an unreviewed inspector export or broad device log to an issue.

## Emulator smoke test

Use the standard emulator flow for the installed SDK:

- open the emulator
- install the generated `dist/pkgs/*.ipk`
- launch PiggieTV
- smoke-test startup, route transitions, DPAD navigation, Enter, Back, and diagnostics

An emulator pass may catch packaging and layout regressions. It does not complete any physical-TV checkbox below.

## Physical-TV manual acceptance checklist

### Test record and preconditions

- [ ] Record tester, date/time, TV model `LG 70UN7070PUA`, television firmware/webOS version, and webOS SDK 5.6.2.
- [ ] Record the package filename, application version, source revision if available, and package checksum.
- [ ] Confirm `https://piggietv.com` is reachable from the TV and record the live Jellyfin version; note any difference from the reported 10.11.11 baseline.
- [ ] Install and launch the candidate IPK, attach Web Inspector, enable Preserve log, then close and relaunch for the captured cold-launch check; verify no fatal JavaScript or packaging error.
- [ ] Confirm the full UI stays inside visible safe margins at 1920×1080 with no clipped focus ring or critical text.

### Cold startup, password sign-in, and restore

- [ ] With no saved session, cold-launch into startup/server validation without briefly showing Home or the user label `Guest`.
- [ ] Validate `https://piggietv.com`, continue to sign-in, and confirm every login control is reachable with the DPAD and visibly focused.
- [ ] Submit invalid credentials once; confirm one readable terminal error appears, inputs are usable again, and no Home navigation occurs.
- [ ] Submit valid username/password credentials; confirm the request completes, Home opens once, and no duplicate toast, route transition, or request appears in logs.
- [ ] Confirm auth diagnostics progress through response parsing, validation, persistence, API-context update, state commit, navigation, and `COMPLETE` without exposing password or token material.
- [ ] Close and cold-relaunch the app; confirm startup validates the stored user before showing Home and restores the correct user without a sign-in or Guest flash.
- [ ] Interrupt connectivity during stored-session validation; confirm sign-in is shown without corrupting the saved credential, then restore connectivity and retry/relaunch.
- [ ] Reject or invalidate the saved token in a controlled test; confirm the app clears it, shows the expired-session message, and does not restore Home on the next launch.

### Quick Connect and competing attempts

- [ ] Start Quick Connect and confirm exactly one code is shown and only one initiation/poll owner appears in diagnostics or server logs.
- [ ] Approve the code in Jellyfin; confirm one canonical session is persisted and Home opens once.
- [ ] Leave or cancel Quick Connect before approval; confirm polling stops and a late approval cannot navigate or overwrite the current session.
- [ ] Start one password attempt, then deliberately supersede it with another; confirm only the newest attempt can commit user, token, or route state.

### Home, Details, focus, and remote input

- [ ] Use both Magic Remote directional input and the physical DPAD through every Home row; arrows never scroll the web page.
- [ ] Confirm focus is always visible and never lands on clipped, hidden, disabled, or removed controls.
- [ ] Hold an arrow to test navigation repeat, then press Enter once; confirm Enter triggers exactly one action and a repeated keydown does not double-open a route.
- [ ] Open an item from Home, press webOS Back, and confirm Details closes once and focus returns to the originating Home card.
- [ ] Traverse sign-in, server selection, Home, Details, Settings, Diagnostics, and playback with Back; confirm each press performs one app action and does not invoke stray browser history.
- [ ] At root Home or server selection, press Back and confirm the webOS application exits cleanly. From sign-in, confirm Back returns to server selection.

### Playback lifecycle

- [ ] Open a known-compatible movie or episode from Details and start playback; confirm moving video is visible rather than only poster/background artwork.
- [ ] For one play action, confirm diagnostics/server logs show one playback-info attempt, one chosen source assignment, and one play start—not duplicated load/play work.
- [ ] Confirm play waits for media readiness and does not immediately fail with a load/play race.
- [ ] Confirm elapsed time advances and duration displays a finite value, or `--:--` while genuinely unavailable; no `NaN`, `Infinity`, or invalid progress width appears.
- [ ] Pause and resume several times with Enter; each press changes state once and playback remains synchronized.
- [ ] Seek forward and backward when the stream reports a finite seekable duration; confirm seeks clamp to valid bounds. When seeking is unavailable, confirm the UI does not send an invalid seek.
- [ ] Press Back during playback; confirm media stops, progress reporting ends, listeners are released, Details returns once, and focus is restored.
- [ ] Start a second item immediately after leaving the first; confirm no stale source, audio, timer, request, or late error from the first attempt affects it.
- [ ] Exercise at least one direct-play candidate and one direct-stream/transcode candidate supported by the server; record the selected path, codecs, and any TV decoder error.

### Sign out, change server, and persistence

- [ ] While signed in, choose **Sign out**; confirm playback/session work stops, the token is absent from subsequent requests, sign-in appears, and Back cannot return to authenticated screens.
- [ ] Cold-relaunch after sign-out; confirm the previous user is not restored.
- [ ] Sign in again, choose **Change server**, and confirm session/auth state is cleared, server selection appears with empty authenticated route history, and the former token is not reused.
- [ ] Simulate a storage-clear failure if the test setup allows it; confirm the app reports the failure instead of pretending sign-out succeeded.

### Diagnostics, resilience, and final observation

- [ ] Review on-device diagnostics and logs for uncaught exceptions, unhandled rejections, duplicate global handlers, repeated requests, and focus errors.
- [ ] Confirm logs contain no plaintext password, access token, Quick Connect secret, or token-bearing stream URL.
- [ ] Suspend/background and resume the app if supported by the test setup; confirm the UI, focus owner, and playback state remain coherent.
- [ ] Leave the app navigating and playing representative content long enough to detect runaway polling, timer duplication, memory pressure, or steadily worsening input latency.

## Acceptance report minimums

Attach or record:

- automated gate command results
- exact IPK filename and checksum
- TV firmware/webOS version and live Jellyfin version
- pass/fail and notes for every hardware checkbox
- relevant redacted log excerpts and timestamps for any failure
- media item/path and codec details for playback failures
- reproduction steps, observed result, expected result, and whether relaunch or reinstall changes the outcome

Phase 1 hardware acceptance is complete only when all required physical-TV checks pass or every exception is documented and explicitly accepted. Automated success alone is not hardware acceptance.
