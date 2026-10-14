import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Guard = {
  assertWorkspaceAuthority: (mode: string, options?: Record<string, unknown>) => unknown;
  validateWorkspaceAuthority: (mode: string, options: Record<string, unknown>, policy: Record<string, any> | null, deviceConfig?: { path: string; devices: Record<string, unknown>[] } | null, packageSdkScript?: string | null, inventorySdkScript?: string | null) => Record<string, any>;
  cliOptions: (args: string[]) => { mode: string; options: Record<string, unknown> };
  protectedPolicyRegistryKeys: () => string[];
  assertRegistryAclProtection: (keys: string[]) => void;
};
const guard = () => require('../scripts/ptv-workspace-preflight.cjs') as Guard;

let fixtureParent: string;
let root: string;
let policy: Record<string, any>;
let commit: string;

function approvedDeviceConfig() {
  return {
    path: join(fixtureParent, 'novacom-devices.json'),
    devices: [{
      name: 'fixture-tv', host: '10.0.0.44', port: 9922,
      username: 'prisoner', profile: 'tv'
    }]
  };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  }).trim();
}

function createRepo(location: string) {
  mkdirSync(location, { recursive: true });
  git(location, 'init', '-q');
  git(location, 'config', 'core.autocrlf', 'false');
  git(location, 'config', 'user.name', 'Fixture');
  git(location, 'config', 'user.email', 'fixture@example.invalid');
  git(location, 'remote', 'add', 'origin', 'https://example.invalid/ptv-webos.git');
  writeFileSync(join(location, '.gitignore'), 'dist/\n');
  writeFileSync(join(location, 'appinfo.json'), JSON.stringify({ id: 'com.piggietv.webosnative', version: '0.1.19' }));
  writeFileSync(join(location, 'package.json'), JSON.stringify({ name: 'ptv-webos-native', version: '0.1.19' }));
  writeFileSync(join(location, 'package-lock.json'), JSON.stringify({ version: '0.1.19', packages: { '': { version: '0.1.19' } } }));
  writeFileSync(join(location, 'README.md'), 'fixture source\n');
  git(location, 'add', '.');
  git(location, 'commit', '-qm', 'fixture');
}

