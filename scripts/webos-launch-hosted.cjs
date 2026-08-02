#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  copyValidatedBuildAssets,
  readAppInfo,
  requireDeviceAlias,
  requireHostIp,
  runWebOsCli
} = require('./webos-common.cjs');

function stageHostedBuild(root = process.cwd()) {
  const distDir = path.resolve(root, 'dist');
  const hostedDir = path.resolve(distDir, '.ptv-webos-hosted');
  const appInfo = readAppInfo(root);
  const iconNames = [...new Set([appInfo.icon, appInfo.largeIcon].filter(Boolean))];
  if (path.dirname(hostedDir) !== distDir) {
    throw new Error('Hosted staging directory resolved outside dist.');
  }
  if (!iconNames.length || iconNames.some(iconName => (
    typeof iconName !== 'string' || path.basename(iconName) !== iconName || !/^[A-Za-z0-9._-]+\.png$/i.test(iconName)
  ))) {
    throw new Error('appinfo.json must name safe local PNG icon files.');
  }

  const required = [
    path.join(root, 'appinfo.json'),
    ...iconNames.map(iconName => path.join(root, iconName)),
    path.join(root, 'build', 'index.html'),
    path.join(root, 'build', 'assets')
  ];
  for (const source of required) {
    if (!fs.existsSync(source)) {
      throw new Error(`Hosted build input is missing: ${source}`);
    }
  }

  if (fs.existsSync(hostedDir)) fs.rmSync(hostedDir, { recursive: true, force: true });
  fs.mkdirSync(hostedDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'appinfo.json'), path.join(hostedDir, 'appinfo.json'));
  for (const iconName of iconNames) {
    fs.copyFileSync(path.join(root, iconName), path.join(hostedDir, iconName));
  }
  fs.copyFileSync(path.join(root, 'build', 'index.html'), path.join(hostedDir, 'index.html'));
  copyValidatedBuildAssets(path.join(root, 'build', 'assets'), path.join(hostedDir, 'assets'));
  return hostedDir;
}

function main() {
  try {
    const hostIp = requireHostIp();
    const device = requireDeviceAlias();
    const hostedDir = stageHostedBuild();
    console.log(`Launching staged hosted build via workstation IP ${hostIp} on device ${device}.`);
    runWebOsCli('ares-launch', ['-H', hostedDir, '-I', hostIp, '-d', device], { stdio: 'inherit' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Hosted webOS launch failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { stageHostedBuild };
