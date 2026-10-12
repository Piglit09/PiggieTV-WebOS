# webOS Testing

## Three-tier validation matrix

LG lists the webOS CLI, webOS Studio, and webOS TV Simulator as separate SDK tools. It also marks the old Emulator as deprecated and provides the Simulator for webOS TV 22 and later. See LG's [SDK Introduction](https://webostv.developer.lge.com/develop/tools/sdk-introduction), [Simulator Developer Guide](https://webostv.developer.lge.com/develop/tools/simulator-dev-guide), and [webOS CLI Developer Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide).

| Tier | Environment and repeatable entry point | What it can prove | Release authority |
| --- | --- | --- | --- |
| Tier 1: automated/browser | Vitest/jsdom, production build/package inspection, and targeted rendered-browser checks | Pure logic, request sequencing, focus contracts, incremental loading/windowing invariants, legacy-bundle production output, and desktop rendered regressions | Required first gate; cannot certify webOS or television hardware |
| Tier 2: official Simulator | LG webOS TV 26 Simulator 1.5.0 on Windows, driven by webOS CLI 3.2.5 with an unpacked candidate app directory | Simulator WebView startup, 1920x1080 layout, CDP DPAD/focus traversal, a virtual-RCU delivery probe, bounded library diagnostics, console/runtime failures, and repeatable screenshot evidence | Required platform smoke/stress gate when available; cannot clear a physical-TV hold |
| Tier 3: physical LG | Exact candidate IPK on LG 70UN7070PUA, using its Magic Remote/DPAD and live Jellyfin service | Real webOS lifecycle, hardware input, memory/latency, decoder and media behavior, TLS/network conditions, overscan, long-run stability, and end-to-end exit/back behavior | Final hardware acceptance authority |

The tiers accumulate evidence; they do not substitute for one another. A Tier 2 pass promotes confidence and can catch platform-specific regressions earlier, but it must never be reported as a Tier 3 pass.

### Current Shows-library hold

The v0.1.8 Shows-library candidate remains on **physical-TV HOLD**. Tier 2 evidence may confirm launch, DPAD behavior, incremental loading, render-window bounds, artwork concurrency, filter resets, Details/Back focus restoration, and long traversal in the Simulator. Only a Tier 3 run of the exact candidate IPK can clear the hold. The Simulator must not change the physical checklist status or be used to certify hardware memory, decoder, lifecycle, or real-remote behavior.

## Physical-TV target baseline

| Item | Acceptance target |
| --- | --- |
| Television | LG 70UN7070PUA |
| webOS toolchain | webOS SDK 5.6.2 |
| Input | Magic Remote and DPAD |
| Jellyfin URL | `https://piggietv.com` |
| Jellyfin version | 10.11.11 reported baseline; record the live version at test time |
| Application ID | `com.piggietv.webosnative` |
| Application version | Record the exact candidate version from `appinfo.json` |
| Package | Record the exact `dist/pkgs/com.piggietv.webosnative_<version>_all.ipk` filename and checksum |
| Configured TV alias | `PiggieTV-LG` |
| Configured TV endpoint | `10.16.0.231:9922` |

## Evidence policy and current hardware status

Automated tests, a production build, and package inspection are Tier 1 software evidence. Simulator and desktop/jsdom runs also cannot certify the hardware decoder, media-format support, real Magic Remote event behavior, physical webOS application exit, TLS/network conditions, overscan, or on-device performance.

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

1. Confirm the operator-controlled workspace policy is provisioned and the target has a separate, exact deployment approval and verified rollback. Without that policy, build, package, and device mutation commands fail closed.
2. Commit the candidate source, confirm the Git worktree is clean, run the automated validation gate, and retain the exact candidate package. `npm run package` refuses a dirty source tree and performs a production build before invoking the webOS packager. The package sidecar manifest records the authoritative `appinfo.json` identity, committed Git revision, complete staged file hashes, and final IPK hash.
3. List configured aliases with `npm run webos:devices`. This wrapper deliberately omits credential and passphrase fields.
4. Confirm the physical target with `npm run webos:device:info -- --device PiggieTV-LG`.
5. Install the exact approved package with `npm run webos:install -- --device PiggieTV-LG --approval <approval-id> --rollback <verified-reference>`.
6. Launch it with `npm run webos:launch -- --device PiggieTV-LG --approval <approval-id> --rollback <verified-reference>`.
7. Route to Web Inspector Console with `npm run webos:logs -- --device PiggieTV-LG` while running the checklist.

The current local mapping is `PiggieTV-LG` to `10.16.0.231:9922`; the alias, rather than the IP address, is passed to `--device`. An explicit `--device` value takes precedence over the optional `PTV_WEBOS_TEST_DEVICE` fallback. Do not use or paste raw `ares-setup-device --list` output because the installed CLI includes the Developer Mode passphrase column. Do not commit credentials, developer-mode keys, passwords, access tokens, or Quick Connect secrets.