function stageArtifact() {
  const artifactDir = join(root, 'dist', 'pkgs');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, 'com.piggietv.webosnative_0.1.19_all.ipk');
  writeFileSync(artifactPath, 'fixture ipk bytes\n');
  const artifactSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  const rollbackPath = join(fixtureParent, 'previous-release.ipk');
  writeFileSync(rollbackPath, 'verified rollback bytes\n');
  policy.rollbackEvidence = {
    'verified-backup-1': {
      artifactPath: rollbackPath,
      sha256: createHash('sha256').update(readFileSync(rollbackPath)).digest('hex')
    }
  };
  const stagingDir = join(root, 'dist', 'staging');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'appinfo.json'), readFileSync(join(root, 'appinfo.json')));
  writeFileSync(join(stagingDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const manifestPath = join(artifactDir, 'manifest.json');
  const artifactManifest = require('../scripts/ptv-artifact-manifest.cjs') as {
    createArtifactManifest: (options: Record<string, string>) => unknown;
  };
  artifactManifest.createArtifactManifest({ sourceRoot: root, stagingDir, artifactPath, manifestPath });
  writeFileSync(join(fixtureParent, 'novacom-devices.json'), JSON.stringify(approvedDeviceConfig().devices));
  policy.targets['fixture-tv'] = {
    approved: true,
    operations: ['install', 'inspect'],
    deviceConfigPath: join(fixtureParent, 'novacom-devices.json'),
    endpoint: { host: '10.0.0.44', port: 9922, user: 'prisoner', profile: 'tv' },
    approvals: {
      'approved-task': {
        targetId: 'fixture-tv', operation: 'install',
        sourceCommit: commit, artifactSha256, rollbackReference: 'verified-backup-1'
      }
    }
  };
  return { artifactPath, artifactSha256, manifestPath };
}

function deployOptions(artifactPath: string, manifestPath: string) {
  return {
    cwd: root, artifactPath, manifestPath,
    targetId: 'fixture-tv', operation: 'install', approvalId: 'approved-task',
    rollbackReference: 'verified-backup-1'
  };
}

function plannedPackageOptions() {
  return {
    cwd: root,
    plannedStagingDir: join(root, 'dist', '.ptv-webos-package'),
    plannedOutputDir: join(root, 'dist', 'pkgs')
  };
}

function approvedPackageSdkScript() {
  return join(fixtureParent, 'sdk-cli', 'ares-package.ps1');
}

function approvedInventorySdkScript() {
  return join(fixtureParent, 'sdk-cli', 'ares-setup-device.ps1');
}

beforeEach(() => {
  fixtureParent = mkdtempSync(join(tmpdir(), 'ptv-webos-authority-'));
  root = join(fixtureParent, 'source');
  createRepo(root);
  root = realpathSync(root);
  commit = git(root, 'rev-parse', 'HEAD');
  policy = {
    projectId: 'PTV_WEBOS',
    sourceRoot: root,
    gitCommonDir: realpathSync(join(root, '.git')),
    remote: 'https://example.invalid/ptv-webos.git',
    appId: 'com.piggietv.webosnative',
    versionSource: 'appinfo.json',
    artifactRoots: [join(root, 'dist')],
    sdkCliDirectory: join(fixtureParent, 'sdk-cli'),
    targets: {}
  };
  mkdirSync(policy.sdkCliDirectory);
  writeFileSync(approvedPackageSdkScript(), 'approved fixture SDK script\n');
  writeFileSync(approvedInventorySdkScript(), 'approved inventory SDK script\n');
});

afterEach(() => {
  rmSync(fixtureParent, { recursive: true, force: true });
});

describe('webOS workspace authority', () => {
  it('infers only fixed package output paths for a bare CLI package preflight', () => {
    expect(guard().cliOptions(['package']).options).toMatchObject({
      plannedStagingDir: join(process.cwd(), 'dist', '.ptv-webos-package'),
      plannedOutputDir: join(process.cwd(), 'dist', 'pkgs')
    });
  });

  it('protects the policy key and its parent registry path from task writes', () => {
    expect(guard().protectedPolicyRegistryKeys()).toContain('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\PiggieTV');
    expect(guard().protectedPolicyRegistryKeys()).toContain('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\PiggieTV\\WorkspaceAuthority');
  });

  it('accepts the approved repository and nested source directory for local builds', () => {
    mkdirSync(join(root, 'src'));
    expect(guard().validateWorkspaceAuthority('build', { cwd: join(root, 'src') }, policy)).toMatchObject({
      projectId: 'PTV_WEBOS', root, commit, version: '0.1.19'
    });
  });

  it('allows read-only historical audit without an approved writable root', () => {
    expect(guard().validateWorkspaceAuthority('audit', { cwd: root }, null)).toMatchObject({ root, commit });
  });

  it('allows a read-only audit of an orphan historical Git snapshot with no remote', () => {
    git(root, 'remote', 'remove', 'origin');
    expect(guard().validateWorkspaceAuthority('audit', { cwd: root }, null)).toMatchObject({
      root, commit, remote: null
    });
  });

  it('rejects build when operator authority is absent', () => {
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, null)).toThrow(/authority|policy/i);
  });

  it('rejects a different source repository even if its app ID matches', () => {
    const other = join(fixtureParent, 'other');
    createRepo(other);
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: other }, policy)).toThrow(/root|checkout/i);
  });

  it('rejects an unauthorized linked worktree sharing the approved Git common directory', () => {
    const linked = join(fixtureParent, 'linked');
    git(root, 'worktree', 'add', '--detach', linked);
    expect(() => guard().validateWorkspaceAuthority('edit', { cwd: linked }, policy)).toThrow(/root|worktree/i);
  });

  it('rejects a nested unapproved repository even when ambient Git variables point at the approved one', () => {
    const rogue = join(root, 'rogue');
    createRepo(rogue);
    const previousDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(root, '.git');
    process.env.GIT_WORK_TREE = root;
    try {
      expect(() => guard().validateWorkspaceAuthority('build', { cwd: rogue }, policy)).toThrow(/root|worktree|checkout|directory/i);
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousDir;
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }
  });

  it('rejects a remote change', () => {
    git(root, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, policy)).toThrow(/remote/i);
  });

  it('rejects a changed remote despite ambient Git configuration spoofing', () => {
    git(root, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    const names = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url';
    process.env.GIT_CONFIG_VALUE_0 = policy.remote;
    try {
      expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, policy)).toThrow(/remote/i);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it('rejects an unexpected Git common directory', () => {
    policy.gitCommonDir = join(fixtureParent, 'unexpected');
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, policy)).toThrow(/common/i);
  });

  it('rejects a source-path symlink alias rather than accepting a path escape', () => {
    const alias = join(fixtureParent, 'alias');
    // Windows directory junctions work without Developer Mode.
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: alias }, policy)).toThrow(/symlink|alias|path/i);
  });

  it('rejects the wrong project or app identity', () => {
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, { ...policy, projectId: 'PTV_ANDROID_TV' })).toThrow(/project/i);
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, { ...policy, appId: 'com.other' })).toThrow(/app/i);
  });

  it('rejects a wrong official version source', () => {
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, { ...policy, versionSource: 'package.json' })).toThrow(/version source/i);
  });

  it('rejects version metadata that differs from appinfo.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ptv-webos-native', version: '0.1.20' }));
    expect(() => guard().validateWorkspaceAuthority('build', { cwd: root }, policy)).toThrow(/version/i);
  });

  it('permits dirty local builds but rejects dirty release packaging', () => {
    writeFileSync(join(root, 'README.md'), 'dirty\n');
    expect(guard().validateWorkspaceAuthority('build', { cwd: root }, policy)).toMatchObject({ root });
    expect(() => guard().validateWorkspaceAuthority('package', { cwd: root }, policy)).toThrow(/clean|dirty/i);
  });

  it('accepts clean package preflight with a committed source', () => {
    expect(guard().validateWorkspaceAuthority('package', plannedPackageOptions(), policy, null, approvedPackageSdkScript())).toMatchObject({
      commit, sdkCliDirectory: policy.sdkCliDirectory
    });
  });

  it('rejects a PATH-substituted package SDK script despite an approved source and output', () => {
    const rogueDir = join(fixtureParent, 'rogue-sdk');
    mkdirSync(rogueDir);
    const rogueScript = join(rogueDir, 'ares-package.ps1');
    writeFileSync(rogueScript, 'rogue fixture SDK script\n');
    expect(() => guard().validateWorkspaceAuthority('package', plannedPackageOptions(), policy, null, rogueScript)).toThrow(/SDK|CLI|package/i);
  });

  it('permits only the pinned local device inventory CLI from the approved source', () => {
    expect(guard().validateWorkspaceAuthority('inspect-sdk', { cwd: root }, policy, null, null, approvedInventorySdkScript())).toMatchObject({
      root, sdkCliDirectory: policy.sdkCliDirectory
    });
    const rogueDir = join(fixtureParent, 'rogue-inventory-sdk');
    mkdirSync(rogueDir);
    const rogue = join(rogueDir, 'ares-setup-device.ps1');
    writeFileSync(rogue, 'rogue inventory SDK script\n');
    expect(() => guard().validateWorkspaceAuthority('inspect-sdk', { cwd: root }, policy, null, null, rogue)).toThrow(/SDK|CLI|inventory/i);
    expect(() => guard().validateWorkspaceAuthority('inspect-sdk', { cwd: root }, null, null, null, approvedInventorySdkScript())).toThrow(/policy|authority/i);
  });

  it('rejects planned package deletion outside operator-approved artifact roots', () => {
    policy.artifactRoots = [join(root, 'dist', 'pkgs')];
    expect(() => guard().validateWorkspaceAuthority('package', plannedPackageOptions(), policy, null, approvedPackageSdkScript())).toThrow(/artifact|output|staging/i);
  });

  it('rejects a forged source commit in an artifact manifest', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.source.head = '0'.repeat(40);
    delete manifest.digest;
    manifest.digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy)).toThrow(/commit/i);
  });

  it('rejects tampered artifact bytes after manifest generation', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    writeFileSync(artifactPath, 'tampered ipk bytes\n');
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy)).toThrow(/SHA|hash|artifact/i);
  });

  it('rejects an unregistered deployment target and leaves source unchanged', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const sourceBefore = readFileSync(join(root, 'README.md'), 'utf8');
    const options = { ...deployOptions(artifactPath, manifestPath), targetId: 'unknown-tv' };
    expect(() => guard().validateWorkspaceAuthority('deploy', options, policy)).toThrow(/target/i);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(sourceBefore);
    expect(git(root, 'status', '--porcelain=v1')).toBe('');
  });

  it('rejects production and development targets without exact approval', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    policy.targets.production = { approved: false, operations: ['install'], approvals: {} };
    const options = { ...deployOptions(artifactPath, manifestPath), targetId: 'production' };
    expect(() => guard().validateWorkspaceAuthority('deploy', options, policy)).toThrow(/target|approval/i);
    const noApproval = { ...deployOptions(artifactPath, manifestPath), approvalId: 'other-task' };
    expect(() => guard().validateWorkspaceAuthority('deploy', noApproval, policy)).toThrow(/approval/i);
  });

  it('rejects missing rollback evidence or unauthorized operation', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    expect(() => guard().validateWorkspaceAuthority('deploy', {
      ...deployOptions(artifactPath, manifestPath), rollbackReference: ''
    }, policy)).toThrow(/rollback/i);
    expect(() => guard().validateWorkspaceAuthority('deploy', {
      ...deployOptions(artifactPath, manifestPath), operation: 'remove'
    }, policy)).toThrow(/operation/i);
  });

  it('rejects a tampered operator-pinned rollback artifact before device contact', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    writeFileSync(policy.rollbackEvidence['verified-backup-1'].artifactPath, 'tampered rollback bytes\n');
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, approvedDeviceConfig())).toThrow(/rollback|SHA|hash/i);
    delete policy.rollbackEvidence['verified-backup-1'];
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, approvedDeviceConfig())).toThrow(/rollback|evidence/i);
  });

  it('rejects an artifact path outside approved output roots', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const outside = join(fixtureParent, 'outside.ipk');
    writeFileSync(outside, readFileSync(artifactPath));
    expect(() => guard().validateWorkspaceAuthority('deploy', {
      ...deployOptions(artifactPath, manifestPath), artifactPath: outside
    }, policy)).toThrow(/artifact.*root|artifact.*path/i);
  });

  it('accepts an exact approved fixture deployment without contacting any device', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    expect(guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, approvedDeviceConfig())).toMatchObject({
      root, commit, targetId: 'fixture-tv', artifactPath
    });
  });

  it('rejects a device alias rebound to a different endpoint', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const config = approvedDeviceConfig();
    config.devices[0].host = '10.0.0.99';
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, config)).toThrow(/endpoint|device|alias/i);
  });

  it('allows read-only inspection of an approved bound target and rejects a rebound alias', () => {
    stageArtifact();
    const options = { cwd: root, targetId: 'fixture-tv' };
    expect(guard().validateWorkspaceAuthority('inspect-device', options, policy, approvedDeviceConfig())).toMatchObject({
      root, targetId: 'fixture-tv'
    });
    const rebound = approvedDeviceConfig();
    rebound.devices[0].host = '10.0.0.99';
    expect(() => guard().validateWorkspaceAuthority('inspect-device', options, policy, rebound)).toThrow(/endpoint|alias/i);
  });

  it('rejects missing or ambiguous alias configuration', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const config = approvedDeviceConfig();
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, { ...config, devices: [] })).toThrow(/alias|device/i);
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, { ...config, devices: [...config.devices, config.devices[0]] })).toThrow(/alias|device/i);
  });

  it('rejects a device configuration file outside the operator-pinned path', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    const config = approvedDeviceConfig();
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, { ...config, path: join(root, 'different-devices.json') })).toThrow(/config|path/i);
  });

  it('rejects approval reuse for a different operation or target', () => {
    const { artifactPath, manifestPath } = stageArtifact();
    policy.targets['fixture-tv'].operations.push('remove');
    expect(() => guard().validateWorkspaceAuthority('deploy', {
      ...deployOptions(artifactPath, manifestPath), operation: 'remove'
    }, policy, approvedDeviceConfig())).toThrow(/approval|operation/i);
    policy.targets['fixture-tv'].approvals['approved-task'].operation = 'install';
    policy.targets['fixture-tv'].approvals['approved-task'].targetId = 'different-tv';
    expect(() => guard().validateWorkspaceAuthority('deploy', deployOptions(artifactPath, manifestPath), policy, approvedDeviceConfig())).toThrow(/approval|target/i);
  });

  it('rejects attempts to inject an authority policy into the production interface', () => {
    expect(() => guard().assertWorkspaceAuthority('build', { cwd: root, policy })).toThrow(/override|policy/i);
  });

  it.runIf(process.platform === 'win32')('reads protected machine ancestors but rejects a writable user registry key', () => {
    expect(() => guard().assertRegistryAclProtection([
      'Registry::HKEY_LOCAL_MACHINE',
      'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE'
    ])).not.toThrow();
    expect(() => guard().assertRegistryAclProtection([
      'Registry::HKEY_CURRENT_USER\\Software'
    ])).toThrow(/writable|owned/i);
  });
});
