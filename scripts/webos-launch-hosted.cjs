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

function readCliHost() {
  const args = process.argv.slice(2);
  const hostIndex = args.findIndex((value) => value === '--host' || value === '-i');
  if (hostIndex >= 0 && hostIndex + 1 < args.length) {
    return args[hostIndex + 1];
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

const host = process.env.PTV_WEBOS_TEST_HOST ?? readCliHost();
if (!host) {
  console.error('Missing TV host for hosted launch. Set PTV_WEBOS_TEST_HOST or pass --host <ip>.');
  process.exit(1);
}
const device = requireDeviceAlias();
console.log(`Launching hosted build on ${host} for device ${device}.`);
execSync(`ares-launch -H . -d "${device}" -I ${host}`, { stdio: 'inherit' });
