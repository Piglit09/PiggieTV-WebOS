import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fixtureRoots: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ptv-manifest-'));
  fixtureRoots.push(root);
  const sourceRoot = join(root, 'source');
  const stagingDir = join(root, 'staging');
  const artifactPath = join(root, 'package.ipk');
  mkdirSync(sourceRoot);
  mkdirSync(join(stagingDir, 'assets'), { recursive: true });
  writeFileSync(join(sourceRoot, 'appinfo.json'), JSON.stringify({
    id: 'com.piggietv.webosnative', version: '0.1.19', icon: 'icon.png'
  }));
  writeFileSync(join(sourceRoot, 'package.json'), '{"version":"0.1.19"}');
  execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot });
  execFileSync('git', ['add', 'appinfo.json', 'package.json'], { cwd: sourceRoot });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: sourceRoot });
  copyFileSync(join(sourceRoot, 'appinfo.json'), join(stagingDir, 'appinfo.json'));
  writeFileSync(join(stagingDir, 'icon.png'), 'icon bytes');
  writeFileSync(join(stagingDir, 'index.html'), '<!doctype html>');
  writeFileSync(join(stagingDir, 'assets', 'main.js'), 'console.log("fixture")');
  writeFileSync(artifactPath, 'fixture IPK bytes');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  return { root, sourceRoot, stagingDir, artifactPath, manifestPath: `${artifactPath}.manifest.json`, sourceCommit };
}

function helper() {
  return require('../scripts/ptv-artifact-manifest.cjs') as {
    createArtifactManifest: (input: { sourceRoot: string; stagingDir: string; artifactPath: string; manifestPath?: string }) => Record<string, any>;
    verifyArtifactManifest: (manifestPath: string, expected?: { artifactPath?: string; sourceRoot?: string; sourceCommit?: string; sourceVersion?: string }) => Record<string, any>;
  };
}

