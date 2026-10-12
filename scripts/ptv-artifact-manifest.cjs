#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'PTV_WEBOS';
const APP_ID = 'com.piggietv.webosnative';
const SCHEMA_VERSION = 1;

function assertNoLinkedPathComponents(target, label) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} contains a link or junction.`);
    }
  }
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertRealDirectory(directory, label) {
  const absolute = path.resolve(directory);
  assertNoLinkedPathComponents(absolute, label);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a link.`);
  }
  return fs.realpathSync.native(absolute);
}

function assertRealFile(file, label) {
  const absolute = path.resolve(file);
  assertNoLinkedPathComponents(absolute, label);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a link.`);
  }
  return { path: fs.realpathSync.native(absolute), size: stat.size };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stageFiles(stagingRoot) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error(`Staging contains a link: ${name}`);
      }
      if (!inside(stagingRoot, fs.realpathSync.native(file))) {
        throw new Error(`Staging path escapes its root: ${name}`);
      }
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        const relative = path.relative(stagingRoot, file).split(path.sep).join('/');
        files.push({ path: relative, size: stat.size, sha256: sha256File(file) });
      } else {
        throw new Error(`Staging contains a non-file entry: ${name}`);
      }
    }
  }
  visit(stagingRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function gitOutput(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  env.GIT_OPTIONAL_LOCKS = '0';
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  }).trim();
}

function sourceIdentity(sourceRoot) {
  const root = assertRealDirectory(sourceRoot, 'Source root');
  const gitRoot = fs.realpathSync.native(gitOutput(root, ['rev-parse', '--show-toplevel']));
  if (root !== gitRoot) {
    throw new Error('Source root must be the exact Git checkout root.');
  }
  const head = gitOutput(root, ['rev-parse', '--verify', 'HEAD']);
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new Error('Source commit must be a full Git object ID.');
  }
  if (gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('Artifact provenance requires a clean committed source tree.');
  }
  const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
  if (appInfo.id !== APP_ID || typeof appInfo.version !== 'string' || !appInfo.version.trim()) {
    throw new Error('Source appinfo.json identity or version is invalid.');
  }
  return { root, head, version: appInfo.version };
}

function assertStagedAppInfo(stagingRoot, source, files) {
  if (!files.some(file => file.path === 'appinfo.json') ||
      !files.some(file => file.path === 'index.html')) {
    throw new Error('Staging is missing required package files.');
  }
  const appInfo = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'appinfo.json'), 'utf8'));
  if (appInfo.id !== APP_ID || appInfo.version !== source.version) {
    throw new Error('Staged app identity/version differs from source.');
  }
  for (const icon of [appInfo.icon, appInfo.largeIcon].filter(Boolean)) {
    if (typeof icon !== 'string' || !/^[A-Za-z0-9._-]+\.png$/i.test(icon) ||
        !files.some(file => file.path === icon)) {
      throw new Error('Staged package is missing an app icon.');
    }
  }
}

function contentFor(sourceRoot, stagingDir, artifactPath) {
  const source = sourceIdentity(sourceRoot);
  const stagingRoot = assertRealDirectory(stagingDir, 'Staging root');
  const files = stageFiles(stagingRoot);
  assertStagedAppInfo(stagingRoot, source, files);
  if (path.extname(artifactPath).toLowerCase() !== '.ipk') {
    throw new Error('Final package artifact must be an IPK file.');
  }
  const artifact = assertRealFile(artifactPath, 'IPK artifact');
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: PROJECT_ID,
    source,
    staging: { root: stagingRoot, files },
    artifact: { path: artifact.path, size: artifact.size, sha256: sha256File(artifact.path) }
  };
}

function digestFor(content) {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function createArtifactManifest({ sourceRoot, stagingDir, artifactPath, manifestPath = `${artifactPath}.manifest.json` }) {
  const content = contentFor(sourceRoot, stagingDir, artifactPath);
  const destination = path.resolve(manifestPath);
  if (inside(content.staging.root, destination) || destination === content.staging.root) {
    throw new Error('Manifest must be outside the staged package.');
  }
  if (fs.existsSync(destination)) {
    throw new Error('Manifest destination already exists.');
  }
  assertNoLinkedPathComponents(path.dirname(destination), 'Manifest destination');
  const manifest = { ...content, digest: digestFor(content) };
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}

function assertManifestShape(manifest) {
  if (!hasOnlyKeys(manifest, ['schemaVersion', 'projectId', 'source', 'staging', 'artifact', 'digest']) ||
      manifest.schemaVersion !== SCHEMA_VERSION || manifest.projectId !== PROJECT_ID ||
      !hasOnlyKeys(manifest.source, ['root', 'head', 'version']) ||
      !hasOnlyKeys(manifest.staging, ['root', 'files']) ||
      !Array.isArray(manifest.staging.files) ||
      !manifest.staging.files.every(file => hasOnlyKeys(file, ['path', 'size', 'sha256'])) ||
      !hasOnlyKeys(manifest.artifact, ['path', 'size', 'sha256']) ||
      typeof manifest.digest !== 'string') {
    throw new Error('Artifact manifest has an invalid schema.');
  }
}

function verifyArtifactManifest(manifestPath, expected = {}) {
  const file = assertRealFile(manifestPath, 'Artifact manifest');
  const manifest = JSON.parse(fs.readFileSync(file.path, 'utf8'));
  assertManifestShape(manifest);
  const { digest, ...content } = manifest;
  if (digest !== digestFor(content)) {
    throw new Error('Artifact manifest digest mismatch.');
  }
  if (expected.sourceRoot && sourceIdentity(expected.sourceRoot).root !== manifest.source.root) {
    throw new Error('Artifact manifest source root mismatch.');
  }
  if (expected.sourceCommit && manifest.source.head !== expected.sourceCommit) {
    throw new Error('Artifact manifest source commit mismatch.');
  }
  if (expected.sourceVersion && manifest.source.version !== expected.sourceVersion) {
    throw new Error('Artifact manifest source version mismatch.');
  }
  if (expected.artifactPath && assertRealFile(expected.artifactPath, 'Expected IPK').path !== manifest.artifact.path) {
    throw new Error('Artifact manifest IPK path mismatch.');
  }
  const actual = contentFor(manifest.source.root, manifest.staging.root, manifest.artifact.path);
  if (JSON.stringify(actual) !== JSON.stringify(content)) {
    throw new Error('Artifact manifest differs from source, staged files, or IPK bytes.');
  }
  return manifest;
}

module.exports = { createArtifactManifest, verifyArtifactManifest };
