#!/usr/bin/env node

const { readAppInfo, requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');

const isClose = process.argv.includes('--close');
try {
  const device = requireDeviceAlias();
  const appId = readAppInfo().id;
  const args = isClose ? ['-c', appId, '-d', device] : [appId, '-d', device];
  runWebOsCli('ares-launch', args, { stdio: 'inherit' });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'webOS launch failed.');
  process.exitCode = 1;
}
