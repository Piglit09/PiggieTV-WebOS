#!/usr/bin/env node

const path = require('node:path');
const { readAppInfo, readCliOption, requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');

try {
  const device = requireDeviceAlias();
  const { id: appId, version } = readAppInfo();
  const artifactPath = path.join(process.cwd(), 'dist', 'pkgs', `${appId}_${version}_all.ipk`);
  const authority = assertWorkspaceAuthority('deploy', {
    cwd: process.cwd(), targetId: device, operation: 'remove',
    artifactPath, manifestPath: `${artifactPath}.manifest.json`,
    approvalId: readCliOption(process.argv.slice(2), ['--approval'], '--approval'),
    rollbackReference: readCliOption(process.argv.slice(2), ['--rollback'], '--rollback')
  });
  runWebOsCli('ares-install', ['-r', appId, '-d', device], {
    stdio: 'inherit', cliDirectory: authority.sdkCliDirectory
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'webOS removal failed.');
  process.exitCode = 1;
}
