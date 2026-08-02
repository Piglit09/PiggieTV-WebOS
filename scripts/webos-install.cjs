#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FORCE_FLAG = '--force';

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

function findPackagePath() {
  const root = process.cwd();
  const outputDir = path.join(root, 'dist', 'pkgs');
  const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
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
const useForce = args.includes(FORCE_FLAG);
const device = requireDeviceAlias();
const packagePath = findPackagePath();
const forceArg = useForce ? ' --force' : '';

execSync(`ares-install ${forceArg} "${packagePath}" -d "${device}"`, { stdio: 'inherit' });
