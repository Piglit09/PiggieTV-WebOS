# PiggieTV webOS Native (Phase-1 Foundation)

This repository scaffolds a native webOS client for PiggieTV. It uses direct Jellyfin API calls and does not embed the Jellyfin web UI.

## What is included

- React + TypeScript TV shell
- Login flow:
  - server setup
  - username/password
  - quick connect flow
- Persistent storage for recent servers and sessions
- Home/browse/search/details/playback/settings/diagnostics screens
- Focus manager with directional navigation primitives
- Playback request building + progress reporting primitives
- Request/error tracking and redacted diagnostics capture
- Packaging scripts for `ares-package`, `ares-install`, and `ares-launch`

## Not implemented yet

- Full parity for rich metadata rendering
- Complete subtitle/audio selection and quality switching in playback controls
- Extensive phase-2/3 feature set (music/comics/live TV/recommended rows)

## Quick start

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Version bump

`appinfo.json` is the app-version authority. The version tool advances one patch and keeps the package metadata synchronized:

```bash
npm run version:bump
```

Patch and minor values run from `0` to `99`; `0.0.99` becomes `0.1.0`. The tool refuses to create a new major release automatically. Run `npm run version:check` to verify synchronization and the boundary rules without changing the version.

## webOS package

```bash
npm run package
npm run webos:install
npm run webos:launch
```

## Device / TV connection

Configure a target interactively when needed, then use the credential-safe listing wrapper:

```bash
ares-setup-device
npm run webos:devices
```

Use a process-environment fallback if desired:

- `PTV_WEBOS_TEST_DEVICE`

Example:

```bash
$env:PTV_WEBOS_TEST_DEVICE="PiggieTV-LG"   # PowerShell
```

The Node-based webOS helpers do not load `.env`; export this value in the current shell or pass
`--device PiggieTV-LG` explicitly. Hosted mode accepts the workstation-reachable address with
`--host-ip <ip>` (or `PTV_WEBOS_HOST_IP`) and serves only a staged production build.

## Safety notes

- Tokens are stored through the local storage abstraction and never logged raw.
- Passwords are never persisted.
- Diagnostics redacts server/user identifiers.
