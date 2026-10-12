import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const guard = require('../scripts/ptv-workspace-preflight.cjs') as {
  assertWorkspaceAuthority: (mode: string, options: { cwd: string }) => {
    commit: string;
    dirty: boolean;
  };
};

it('embeds the guarded checkout commit despite forged ambient Git repository variables', () => {
  const shadowRoot = mkdtempSync(join(tmpdir(), 'ptv-vite-shadow-'));
  const previousDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  try {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: shadowRoot,
      encoding: 'utf8',
      env: { ...cleanEnv, GIT_OPTIONAL_LOCKS: '0' }
    }).trim();
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(shadowRoot, 'README.md'), 'forged repository\n');
    git('add', 'README.md');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'shadow');
    const shadowCommit = git('rev-parse', 'HEAD');

    process.env.GIT_DIR = join(shadowRoot, '.git');
    process.env.GIT_WORK_TREE = shadowRoot;
    const inspected = guard.assertWorkspaceAuthority('audit', { cwd: sourceRoot });
    expect(inspected.commit).not.toBe(shadowCommit);

    const embeddedCommit = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { loadConfigFromFile } from 'vite';
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        './vite.config.ts',
        process.cwd()
      );
      if (!loaded) throw new Error('Vite configuration was not loaded.');
      process.stdout.write(loaded.config.define['import.meta.env.VITE_PTV_COMMIT']);
    `], { cwd: sourceRoot, env: process.env, encoding: 'utf8' });
    expect(JSON.parse(embeddedCommit))
      .toBe(`${inspected.commit}${inspected.dirty ? '-dirty' : ''}`);
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
    rmSync(shadowRoot, { recursive: true, force: true });
  }
});
