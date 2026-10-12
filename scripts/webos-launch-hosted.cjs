#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');
const {
  readAppInfo,
  readCliOption,
  requireDeviceAlias,
  requireHostIp,
  runWebOsCli
} = require('./webos-common.cjs');

function main() {
  try {
    const root = process.cwd();
    const hostIp = requireHostIp();
    const device = requireDeviceAlias();
    const appInfo = readAppInfo(root);
    const artifactPath = path.join(root, 'dist', 'pkgs', `${appInfo.id}_${appInfo.version}_all.ipk`);
    const manifestPath = `${artifactPath}.manifest.json`;
    const authority = assertWorkspaceAuthority('deploy', {
      cwd: root,
      targetId: device,
      operation: 'hosted',
      artifactPath,
      manifestPath,
      approvalId: readCliOption(process.argv.slice(2), ['--approval'], '--approval'),
      rollbackReference: readCliOption(process.argv.slice(2), ['--rollback'], '--rollback')
    });
    const { verifyArtifactManifest } = require('./ptv-artifact-manifest.cjs');
    const manifest = verifyArtifactManifest(manifestPath, { artifactPath, sourceRoot: root });
    const expectedStaging = fs.realpathSync.native(path.join(root, 'dist', '.ptv-webos-package'));
    const actualStaging = fs.realpathSync.native(manifest.staging.root);
    if (actualStaging.toLowerCase() !== expectedStaging.toLowerCase()) {
      throw new Error('Hosted launch requires the verified package staging directory.');
    }
    console.log(`Launching verified hosted package via workstation IP ${hostIp} on device ${device}.`);
    runWebOsCli('ares-launch', ['-H', actualStaging, '-I', hostIp, '-d', device], {
      stdio: 'inherit', cliDirectory: authority.sdkCliDirectory
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Hosted webOS launch failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
