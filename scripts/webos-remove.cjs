#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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

function readAppId() {
  const root = process.cwd();
  const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
  if (!appInfo.id) {
    console.error('appinfo.json is missing a valid "id".');
    process.exit(1);
  }
  return appInfo.id;
}

const device = requireDeviceAlias();
const appId = readAppId();
execSync(`ares-install -r ${JSON.stringify(appId)} -d "${device}"`, { stdio: 'inherit' });
