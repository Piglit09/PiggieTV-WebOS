#!/usr/bin/env node

const { requireDeviceAlias, runWebOsCli } = require('./webos-common.cjs');

try {
  const device = requireDeviceAlias();
  runWebOsCli('ares-device', ['-i', '-d', device], { stdio: 'inherit' });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not read webOS device information.');
  process.exitCode = 1;
}
