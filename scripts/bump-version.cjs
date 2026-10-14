const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const paths = {
  appInfo: path.join(root, 'appinfo.json'),
  packageJson: path.join(root, 'package.json'),
  packageLock: path.join(root, 'package-lock.json')
};

function parseVersion(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(value);
  if (!match) {
    throw new Error(`Version must use major.minor.patch with fields from 0 through 99: ${value}`);
  }

  return match.slice(1).map(Number);
}

function nextVersion(value) {
  const [major, minor, patch] = parseVersion(value);

  if (patch < 99) return `${major}.${minor}.${patch + 1}`;
  if (minor < 99) return `${major}.${minor + 1}.0`;

  throw new Error(
    `Automatic major-version rollover is disabled at ${major}.99.99. Set the next major release explicitly.`
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readVersionState() {
  const appInfo = readJson(paths.appInfo);
  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const authoritativeVersion = appInfo.version;
  const lockRoot = packageLock.packages?.[''];

  parseVersion(authoritativeVersion);
  if (packageJson.version !== authoritativeVersion
      || packageLock.version !== authoritativeVersion
      || lockRoot?.version !== authoritativeVersion) {
    throw new Error(
      `Version metadata is out of sync. appinfo=${authoritativeVersion}, package=${packageJson.version}, lock=${packageLock.version}, lockRoot=${lockRoot?.version}`
    );
  }

  return { appInfo, packageJson, packageLock, authoritativeVersion, lockRoot };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function bumpVersion() {
  const state = readVersionState();
  const version = nextVersion(state.authoritativeVersion);

  state.appInfo.version = version;
  state.packageJson.version = version;
  state.packageLock.version = version;
  state.lockRoot.version = version;

  writeJson(paths.appInfo, state.appInfo);
  writeJson(paths.packageJson, state.packageJson);
  writeJson(paths.packageLock, state.packageLock);
  return version;
}

function selfTest() {
  assert.equal(nextVersion('0.0.0'), '0.0.1');
  assert.equal(nextVersion('0.0.98'), '0.0.99');
  assert.equal(nextVersion('0.0.99'), '0.1.0');
  assert.equal(nextVersion('3.98.99'), '3.99.0');
  assert.throws(() => nextVersion('0.99.99'), /major-version rollover is disabled/);
  assert.throws(() => nextVersion('1.2.991'), /major\.minor\.patch/);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--self-test')) {
      selfTest();
      console.log('Version boundary checks passed.');
    } else if (process.argv.includes('--check')) {
      const state = readVersionState();
      console.log(`Version metadata is synchronized at ${state.authoritativeVersion}.`);
    } else {
      require('./ptv-workspace-preflight.cjs').assertWorkspaceAuthority('edit', { cwd: root });
      console.log(bumpVersion());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { nextVersion };
