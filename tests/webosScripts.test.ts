import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const common = require('../scripts/webos-common.cjs') as {
  copyValidatedBuildAssets: (sourceDir: string, targetDir: string) => string[];
  readDeviceAlias: (args?: string[], env?: Record<string, string>) => string | null;
  requireDeviceAlias: (args?: string[], env?: Record<string, string>) => string;
  requireHostIp: (args?: string[], env?: Record<string, string>) => string;
  runWebOsCli: (command: string, args: string[]) => unknown;
};
const inspector = require('../scripts/webos-inspect.cjs') as {
  buildInspectorArgs: (args?: string[], env?: Record<string, string>, root?: string) => string[];
  formatSafeDeviceList: (output: string) => string;
};

describe('webOS helper safety', () => {
  it('gives an explicit CLI device alias precedence over the environment', () => {
    expect(common.readDeviceAlias(
      ['--device', 'cli-tv'],
      { PTV_WEBOS_TEST_DEVICE: 'environment-tv' }
    )).toBe('cli-tv');
  });

  it('rejects shell metacharacters before constructing CLI arguments', () => {
    expect(() => common.requireDeviceAlias(['--device', 'tv&whoami'], {})).toThrow(
      'unsupported characters'
    );
    expect(() => common.requireHostIp(['--host-ip', '10.16.0.125&whoami'], {})).toThrow(
      'literal workstation IPv4 address'
    );
    expect(() => common.requireHostIp(['--host-ip', '2001:db8::1'], {})).toThrow(
      'literal workstation IPv4 address'
    );
  });

  it('accepts a literal workstation IP for hosted mode', () => {
    expect(common.requireHostIp(['--host-ip', '10.16.0.125'], {})).toBe('10.16.0.125');
  });

  it('prints only alias and endpoint from device-list output', () => {
    const output = [
      'name                 deviceinfo                  connection  profile  password',
      '-------------------  --------------------------  ----------  -------  --------',
      '\u001b[32mPiggieTV-LG (default)\u001b[0m  prisoner@10.16.0.231:9922  ssh         tv       never-print-me',
      'emulator             prisoner@127.0.0.1:6622    ssh         tv       another-secret'
    ].join('\n');

    const formatted = inspector.formatSafeDeviceList(output);
    expect(formatted).toContain('- PiggieTV-LG: 10.16.0.231:9922');
    expect(formatted).toContain('- emulator: 127.0.0.1:6622');
    expect(formatted).not.toContain('default');
    expect(formatted).not.toContain('never-print-me');
    expect(formatted).not.toContain('another-secret');
    expect(formatted).not.toContain('prisoner');
  });

  it('fails closed when the device list format cannot be parsed safely', () => {
    expect(() => inspector.formatSafeDeviceList('unexpected output')).toThrow(
      'without exposing credential fields'
    );
  });

  it('builds inspector arguments without a command shell', () => {
    expect(inspector.buildInspectorArgs(
      ['--device', 'PiggieTV-LG'],
      {},
      process.cwd()
    )).toEqual(['com.piggietv.webosnative', '-d', 'PiggieTV-LG']);
  });

  it('refuses commands outside the fixed webOS CLI allowlist', () => {
    expect(() => common.runWebOsCli('cmd.exe', ['/c', 'whoami'])).toThrow(
      'Unsupported webOS CLI command'
    );
  });

  it('stages only top-level JavaScript build assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'ptv-assets-'));
    try {
      const source = join(root, 'source');
      const target = join(root, 'target');
      mkdirSync(source);
      writeFileSync(join(source, 'main-legacy-ABC123.js'), 'window.__ptv = true;');

      expect(common.copyValidatedBuildAssets(source, target)).toEqual(['main-legacy-ABC123.js']);
      expect(readFileSync(join(target, 'main-legacy-ABC123.js'), 'utf8')).toContain('__ptv');

      writeFileSync(join(source, 'main-legacy-ABC123.js.map'), '{}');
      expect(() => common.copyValidatedBuildAssets(source, join(root, 'rejected'))).toThrow('unexpected assets');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
