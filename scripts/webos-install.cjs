#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { readAppInfo, readCliOption, requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');

function findPackagePath() {
  const root = process.cwd();
  const outputDir = path.join(root, 'dist', 'pkgs');
  const appInfo = readAppInfo(root);
  const expected = `${appInfo.id}_${appInfo.version}_all.ipk`;

  if (!fs.existsSync(outputDir)) {
    console.error(`Missing package output folder: ${outputDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(outputDir).filter((item) => item.toLowerCase().endsWith('.ipk'));
  const matching = files.filter((item) => item.startsWith(`${appInfo.id}_`));
  if (matching.length === 0) {
    console.error(`No package was found for app id ${appInfo.id}.`);
    process.exit(1);
  }
  if (matching.length > 1) {
    console.error('Multiple .ipk packages were found. Choose a single package first.');
    for (const item of matching) {
      console.error(`  - ${item}`);
    }
    process.exit(1);
  }

  const resolved = matching[0];
  if (resolved !== expected) {
    console.error(`Expected package ${expected} but found ${resolved}.`);
    process.exit(1);
  }
  return path.join(outputDir, resolved);
}

const args = process.argv.slice(2);
if (args.includes('--force')) {
  console.error('The installed webOS CLI does not support --force; use the normal install command.');
  process.exit(1);
}
try {
  const device = requireDeviceAlias();
  const packagePath = findPackagePath();
  const authority = assertWorkspaceAuthority('deploy', {
    cwd: process.cwd(),
    targetId: device,
    operation: 'install',
    artifactPath: packagePath,
    manifestPath: `${packagePath}.manifest.json`,
    approvalId: readCliOption(args, ['--approval'], '--approval'),
    rollbackReference: readCliOption(args, ['--rollback'], '--rollback')
  });
  runWebOsCli('ares-install', [packagePath, '-d', device], {
    stdio: 'inherit', cliDirectory: authority.sdkCliDirectory
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'webOS installation failed.');
  process.exitCode = 1;
}
