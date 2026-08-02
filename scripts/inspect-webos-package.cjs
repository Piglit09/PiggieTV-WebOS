#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { readAppInfo, runWebOsCli } = require('./webos-common.cjs');

const root = process.cwd();
const appInfo = readAppInfo(root);

const packageName = `${appInfo.id}_${appInfo.version}_all.ipk`;
const packagePath = path.join(root, 'dist', 'pkgs', packageName);
if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
  console.error(`Expected package not found: ${packagePath}`);
  process.exit(1);
}

const unexpectedPackages = fs.readdirSync(path.dirname(packagePath))
  .filter(entry => entry.toLowerCase().endsWith('.ipk') && entry !== packageName);
if (unexpectedPackages.length > 0) {
  console.error('Unexpected additional .ipk packages are present; inspection target is ambiguous.');
  process.exit(1);
}

const informationFlag = process.argv.includes('--detail') ? '-I' : '-i';
runWebOsCli('ares-package', [informationFlag, packagePath], { stdio: 'inherit' });
