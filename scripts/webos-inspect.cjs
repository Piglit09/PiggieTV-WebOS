#!/usr/bin/env node

const { execSync } = require('child_process');

function readCliDeviceAlias() {
  const args = process.argv.slice(2);
  const deviceIndex = args.findIndex((value) => value === '--device' || value === '-d');
  if (deviceIndex >= 0 && deviceIndex + 1 < args.length) {
    return args[deviceIndex + 1];
  }
  return null;
}

function readDeviceAlias() {
  return process.env.PTV_WEBOS_TEST_DEVICE ?? readCliDeviceAlias();
}

function requireDeviceAlias() {
  const alias = readDeviceAlias();
  if (!alias) {
    console.error('Missing webOS device alias. Set PTV_WEBOS_TEST_DEVICE or pass --device <alias>.');
    process.exit(1);
  }
  return alias;
}

const device = requireDeviceAlias();
execSync(`ares-device -i -d "${device}"`, { stdio: 'inherit' });
