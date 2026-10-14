#!/usr/bin/env node

// Vite writes this after the final bundle output. Package verification rehashes
// the entire ignored build directory and compares it with current committed source.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'PTV_WEBOS';
const APP_ID = 'com.piggietv.webosnative';
const MANIFEST_NAME = 'ptv-build-manifest.json';
const SCHEMA_VERSION = 1;

function hashFile(file) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function realPathWithoutLinks(value, label) {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} contains a link or junction.`);
    }
  }
  return fs.realpathSync.native(absolute);
}

function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function sourceIdentity(sourceRoot) {
  const root = realPathWithoutLinks(sourceRoot, 'Source root');
  if (!fs.statSync(root).isDirectory()) throw new Error('Source root must be a directory.');
  if (realPathWithoutLinks(git(root, 'rev-parse', '--show-toplevel'), 'Git root') !== root) {
    throw new Error('Source root differs from the exact Git checkout root.');
  }
  const head = git(root, 'rev-parse', '--verify', 'HEAD');
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('Source commit must be a full Git object ID.');
  const dirty = git(root, 'status', '--porcelain=v1', '--untracked-files=all') !== '';
  const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
  if (appInfo.id !== APP_ID || typeof appInfo.version !== 'string' || !/^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(appInfo.version)) {
    throw new Error('Official appinfo.json identity or version is invalid.');
  }
  return { root, head, version: appInfo.version, dirty };
}

function buildFiles(buildRoot) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Build contains a link: ${name}`);
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        const relative = path.relative(buildRoot, file).split(path.sep).join('/');
        if (relative !== MANIFEST_NAME) {
          files.push({ path: relative, size: stat.size, sha256: hashFile(file) });
        }
      } else {
        throw new Error(`Build contains a non-file entry: ${name}`);
      }
    }
  }
  visit(buildRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!files.some(file => file.path === 'index.html') || !files.some(file => file.path.startsWith('assets/'))) {
    throw new Error('Build is missing index.html or generated assets.');
  }
  return files;
}

function contentFor({ sourceRoot, buildDir }) {
  const source = sourceIdentity(sourceRoot);
  const expectedBuildRoot = path.join(source.root, 'build');
  try {
    git(source.root, 'check-ignore', '--', `build/${MANIFEST_NAME}`);
  } catch {
    throw new Error('Build output must be ignored by Git before writing generated provenance.');
  }
  if (buildDir && path.resolve(buildDir) !== expectedBuildRoot) {
    throw new Error('Build directory must be the checkout build/ directory.');
  }
  const buildRoot = realPathWithoutLinks(expectedBuildRoot, 'Build directory');
  if (buildRoot !== expectedBuildRoot || !fs.statSync(buildRoot).isDirectory()) {
    throw new Error('Build directory must be a real directory inside the checkout.');
  }
  const files = buildFiles(buildRoot);
  if (JSON.stringify(sourceIdentity(source.root)) !== JSON.stringify(source)) {
    throw new Error('Source identity changed during build hashing.');
  }
  return { schemaVersion: SCHEMA_VERSION, projectId: PROJECT_ID, source, build: { root: buildRoot, files } };
}

function digestFor(content) {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function manifestFile(content) {
  return path.join(content.build.root, MANIFEST_NAME);
}

function createBuildManifest(options) {
  const content = contentFor(options);
  const manifest = { ...content, digest: digestFor(content) };
  fs.writeFileSync(manifestFile(content), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyBuildManifest({ sourceRoot: content.source.root, buildDir: content.build.root });
  return manifest;
}

function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function validateShape(manifest) {
  if (!sameKeys(manifest, ['schemaVersion', 'projectId', 'source', 'build', 'digest']) ||
      manifest.schemaVersion !== SCHEMA_VERSION || manifest.projectId !== PROJECT_ID ||
      !sameKeys(manifest.source, ['root', 'head', 'version', 'dirty']) ||
      !sameKeys(manifest.build, ['root', 'files']) || !Array.isArray(manifest.build.files) ||
      !manifest.build.files.every(file => sameKeys(file, ['path', 'size', 'sha256'])) ||
      typeof manifest.digest !== 'string') {
    throw new Error('Build manifest schema is invalid.');
  }
}

function verifyBuildManifest(options) {
  const sourceRoot = realPathWithoutLinks(options.sourceRoot, 'Source root');
  const buildRoot = realPathWithoutLinks(path.join(sourceRoot, 'build'), 'Build directory');
  const file = path.join(buildRoot, MANIFEST_NAME);
  if (realPathWithoutLinks(file, 'Build manifest') !== file || !fs.statSync(file).isFile()) {
    throw new Error('Build manifest must be a regular file in build/.');
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateShape(manifest);
  const { digest, ...content } = manifest;
  if (digest !== digestFor(content)) throw new Error('Build manifest digest mismatch.');
  if (options.requireClean && manifest.source.dirty) {
    throw new Error('Release packaging requires a clean source build.');
  }
  const actual = contentFor({ sourceRoot, buildDir: options.buildDir });
  if (options.requireClean && actual.source.dirty) {
    throw new Error('Release packaging requires a clean current source tree.');
  }
  if (JSON.stringify(actual) !== JSON.stringify(content)) {
    throw new Error('Build manifest differs from current source commit, version, or build files.');
  }
  return manifest;
}

module.exports = { createBuildManifest, verifyBuildManifest };
