import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceScripts = resolve(process.cwd(), 'scripts');

function withDeniedScript(scriptName: string, action: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ptv-webos-denied-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  copyFileSync(join(sourceScripts, scriptName), join(scripts, scriptName));
  writeFileSync(join(scripts, 'ptv-workspace-preflight.cjs'),
    `exports.assertWorkspaceAuthority = () => {
      require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'authority-denied-marker'), 'checked');
      throw new Error('fixture authority denied');
    };\n`);
  writeFileSync(join(scripts, 'webos-common.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    exports.readAppInfo = () => ({ id: 'com.piggietv.webosnative', version: '0.1.19', icon: 'icon.png', largeIcon: 'icon.png' });
    exports.requireDeviceAlias = () => 'fixture-tv';
    exports.requireHostIp = () => '127.0.0.1';
    exports.readCliOption = () => null;
    exports.copyValidatedBuildAssets = () => [];
    exports.runWebOsCli = (command, args) => fs.writeFileSync(path.join(process.cwd(), 'device-contacted'), JSON.stringify({ command, args }));
  `);
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('webOS mutation entrypoints', () => {
  it.each(['webos-launch.cjs', 'webos-remove.cjs'])(
    'denies %s before contacting a device', scriptName => {
      withDeniedScript(scriptName, root => {
        const result = spawnSync(process.execPath, [join(root, 'scripts', scriptName), '--device', 'fixture-tv'], {
          cwd: root, encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('fixture authority denied');
        expect(existsSync(join(root, 'authority-denied-marker'))).toBe(true);
        expect(existsSync(join(root, 'device-contacted'))).toBe(false);
      });
    }
  );

  it.each(['webos-device-info.cjs', 'webos-inspect.cjs', 'webos-health.cjs'])(
    'denies read-only %s before contacting a device', scriptName => {
      withDeniedScript(scriptName, root => {
        const result = spawnSync(process.execPath, [join(root, 'scripts', scriptName), '--device', 'fixture-tv'], {
          cwd: root, encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(scriptName === 'webos-health.cjs'
          ? 'Could not collect the webOS health snapshot.'
          : 'fixture authority denied');
        expect(existsSync(join(root, 'authority-denied-marker'))).toBe(true);
        expect(existsSync(join(root, 'device-contacted'))).toBe(false);
      });
    }
  );

  it('denies local SDK device listing before invoking the SDK', () => {
    withDeniedScript('webos-inspect.cjs', root => {
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'webos-inspect.cjs'), '--list'], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(join(root, 'authority-denied-marker'))).toBe(true);
      expect(existsSync(join(root, 'device-contacted'))).toBe(false);
    });
  });

  it('denies logs before opening the inspector on a device', () => {
    withDeniedScript('webos-logs.cjs', root => {
      copyFileSync(join(sourceScripts, 'webos-inspect.cjs'), join(root, 'scripts', 'webos-inspect.cjs'));
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'webos-logs.cjs'), '--device', 'fixture-tv'], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('fixture authority denied');
      expect(existsSync(join(root, 'device-contacted'))).toBe(false);
    });
  });

  it('denies a direct install before contacting a device', () => {
    withDeniedScript('webos-install.cjs', root => {
      const packages = join(root, 'dist', 'pkgs');
      mkdirSync(packages, { recursive: true });
      writeFileSync(join(packages, 'com.piggietv.webosnative_0.1.19_all.ipk'), 'fixture');
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'webos-install.cjs'), '--device', 'fixture-tv'], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('fixture authority denied');
      expect(existsSync(join(root, 'device-contacted'))).toBe(false);
    });
  });

  it('denies hosted launch before staging or contacting a device', () => {
    withDeniedScript('webos-launch-hosted.cjs', root => {
      mkdirSync(join(root, 'build', 'assets'), { recursive: true });
      writeFileSync(join(root, 'appinfo.json'), '{}');
      writeFileSync(join(root, 'icon.png'), 'fixture');
      writeFileSync(join(root, 'build', 'index.html'), '<html></html>');
      writeFileSync(join(root, 'build', 'assets', 'app.js'), 'fixture');
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'webos-launch-hosted.cjs'), '--device', 'fixture-tv'], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('fixture authority denied');
      expect(existsSync(join(root, 'dist', '.ptv-webos-hosted'))).toBe(false);
      expect(existsSync(join(root, 'device-contacted'))).toBe(false);
    });
  });

  it('launches only the already verified package staging directory in an approved fixture', () => {
    withDeniedScript('webos-launch-hosted.cjs', root => {
      const staged = join(root, 'dist', '.ptv-webos-package');
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(root, 'scripts', 'ptv-workspace-preflight.cjs'),
        `exports.assertWorkspaceAuthority = () => ({});\n`);
      writeFileSync(join(root, 'scripts', 'ptv-artifact-manifest.cjs'),
        `exports.verifyArtifactManifest = () => ({ staging: { root: ${JSON.stringify(staged)} } });\n`);
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'webos-launch-hosted.cjs'), '--device', 'fixture-tv'], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).toBe(0);
      const call = JSON.parse(readFileSync(join(root, 'device-contacted'), 'utf8')) as { command: string; args: string[] };
      expect(call.command).toBe('ares-launch');
      expect(call.args).toContain(staged);
      expect(existsSync(join(root, 'dist', '.ptv-webos-hosted'))).toBe(false);
    });
  });

  it('denies direct packaging before clearing existing output', () => {
    withDeniedScript('package-webos.cjs', root => {
      mkdirSync(join(root, 'build', 'assets'), { recursive: true });
      mkdirSync(join(root, 'dist', 'pkgs'), { recursive: true });
      writeFileSync(join(root, '.gitignore'), 'scripts/\nbuild/\ndist/\n');
      writeFileSync(join(root, 'appinfo.json'), '{}');
      writeFileSync(join(root, 'icon.png'), 'fixture');
      writeFileSync(join(root, 'build', 'index.html'), '<html></html>');
      writeFileSync(join(root, 'dist', 'pkgs', 'sentinel'), 'preserve');
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
      execFileSync('git', ['-C', root, 'add', '.gitignore', 'appinfo.json', 'icon.png']);
      execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'package-webos.cjs')], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('fixture authority denied');
      expect(existsSync(join(root, 'dist', 'pkgs', 'sentinel'))).toBe(true);
      expect(existsSync(join(root, 'device-contacted'))).toBe(false);
    });
  });

  it('denies a direct version bump before changing release metadata', () => {
    withDeniedScript('bump-version.cjs', root => {
      const appInfo = { id: 'com.piggietv.webosnative', version: '0.1.19' };
      const packageJson = { name: 'fixture', version: '0.1.19' };
      const packageLock = { version: '0.1.19', packages: { '': { version: '0.1.19' } } };
      writeFileSync(join(root, 'appinfo.json'), JSON.stringify(appInfo));
      writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify(packageLock));
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'bump-version.cjs')], {
        cwd: root, encoding: 'utf8'
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('fixture authority denied');
      expect(JSON.parse(readFileSync(join(root, 'appinfo.json'), 'utf8')).version).toBe('0.1.19');
    });
  });
});
