#!/usr/bin/env node

const { readAppInfo, requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');

try {
  const device = requireDeviceAlias();
  const appId = readAppInfo().id;
  runWebOsCli('ares-install', ['-r', appId, '-d', device], { stdio: 'inherit' });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'webOS removal failed.');
  process.exitCode = 1;
}
