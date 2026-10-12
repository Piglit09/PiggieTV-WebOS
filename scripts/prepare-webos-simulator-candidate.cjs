#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { copyValidatedBuildAssets, readAppInfo } = require('./webos-common.cjs');

const root = path.resolve(__dirname, '..');

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath, relativePath) : [relativePath];
    });
}

function prepareCandidate() {
  require('./ptv-workspace-preflight.cjs').assertWorkspaceAuthority('build', { cwd: root });
  const requestedOutput = readArgument('--output');
  if (!requestedOutput) {
    throw new Error('--output is required.');
  }

  const outputDir = path.resolve(requestedOutput);
  if (fs.existsSync(outputDir)) {
    throw new Error(`Candidate output already exists: ${outputDir}`);
  }

  const appInfo = readAppInfo(root);
  const iconNames = [...new Set([appInfo.icon, appInfo.largeIcon].filter(Boolean))];
  if (!iconNames.length || iconNames.some((iconName) => (
    typeof iconName !== 'string'
    || path.basename(iconName) !== iconName
    || !/^[A-Za-z0-9._-]+\.png$/i.test(iconName)
  ))) {
    throw new Error('appinfo.json must name safe local PNG icon files.');
  }

  const buildDir = path.join(root, 'build');
  const buildIndex = path.join(buildDir, 'index.html');
  if (!fs.existsSync(buildIndex)) {
    throw new Error('The production build is missing. Run the diagnostic build first.');
  }

  fs.mkdirSync(outputDir, { recursive: false });
  fs.copyFileSync(path.join(root, 'appinfo.json'), path.join(outputDir, 'appinfo.json'));
  for (const iconName of iconNames) {
    fs.copyFileSync(path.join(root, iconName), path.join(outputDir, iconName));
  }
  fs.copyFileSync(buildIndex, path.join(outputDir, 'index.html'));
  copyValidatedBuildAssets(path.join(buildDir, 'assets'), path.join(outputDir, 'assets'));

  const candidateIndexPath = path.join(outputDir, 'index.html');
  let candidateIndexHtml = fs.readFileSync(candidateIndexPath, 'utf8');
  const legacyEntryMatch = candidateIndexHtml.match(
    /<script[^>]+id="vite-legacy-entry"[^>]+data-src="([^"]+)"[^>]*>[\s\S]*?<\/script>/i
  );
  if (!legacyEntryMatch) {
    throw new Error(`Could not find the legacy entry script in ${candidateIndexPath}.`);
  }
  candidateIndexHtml = candidateIndexHtml.replace(
    legacyEntryMatch[0],
    `<script crossorigin id="vite-legacy-entry" src="${legacyEntryMatch[1]}" onload="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: main loaded')" onerror="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: main script failed', !0)"></script>`
  );

  const legacyPolyfillMatch = candidateIndexHtml.match(
    /<script[^>]+id="vite-legacy-polyfill"[^>]+src="([^"]+)"[^>]*><\/script>/i
  );
  if (legacyPolyfillMatch) {
    candidateIndexHtml = candidateIndexHtml.replace(
      legacyPolyfillMatch[0],
      `<script crossorigin id="vite-legacy-polyfill" src="${legacyPolyfillMatch[1]}" onload="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: polyfill loaded')" onerror="window.__ptvSetBootstrapStatus && window.__ptvSetBootstrapStatus('PTV legacy bootstrap: polyfill failed', !0)"></script>`
    );
  }
  fs.writeFileSync(candidateIndexPath, candidateIndexHtml, 'utf8');

  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
  const sourceStatus = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const files = Object.fromEntries(
    listFiles(outputDir)
      .filter((relativePath) => relativePath !== 'candidate-manifest.json')
      .map((relativePath) => [
        relativePath,
        hashFile(path.join(outputDir, ...relativePath.split('/')))
      ])
  );
  const manifest = {
    purpose: readArgument('--purpose')
      || 'Simulator-only unpacked focus-reconciliation validation candidate with runtime diagnostics',
    createdAt: new Date().toISOString(),
    appVersion: appInfo.version,
    runtimeDiagnostics: true,
    sourceCommit,
    sourceState: sourceStatus ? 'dirty-preserved' : 'clean',
    sourceStatusEntryCount: sourceStatus ? sourceStatus.split(/\r?\n/).length : 0,
    releasePackageCreated: false,
    releasePackageReason: 'The clean-worktree release package guard was preserved and was not bypassed.',
    simulatorInput: 'unpacked app directory',
    files
  };
  fs.writeFileSync(
    path.join(outputDir, 'candidate-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  console.log(outputDir);
}

if (require.main === module) {
  try {
    prepareCandidate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { prepareCandidate };
