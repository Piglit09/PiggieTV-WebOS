#!/usr/bin/env node

const { requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');

try {
  const device = requireDeviceAlias();
  const authority = assertWorkspaceAuthority('inspect-device', { cwd: process.cwd(), targetId: device });
  runWebOsCli('ares-device', ['-i', '-d', device], {
    stdio: 'inherit', cliDirectory: authority.sdkCliDirectory
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not read webOS device information.');
  process.exitCode = 1;
}