The Node helpers do not load `.env`. Export `PTV_WEBOS_TEST_DEVICE` in the active shell or use the explicit `--device` form shown above. Hosted mode launches only the already packaged and verified `dist/.ptv-webos-package` directory; it does not build or create separate hosted files. Use a separately approved hosted operation and pass the workstation address reachable by the TV with `--host-ip <ip>` or `PTV_WEBOS_HOST_IP`.

Close and relaunch without relying on the CLI's default device:

```powershell
npm run webos:close -- --device PiggieTV-LG --approval <approval-id> --rollback <verified-reference>
npm run webos:launch -- --device PiggieTV-LG --approval <approval-id> --rollback <verified-reference>
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

## Tier 2: official webOS TV Simulator workflow

The verified local Tier 2 baseline is **webOS TV 26 Simulator 1.5.0** with **webOS CLI 3.2.5**. LG's current SDK guidance deprecates the older Emulator and treats Simulator as a separate desktop test tool. Do not use the configured CLI alias named `emulator`; it is an SSH target for the old Emulator model and is not the TV 26 Simulator.

### Launch contract

Simulator launch consumes the unpacked web-app root containing `appinfo.json` and `index.html`. It does not consume or install an IPK. The official CLI form verified for this environment is:

```powershell
$simDir = 'C:\path\to\webOS_TV_26_Simulator_1.5.0'
$appDir = 'C:\path\to\exact-candidate\dist\.ptv-webos-package'
ares-launch -s 26 -sp $simDir $appDir
```

This is the LG-documented `ares-launch --simulator` path. Use a permanently extracted Simulator directory, not a temporary archive-viewer extraction. Record the Simulator version, CLI version, absolute candidate app directory, its `appinfo.json` version, the corresponding IPK filename/checksum, and the source revision in the evidence record.

The repeatable repository wrapper uses explicit Simulator inputs and rejects physical-device routing:

```powershell
$runStamp = Get-Date -Format 'yyyyMMddTHHmmss'
$artifactDir = "artifacts\webos-simulator\$runStamp"
npm run validate:webos:simulator -- `
  --simulator-version 26 `
  --simulator-path $simDir `
  --no-prepare `
  --app-dir $appDir `
  --artifact-dir $artifactDir `
  --auth-wait-minutes 10 `
  --max-rows 150 `
  --endurance-minutes 30 `
  --lifecycle-cycle
```

Omit `--no-prepare` and `--app-dir` only when the wrapper should prepare a fresh candidate app directory itself. An existing exact staging directory must use `--no-prepare --app-dir`. Use `--auth-wait-minutes <1-30>` only when the Simulator does not restore its authorized Jellyfin session: sign in interactively inside the runner-owned window and leave that window open, and the runner will continue after it observes an authenticated app route. Credentials must never be passed in the command, environment, or artifacts. Without this option, an unauthenticated route remains an immediate authenticated-library HOLD.

The wrapper always uses its localhost-only CDP diagnostic launch; use the raw `ares-launch -s` command above for the ordinary LG launch path. `--lifecycle-cycle` asks the runner to close and relaunch only its own process tree and verify that the localhost debugging port closes. `--keep-open` is an opt-in debugging convenience and must not be used for an unattended gate. The wrapper must never read or accept `--device`, `PTV_WEBOS_TEST_DEVICE`, `PiggieTV-LG`, or another device default.

The Simulator is not an installed device target. Do not run `ares-install`, `ares-setup-device`, `npm run webos:install`, `npm run webos:health`, `npm run webos:logs`, or device-alias lifecycle commands against it. The ordinary LG flow launches a directory with `ares-launch -s`; the Simulator's own File/RCU controls close the app. The validation runner may stop only the exact Simulator process that it started and recorded. It must not terminate a pre-existing Simulator window.

### Diagnostic automation boundary

LG automatically provides the Simulator's Web Inspector. The repeatable stress workflow additionally has a custom diagnostic mode that starts the exact Simulator executable with Chromium remote debugging bound to `127.0.0.1` only. This CDP path is a PiggieTV test harness, not a documented LG device API and not release evidence by itself.

