#!/usr/bin/env node

const path = require('node:path');
const { readAppInfo, readCliOption, requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');

const isClose = process.argv.includes('--close');
try {
  const device = requireDeviceAlias();
  const { id: appId, version } = readAppInfo();
  const artifactPath = path.join(process.cwd(), 'dist', 'pkgs', `${appId}_${version}_all.ipk`);
  const authority = assertWorkspaceAuthority('deploy', {
    cwd: process.cwd(), targetId: device, operation: isClose ? 'close' : 'launch',
    artifactPath, manifestPath: `${artifactPath}.manifest.json`,
    approvalId: readCliOption(process.argv.slice(2), ['--approval'], '--approval'),
    rollbackReference: readCliOption(process.argv.slice(2), ['--rollback'], '--rollback')
  });
  const args = isClose ? ['-c', appId, '-d', device] : [appId, '-d', device];
  runWebOsCli('ares-launch', args, { stdio: 'inherit', cliDirectory: authority.sdkCliDirectory });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'webOS launch failed.');
  process.exitCode = 1;
}