function resignManifest(manifestPath: string, change: (manifest: Record<string, any>) => void) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  change(manifest);
  const payload = { ...manifest };
  delete payload.digest;
  manifest.digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    const expectedParent = realpathSync(tmpdir());
    if (dirname(resolve(root)) !== expectedParent || !basename(root).startsWith('ptv-manifest-')) {
      throw new Error(`Refusing to remove an unexpected fixture path: ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('webOS complete package manifest', () => {
  it('records every staged file in stable order and verifies the final IPK and source identity', () => {
    const fixture = makeFixture();
    const manifest = helper().createArtifactManifest(fixture);
    expect(manifest.projectId).toBe('PTV_WEBOS');
    expect(manifest.source.head).toBe(fixture.sourceCommit);
    expect(manifest.source.version).toBe('0.1.19');
    expect(manifest.staging.files.map((entry: { path: string }) => entry.path)).toEqual([
      'appinfo.json', 'assets/main.js', 'icon.png', 'index.html'
    ]);
    expect(manifest.artifact.sha256).toBe(createHash('sha256').update('fixture IPK bytes').digest('hex'));
    expect(helper().verifyArtifactManifest(fixture.manifestPath, {
      artifactPath: fixture.artifactPath,
      sourceRoot: fixture.sourceRoot,
      sourceCommit: fixture.sourceCommit,
      sourceVersion: '0.1.19'
    })).toEqual(manifest);
  });

  it('uses the same manifest digest for identical package evidence', () => {
    const fixture = makeFixture();
    const first = helper().createArtifactManifest(fixture);
    const second = helper().createArtifactManifest({
      ...fixture,
      manifestPath: join(fixture.root, 'second.manifest.json')
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
  });

  it('refuses to attest an IPK to a commit when the source tree has changed', () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.sourceRoot, 'package.json'), '{"version":"0.1.19","uncommitted":true}');
    expect(() => helper().createArtifactManifest(fixture)).toThrow(/clean|dirty|uncommitted/i);
  });

  it('ignores inherited Git repository overrides when recording source HEAD', () => {
    const fixture = makeFixture();
    const shadowRoot = join(fixture.root, 'shadow');
    mkdirSync(shadowRoot);
    copyFileSync(join(fixture.sourceRoot, 'appinfo.json'), join(shadowRoot, 'appinfo.json'));
    copyFileSync(join(fixture.sourceRoot, 'package.json'), join(shadowRoot, 'package.json'));
    execFileSync('git', ['init', '--quiet'], { cwd: shadowRoot });
    execFileSync('git', ['add', 'appinfo.json', 'package.json'], { cwd: shadowRoot });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'shadow history'], { cwd: shadowRoot });
    const shadowCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: shadowRoot, encoding: 'utf8' }).trim();
    expect(shadowCommit).not.toBe(fixture.sourceCommit);

    const child = spawnSync(process.execPath, [
      '-e',
      'const helper = require(process.argv[1]); const manifest = helper.createArtifactManifest(JSON.parse(process.argv[2])); process.stdout.write(manifest.source.head);',
      require.resolve('../scripts/ptv-artifact-manifest.cjs'),
      JSON.stringify(fixture)
    ], {
      cwd: fixture.sourceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: join(shadowRoot, '.git'),
        GIT_WORK_TREE: fixture.sourceRoot,
        GIT_COMMON_DIR: join(shadowRoot, '.git'),
        GIT_INDEX_FILE: join(shadowRoot, '.git', 'index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: shadowRoot,
        GIT_CONFIG_PARAMETERS: "'core.worktree=/spoofed'",
        GIT_OBJECT_DIRECTORY: join(shadowRoot, '.git', 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(fixture.sourceRoot, '.git', 'objects')
      }
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(fixture.sourceCommit);
  });

  it.each([
    ['modified staged file', (fixture: ReturnType<typeof makeFixture>) => writeFileSync(join(fixture.stagingDir, 'assets', 'main.js'), 'different code')],
    ['missing staged file', (fixture: ReturnType<typeof makeFixture>) => rmSync(join(fixture.stagingDir, 'assets', 'main.js'))],
    ['additional staged file', (fixture: ReturnType<typeof makeFixture>) => writeFileSync(join(fixture.stagingDir, 'extra.js'), 'extra')],
    ['modified IPK', (fixture: ReturnType<typeof makeFixture>) => writeFileSync(fixture.artifactPath, 'tampered package')],
    ['missing IPK', (fixture: ReturnType<typeof makeFixture>) => rmSync(fixture.artifactPath)]
  ])('rejects a %s after the manifest is recorded', (_label, mutate) => {
    const fixture = makeFixture();
    helper().createArtifactManifest(fixture);
    mutate(fixture);
    expect(() => helper().verifyArtifactManifest(fixture.manifestPath)).toThrow();
  });

  it('rejects a changed manifest digest', () => {
    const fixture = makeFixture();
    helper().createArtifactManifest(fixture);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.artifact.sha256 = '0'.repeat(64);
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
    expect(() => helper().verifyArtifactManifest(fixture.manifestPath)).toThrow(/digest/i);
  });

  it.each([
    ['source HEAD', (manifest: Record<string, any>) => { manifest.source.head = 'f'.repeat(40); }],
    ['source version', (manifest: Record<string, any>) => { manifest.source.version = '99.0.0'; }],
    ['file path escape', (manifest: Record<string, any>) => { manifest.staging.files[0].path = '../escape'; }]
  ])('rejects a resigned manifest with a forged %s', (_label, mutate) => {
    const fixture = makeFixture();
    helper().createArtifactManifest(fixture);
    resignManifest(fixture.manifestPath, mutate);
    expect(() => helper().verifyArtifactManifest(fixture.manifestPath)).toThrow();
  });

  it('rejects a linked file in the staging tree', () => {
    const fixture = makeFixture();
    const outside = join(fixture.root, 'outside.txt');
    writeFileSync(outside, 'outside');
    try {
      symlinkSync(outside, join(fixture.stagingDir, 'linked.txt'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(() => helper().createArtifactManifest(fixture)).toThrow(/link/i);
  });

  it('rejects a staging path whose parent is a junction', () => {
    const fixture = makeFixture();
    const alias = join(fixture.root, 'redirect');
    try {
      symlinkSync(fixture.root, alias, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(() => helper().createArtifactManifest({
      ...fixture,
      stagingDir: join(alias, 'staging')
    })).toThrow(/link|junction/i);
  });

  it('rejects an unpinned source commit or IPK path', () => {
    const fixture = makeFixture();
    helper().createArtifactManifest(fixture);
    expect(() => helper().verifyArtifactManifest(fixture.manifestPath, {
      sourceCommit: 'f'.repeat(40)
    })).toThrow(/source commit/i);
    const otherIpk = join(fixture.root, 'other.ipk');
    writeFileSync(otherIpk, 'other');
    expect(() => helper().verifyArtifactManifest(fixture.manifestPath, {
      artifactPath: otherIpk
    })).toThrow(/IPK path/i);
  });

  it('refuses to identify a non-IPK file as the final package', () => {
    const fixture = makeFixture();
    const ordinaryFile = join(fixture.root, 'ordinary.txt');
    writeFileSync(ordinaryFile, 'ordinary bytes');
    expect(() => helper().createArtifactManifest({
      ...fixture,
      artifactPath: ordinaryFile
    })).toThrow(/IPK/i);
  });
});