- Accept only `http://127.0.0.1:<port>` discovery and `ws://127.0.0.1:<port>/...` or equivalent `localhost` loopback targets. Reject `0.0.0.0`, LAN addresses, credentials in URLs, TLS-remapped endpoints, missing ports, and unexpected target types.
- Select the PiggieTV page and the virtual RCU page explicitly. Never fall back to the Simulator shell, keyboard, overlay, or another page target.
- Probe the Simulator's virtual-RCU control first. If its renderer does not deliver the input in diagnostic mode, record that result as `HOLD`; do not silently claim virtual-RCU coverage.
- The automated stress fallback uses Chromium `Input.dispatchKeyEvent` on the PiggieTV target. These are trusted renderer input events, not DOM `click()` or synthetic JavaScript keyboard events, but they bypass the Simulator's virtual-RCU renderer and therefore cannot certify real RCU/remote delivery.
- Use CDP on the PiggieTV page for frozen diagnostic snapshots, focused-element identity/fingerprint, console failures, page visibility, layout metrics, screenshots, and the explicitly reported DPAD fallback only. Do not mutate focus or invoke application navigation functions.
- Sanitize every JSON/text artifact before writing it. Redact passwords, access tokens, Quick Connect material, authorization headers, token-bearing URLs, private media identifiers, and WebSocket target IDs. Keep exact local candidate/Simulator paths only in private local evidence; never capture browser storage, request bodies, or an unreviewed network trace.

The runner suppresses screenshots on startup, server, sign-in, Quick Connect, or an unknown route because bitmap evidence cannot be safely redacted. Its metadata network record contains only filter class, `StartIndex`, `Limit`, sequence, timing, and duplicate-active status; it never retains request headers, response bodies, user IDs, or raw URLs.

The debug endpoint must be closed with the runner-owned Simulator process. Never leave a remote-debugging listener reachable from the network.

### Shows-library Simulator acceptance

Run the candidate at a 1920x1080 app viewport using a test session that is already authorized to read the intended Jellyfin library. Do not put credentials or tokens in command-line arguments, environment files, screenshots, or artifacts. If authorization is unavailable, record the run as an unauthenticated launch/diagnostic smoke only; do not claim the library traversal passed.

Exercise and record at least:

- cold launch, Home, and navigation into Shows using the explicitly reported Simulator DPAD method
- first render and first metadata request of 24 titles
- prefetch before the focused row reaches empty space
- repeated DPAD traversal through at least 50 rows, plus a complete 1,048-title traversal when the test library reports that total; record whether input came from the virtual RCU or direct app-target CDP
- no more than 96 poster cards rendered at once and no more than six active artwork loads
- exactly one focus owner, focus remaining inside the render window, no focus jump when a batch appends, and no duplicate metadata request for one offset/filter generation
- repeated Down, Up, Left, Right, rapid Down, and rapid Up across many render-window boundaries
- Details open and exact Back restoration near the beginning, 25%, 50%, 75%, and end after the source card has moved through the render window
- Recently Added, A-Z, and Favorites resets, including stale-response rejection and correct focus ownership
- final-row/end-state behavior: no request past the total and a stable `All 1,048 shows loaded` result when the live total is 1,048
- substantial upward traversal after reaching the end, followed by downward traversal, to prove old render windows reconstruct correctly
- eight 180px columns and zero long-title, grid, and body overflow at 1920x1080 using actual long Jellyfin titles plus English, Japanese, Unicode, and punctuation-heavy fixtures
- at least 30 minutes of deep browsing, Details/Back, filter changes, and rapid/upward/downward DPAD activity
- console errors/warnings, unhandled rejections, page reloads, page/WebView identity, focus latency, and bounded render/artwork metrics during the endurance interval

The invariant classifier may report a check as **UNKNOWN** when the candidate diagnostic snapshot does not expose that evidence. Missing evidence is not a pass and must not be converted into a violation. Observed breaches use stable failure codes: `INITIAL_BATCH_LIMIT`, `RENDER_WINDOW_LIMIT`, `ARTWORK_CONCURRENCY_LIMIT`, `FOCUS_OUTSIDE_WINDOW`, `FOCUS_OWNER_COUNT`, and `DUPLICATE_METADATA_REQUEST`.

### Simulator evidence and failure artifacts

Store local output under the ignored path `artifacts/webos-simulator/<UTC timestamp>/`. Each run should retain a sanitized manifest containing the tool versions, candidate identity, command mode, start/end timestamps, test steps, per-check `PASS`/`FAIL`/`UNKNOWN`, and process ownership. Add bounded metric samples, redacted console failures, and screenshots for Home, Shows initial load, deep navigation, focused poster, long-title containment, a post-window transition, Details, Details-to-Back restoration, and the near-bottom/final loaded state when those states are reached.

On failure, preserve the last safe diagnostic snapshot, the current/previous step, focus fingerprint and render-window metrics, bounded recent events, sanitized console errors, and a screenshot before stopping only the runner-owned process. A Simulator pass or failure updates Tier 2 evidence only. It does not check, clear, or waive any Tier 3 item below.

Do not tune production constants to make a Simulator result look better. The 24-item batch size, 96-card DOM cap, and six-request artwork limit remain fixed unless separate physical-TV evidence supports a change. The Simulator is a desktop approximation and is not evidence of the physical television's Chromium/webOS compatibility, CPU/GPU behavior, memory pressure, image decoding, playback, or long-session stability.

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
