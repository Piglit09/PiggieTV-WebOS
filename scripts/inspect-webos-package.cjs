#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { readAppInfo, runWebOsCli } = require('./webos-common.cjs');

function readPackagedAppInfo(output) {
  const match = String(output).match(/(?:^|\r?\n)< appinfo\.json >\s*\r?\n([\s\S]*?)(?=\r?\n< [^>]+ >|\s*$)/);
  if (!match?.[1]) {
    throw new Error('Detailed package inspection did not contain appinfo.json.');
  }
  try {
    return JSON.parse(match[1].trim());
  } catch {
    throw new Error('The packaged appinfo.json is not valid JSON.');
  }
}

function validatePackagedAppInfo(output, expected) {
  const packaged = readPackagedAppInfo(output);
  if (packaged.id !== expected.id || packaged.version !== expected.version) {
    throw new Error('The packaged app identity does not match the source appinfo.json.');
  }
  if (packaged.disableBackHistoryAPI !== true) {
    throw new Error('The packaged appinfo.json must set disableBackHistoryAPI to true.');
  }
  return packaged;
}

function run() {
  const root = process.cwd();
  const appInfo = readAppInfo(root);
  const packageName = `${appInfo.id}_${appInfo.version}_all.ipk`;
  const packagePath = path.join(root, 'dist', 'pkgs', packageName);
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
    throw new Error(`Expected package not found: ${packagePath}`);
  }

  const unexpectedPackages = fs.readdirSync(path.dirname(packagePath))
    .filter(entry => entry.toLowerCase().endsWith('.ipk') && entry !== packageName);
  if (unexpectedPackages.length > 0) {
    throw new Error('Unexpected additional .ipk packages are present; inspection target is ambiguous.');
  }

  const detailedOutput = runWebOsCli('ares-package', ['-I', packagePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  validatePackagedAppInfo(detailedOutput, appInfo);

  if (process.argv.includes('--detail')) {
    process.stdout.write(detailedOutput);
    return;
  }
  runWebOsCli('ares-package', ['-i', packagePath], { stdio: 'inherit' });
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'webOS package inspection failed.');
    process.exitCode = 1;
  }
}

module.exports = { readPackagedAppInfo, run, validatePackagedAppInfo };
