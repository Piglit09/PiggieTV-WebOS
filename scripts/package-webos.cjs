#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { copyValidatedBuildAssets, readAppInfo, runWebOsCli } = require('./webos-common.cjs');

const root = process.cwd();
const stagingDir = path.join(root, 'dist', '.ptv-webos-package');
const outputDir = path.join(root, 'dist', 'pkgs');
const appInfo = readAppInfo(root);
const appId = appInfo.id;
const appVersion = appInfo.version;
const appName = `${appId}_${appVersion}_all.ipk`;
const iconNames = [...new Set([appInfo.icon, appInfo.largeIcon].filter(Boolean))];

if (!iconNames.length || iconNames.some(iconName => (
  typeof iconName !== 'string' || path.basename(iconName) !== iconName || !/^[A-Za-z0-9._-]+\.png$/i.test(iconName)
))) {
  throw new Error('appinfo.json must name safe local PNG icon files.');
}

function removePath(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function copyFileOrThrow(source, target) {
  fs.cpSync(source, target, { recursive: false, force: true });
}

function assertCleanWorktree() {
  let status;
  try {
    status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    throw new Error('Release packaging requires this source tree to be inside a Git repository.');
  }
  if (status.trim()) {
    throw new Error('Release packaging requires a clean Git worktree; commit or remove source changes first.');
  }
}

function run() {
  assertCleanWorktree();
  removePath(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  removePath(outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  copyFileOrThrow(path.join(root, 'appinfo.json'), path.join(stagingDir, 'appinfo.json'));
  for (const iconName of iconNames) {
    copyFileOrThrow(path.join(root, iconName), path.join(stagingDir, iconName));
  }
  copyFileOrThrow(path.join(root, 'build', 'index.html'), path.join(stagingDir, 'index.html'));
  copyValidatedBuildAssets(path.join(root, 'build', 'assets'), path.join(stagingDir, 'assets'));

  const stagingIndexPath = path.join(stagingDir, 'index.html');
  let stagingIndexHtml = fs.readFileSync(stagingIndexPath, 'utf8');
  const legacyEntryMatch = stagingIndexHtml.match(/<script[^>]+id="vite-legacy-entry"[^>]+data-src="([^"]+)"[^>]*>[\s\S]*?<\/script>/i);
  if (!legacyEntryMatch) {
    throw new Error(`Could not find legacy entry script in ${stagingIndexPath}.`);
  }
  const legacyEntrySrc = legacyEntryMatch[1];
  stagingIndexHtml = stagingIndexHtml.replace(
    legacyEntryMatch[0],
    `<script crossorigin id="vite-legacy-entry" src="${legacyEntrySrc}" onload="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: main loaded')" onerror="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: main script failed', !0)"></script>`
  );

  const legacyPolyfillMatch = stagingIndexHtml.match(/<script[^>]+id="vite-legacy-polyfill"[^>]+src="([^"]+)"[^>]*><\/script>/i);
  if (legacyPolyfillMatch) {
    const legacyPolyfillSrc = legacyPolyfillMatch[1];
    stagingIndexHtml = stagingIndexHtml.replace(
      legacyPolyfillMatch[0],
      `<script crossorigin id="vite-legacy-polyfill" src="${legacyPolyfillSrc}" onload="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: polyfill loaded')" onerror="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: polyfill failed', !0)"></script>`
    );
  }

  fs.writeFileSync(stagingIndexPath, stagingIndexHtml);

  runWebOsCli('ares-package', [stagingDir, '-o', outputDir], { stdio: 'inherit' });

  const files = fs.readdirSync(outputDir).filter((entry) => entry.toLowerCase().endsWith('.ipk'));
  if (files.length !== 1) {
    throw new Error(`Expected one package but found ${files.length} in ${outputDir}`);
  }
  if (files[0] !== appName) {
    throw new Error(`Expected package name ${appName} but found ${files[0]}`);
  }

  const expected = path.join(outputDir, appName);
  if (!fs.existsSync(expected)) {
    throw new Error(`Expected package not found at ${expected}`);
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'webOS packaging failed.');
    process.exitCode = 1;
  }
}

module.exports = { assertCleanWorktree, run };
