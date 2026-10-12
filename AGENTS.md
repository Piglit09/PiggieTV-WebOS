# PiggieTV release versioning

- For each parent user request that materially changes tracked product files in this repository, bump the PiggieTV app version exactly once after the edits and before the final build, test, install, or deployment.
- Run `npm run version:bump` for that bump. Do not hand-edit or concatenate version digits. `appinfo.json` is the release-version authority; the tool keeps package metadata synchronized.
- Do not bump for read-only work, status or clarification replies, requests that produce no tracked product change, retries or continuations of the same parent request, or prompts sent to child agents. Multi-agent work receives one bump from the parent request.
- The patch and minor fields are decimal counters from 0 through 99. After `0.0.99`, the next version is `0.1.0`.
- Never advance the major field automatically. When the current version is `x.99.99`, stop and require explicit user authorization for the next major release.
- Bump only the app release version. API, schema, contract, webOS platform, dependency, and server-compatibility versions follow their own change policies.

# Repository authority and environment safety

- The sole approved writable webOS source is `C:\Users\Piggie\Documents\GitHub\PiggieTV-WebOS`. Its Git common directory is its own `.git` directory and its expected origin is `https://github.com/Piglit09/PiggieTV-WebOS.git`. Confirm the resolved Git root, common directory, origin, branch, full HEAD, and staged/unstaged/untracked status before a source-changing task.
- `appinfo.json:version` remains the official app version source. `package.json` and `package-lock.json` must match it. A governance-only edit that does not change product behavior does not require a release-version bump.
- Earlier Codex webOS directories, stashes, package snapshots, and validation copies are read-only history. A temporary source worktree requires task-specific operator approval, a named purpose, and a reconciliation/retirement plan. Never create a competing persistent webOS source root or edit an installed app as source.
- The local workspace preflight reads operator authority from `HKLM\SOFTWARE\PiggieTV\WorkspaceAuthority`. This checkout and `_PTV-Artifacts` are not approval stores. Never create, edit, or substitute the operator policy from a Codex task. If the key is absent or writable by the task identity, supported builds, packages, and device actions must fail closed.
- Before a supported build, package, version change, or device action, run the appropriate `scripts/ptv-workspace-preflight.cjs` mode. Package and install from clean committed source with a complete SHA-256 artifact manifest. Use an explicitly registered device and exact task-specific approval plus verified rollback for any install, remove, launch, close, or hosted launch. Production is denied by default.
- Write persistent reports, manifests, captures, and build evidence under the established `C:\Users\Piggie\Documents\GitHub\_PTV-Artifacts` hierarchy. Do not move historical evidence or place credentials, tokens, private keys, or device passphrases in Git or reports.
- Final task reports must list source root, starting and ending commit, all changed paths, tests/builds, artifact hashes, remaining dirty/untracked files, exact target and approval if any, rollback reference, and whether any device or production environment was contacted or changed.
- These wrappers govern the supported scripts only. Direct filesystem writes, raw compiler invocations, and external `ares-*` commands require separate OS, CI, and credential restrictions; do not claim universal enforcement from this file or these scripts.
