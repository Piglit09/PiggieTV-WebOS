import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fixtureRoots: string[] = [];

type BuildManifest = {
  projectId: string;
  source: { root: string; head: string; version: string; dirty: boolean };
  build: { root: string; files: Array<{ path: string; size: number; sha256: string }> };
  digest: string;
};

function helper() {
  return require('../scripts/ptv-build-manifest.cjs') as {
    createBuildManifest: (options: { sourceRoot: string; buildDir?: string }) => BuildManifest;
    verifyBuildManifest: (options: { sourceRoot: string; buildDir?: string; requireClean?: boolean }) => BuildManifest;
  };
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ptv-build-manifest-'));
  fixtureRoots.push(root);
  const buildDir = join(root, 'build');
  mkdirSync(join(buildDir, 'assets'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  writeFileSync(join(root, 'appinfo.json'), JSON.stringify({ id: 'com.piggietv.webosnative', version: '0.1.19' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.19' }));
  git(root, 'init', '--quiet');
  git(root, 'add', '.gitignore', 'appinfo.json', 'package.json');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'source');
  writeFileSync(join(buildDir, 'index.html'), '<!doctype html><script src="./assets/main.js"></script>');
  writeFileSync(join(buildDir, 'assets', 'main.js'), 'console.log("fixture");');
  writeFileSync(join(buildDir, 'assets', 'main.css'), 'body{color:purple}');
  return { root, buildDir, head: git(root, 'rev-parse', 'HEAD'), manifestPath: join(buildDir, 'ptv-build-manifest.json') };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    if (dirname(resolve(root)) !== realpathSync(tmpdir()) || !basename(root).startsWith('ptv-build-manifest-')) {
      throw new Error(`Refusing to remove an unexpected fixture path: ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('webOS build provenance', () => {
  it('registers a Vite build-completion hook that writes provenance after bundling', async () => {
    const inspected = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { loadConfigFromFile } from 'vite';
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, './vite.config.ts', process.cwd());
      if (!loaded) throw new Error('Vite configuration was not loaded.');
      process.stdout.write(JSON.stringify(loaded.config.plugins.map(plugin => ({
        name: plugin.name, apply: plugin.apply, closeBundle: typeof plugin.closeBundle
      }))));
    `], { cwd: resolve(process.cwd()), encoding: 'utf8' });
    const plugins = JSON.parse(inspected) as Array<{ name?: string; apply?: string; closeBundle?: string }>;
    expect(plugins.some(plugin => plugin.name === 'ptv-build-provenance' &&
      plugin.apply === 'build' && plugin.closeBundle === 'function')).toBe(true);
  });

  it('records every generated file except its own manifest and the exact clean source', () => {
    const data = fixture();
    const manifest = helper().createBuildManifest({ sourceRoot: data.root });
    expect(existsSync(data.manifestPath)).toBe(true);
    expect(manifest.projectId).toBe('PTV_WEBOS');
    expect(manifest.source).toMatchObject({ head: data.head, version: '0.1.19', dirty: false });
    expect(manifest.build.files.map(file => file.path)).toEqual(['assets/main.css', 'assets/main.js', 'index.html']);
    expect(manifest.build.files[1]?.sha256).toBe(createHash('sha256').update('console.log("fixture");').digest('hex'));
    expect(helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toEqual(manifest);
  });

  it('rejects a build from the previous commit after HEAD advances', () => {
    const data = fixture();
    helper().createBuildManifest({ sourceRoot: data.root });
    writeFileSync(join(data.root, 'package.json'), JSON.stringify({ version: '0.1.19', note: 'new source commit' }));
    git(data.root, 'add', 'package.json');
    git(data.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'advance source');
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/commit|HEAD|source/i);
  });

  it.each([
    ['modified asset', (data: ReturnType<typeof fixture>) => writeFileSync(join(data.buildDir, 'assets', 'main.js'), 'tampered')],
    ['new asset', (data: ReturnType<typeof fixture>) => writeFileSync(join(data.buildDir, 'assets', 'extra.js'), 'new')],
    ['removed asset', (data: ReturnType<typeof fixture>) => rmSync(join(data.buildDir, 'assets', 'main.css'))]
  ])('rejects a %s after the build manifest was generated', (_name, mutate) => {
    const data = fixture();
    helper().createBuildManifest({ sourceRoot: data.root });
    mutate(data);
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/build|file|hash|manifest/i);
  });

  it('records a dirty local build but refuses to certify it for release packaging', () => {
    const data = fixture();
    writeFileSync(join(data.root, 'package.json'), JSON.stringify({ version: '0.1.19', dirty: true }));
    const manifest = helper().createBuildManifest({ sourceRoot: data.root });
    expect(manifest.source.dirty).toBe(true);
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/clean|dirty/i);
  });

  it('refuses to write generated provenance when build output is not ignored', () => {
    const data = fixture();
    writeFileSync(join(data.root, '.gitignore'), '');
    git(data.root, 'add', '.gitignore');
    git(data.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'stop ignoring build');
    expect(() => helper().createBuildManifest({ sourceRoot: data.root })).toThrow(/ignored/i);
    expect(existsSync(data.manifestPath)).toBe(false);
  });

  it('rejects changed source bytes even when HEAD is unchanged', () => {
    const data = fixture();
    helper().createBuildManifest({ sourceRoot: data.root });
    writeFileSync(join(data.root, 'package.json'), JSON.stringify({ version: '0.1.19', dirty: true }));
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/clean|dirty/i);
  });

  it('rejects official app version changes after the build', () => {
    const data = fixture();
    helper().createBuildManifest({ sourceRoot: data.root });
    writeFileSync(join(data.root, 'appinfo.json'), JSON.stringify({ id: 'com.piggietv.webosnative', version: '0.1.20' }));
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/version|clean|dirty/i);
  });

  it('rejects a changed manifest digest', () => {
    const data = fixture();
    helper().createBuildManifest({ sourceRoot: data.root });
    const manifest = JSON.parse(readFileSync(data.manifestPath, 'utf8'));
    manifest.source.head = 'f'.repeat(40);
    writeFileSync(data.manifestPath, JSON.stringify(manifest));
    expect(() => helper().verifyBuildManifest({ sourceRoot: data.root, requireClean: true })).toThrow(/digest/i);
  });
});
