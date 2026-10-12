import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const health = require('../scripts/webos-health.cjs') as {
  BOOT_ID_COMMAND: string;
  classifyHealth: (signals: Record<string, any>, baseline?: string | null) => { code: string };
  collectHealth: (options: Record<string, unknown>) => Promise<Record<string, any>>;
  defaultProbeBootId: (device: string, options: Record<string, unknown>) => Record<string, unknown>;
  defaultProbeInspector: (device: string, appId: string, options: Record<string, unknown>) => Promise<Record<string, any>>;
  formatHealthReport: (report: Record<string, any>) => string;
  isSafeLocalInspectorWebSocketUrl: (value: string) => boolean;
  parseDeviceEndpoint: (output: string, alias: string) => { host: string; port: number };
  parseRunningAppPresence: (output: string, appId: string) => boolean;
  readBaselineBootFingerprint: (args: string[]) => string | null;
  readHeartbeatByCdp: (url: string, options: Record<string, unknown>) => Promise<Record<string, any>>;
  sanitizeHeartbeatSnapshot: (raw: Record<string, unknown>, now: number) => Record<string, any> | null;
};

const deviceList = [
  'name                 deviceinfo                  connection  profile  password',
  '-------------------  --------------------------  ----------  -------  --------',
  'PiggieTV-LG (default)  prisoner@10.16.0.231:9922  ssh         tv       never-print-me'
].join('\n');

function baseSignals() {
  return {
    tvReachable: { status: 'YES' },
    developerPort: { status: 'YES' },
    developerBridge: { status: 'YES' },
    appRunning: { status: 'YES' },
    webViewTarget: { status: 'YES' },
    inspectorCdp: { status: 'YES' },
    pageHeartbeat: { status: 'FRESH' },
    platformBoot: { status: 'YES', fingerprint: '111111111111' }
  };
}

describe('webOS host health classifier', () => {
  it('parses only the requested safe endpoint and exact application id', () => {
    expect(health.parseDeviceEndpoint(deviceList, 'PiggieTV-LG')).toEqual({
      host: '10.16.0.231',
      port: 9922
    });
    expect(health.parseRunningAppPresence(
      'com.example.other\ncom.piggietv.webosnative\n',
      'com.piggietv.webosnative'
    )).toBe(true);
    expect(health.parseRunningAppPresence(
      'com.piggietv.webosnative.preview',
      'com.piggietv.webosnative'
    )).toBe(false);
  });

  it('accepts only a fixed-format boot baseline', () => {
    expect(health.readBaselineBootFingerprint(['--baseline-boot', 'aabbccddeeff'])).toBe('aabbccddeeff');
    expect(() => health.readBaselineBootFingerprint([
      '--baseline-boot',
      'aabbccddeeff&whoami'
    ])).toThrow('12-character hexadecimal');
    expect(health.BOOT_ID_COMMAND).toBe('cat /proc/sys/kernel/random/boot_id');
  });

  it('reads only the fixed boot-id file with a bounded observational command', () => {
    const execute = vi.fn(() => '12345678-1234-1234-1234-123456789abc\n');
    expect(health.defaultProbeBootId('PiggieTV-LG', { platform: 'linux', execute })).toEqual({
      status: 'YES',
      fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/)
    });
    expect(execute).toHaveBeenCalledWith(
      'ares-novacom',
      ['--run', 'cat /proc/sys/kernel/random/boot_id', '-d', 'PiggieTV-LG'],
      expect.objectContaining({ timeout: 5_000, windowsHide: true })
    );

    const noisyExecute = vi.fn(() => '[Info] Set target device : PiggieTV-LG\n12345678-1234-1234-1234-123456789abc\n');
    expect(health.defaultProbeBootId('PiggieTV-LG', {
      platform: 'linux',
      execute: noisyExecute
    })).toEqual({
      status: 'YES',
      fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/)
    });
    expect(health.defaultProbeBootId('PiggieTV-LG', {
      platform: 'linux',
      execute: () => 'log 12345678-1234-1234-1234-123456789abc embedded\n'
    })).toMatchObject({ status: 'UNKNOWN' });
  });

  it('uses the fixed system PowerShell for a pinned health probe despite a spoofed SystemRoot', () => {
    const sdk = mkdtempSync(join(tmpdir(), 'ptv-webos-health-sdk-'));
    try {
      writeFileSync(join(sdk, 'ares-novacom.ps1'), 'fixture script');
      const execute = vi.fn(() => '12345678-1234-1234-1234-123456789abc\n');
      health.defaultProbeBootId('fixture-tv', {
        platform: 'win32', cliDirectory: sdk, env: { SystemRoot: 'C:\\attacker' }, execute
      });
      expect(execute.mock.calls[0][0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    } finally {
      rmSync(sdk, { recursive: true, force: true });
    }
  });

  it('sanitizes heartbeat state and fingerprints media-bearing focus ids', () => {
    const snapshot = health.sanitizeHeartbeatSnapshot({
      diagnosticMode: true,
      heartbeatAgeMs: 5,
      lastHeartbeat: {
        timestamp: 9_995,
        currentRoute: 'details:private-jellyfin-id',
        currentFocusId: 'browse-shows-private-jellyfin-id',
        documentVisibility: 'visible',
        accessToken: 'must-not-be-exported'
      },
      page: {
        pageInstanceId: 'page-1',
        webViewSessionId: 'webview-1',
        pageLoadCount: 3,
        pageLoadTimestamp: 9_000,
        timeOrigin: 8_900
      },
      showsLibrary: { current: {
        metadataCount: 120,
        renderWindowStart: 24,
        renderWindowEnd: 120,
        renderedCardCount: 96,
        focusedIndex: 80,
        currentColumns: 8
      } }
    }, 10_000);

    expect(snapshot).toMatchObject({
      status: 'FRESH',
      heartbeatAgeMs: 5,
      pageInstanceId: 'page-1',
      webViewSessionId: 'webview-1',
      pageLoadCounter: 3,
      route: 'details',
      visibilityState: 'visible',
      renderWindow: {
        metadataCount: 120,
        renderWindowStart: 24,
        renderWindowEnd: 120,
        renderedCardCount: 96,
        focusedIndex: 80,
        columns: 8
      }
    });
    expect(snapshot?.focusFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(snapshot)).not.toContain('private-jellyfin-id');
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-exported');
    expect(health.sanitizeHeartbeatSnapshot({
      heartbeatAgeMs: null,
      lastHeartbeat: null,
      page: {}
    }, 10_000)).toMatchObject({ status: 'UNKNOWN', heartbeatAgeMs: null });
  });

  it('reads only the single diagnostic snapshot contract over a local inspector socket', async () => {
    class FakeWebSocket extends EventEmitter {
      static latest: FakeWebSocket;
      sent = '';
      constructor(public url: string) {
        super();
        FakeWebSocket.latest = this;
      }
      send(payload: string) { this.sent = payload; }
      terminate() {}
    }

    expect(health.isSafeLocalInspectorWebSocketUrl('ws://127.0.0.1:43210/devtools/page/target')).toBe(true);
    expect(health.isSafeLocalInspectorWebSocketUrl('ws://example.com:43210/devtools/page/target')).toBe(false);

    const pending = health.readHeartbeatByCdp('ws://127.0.0.1:43210/devtools/page/private-target', {
      WebSocket: FakeWebSocket,
      now: () => 10_000
    });
    const socket = FakeWebSocket.latest;
    socket.emit('open');
    const request = JSON.parse(socket.sent);
    expect(request.params.expression).toContain('window.__ptvDiagnosticHealth');
    expect(request.params.expression).toContain('Object.isFrozen(diagnostic)');
    expect(request.params.expression).not.toContain('__ptvRuntimeDiagnostics');
    expect(request.params.expression).not.toContain('__PTV_DIAGNOSTICS__');
    socket.emit('message', JSON.stringify({
      id: 1,
      result: {
        result: {
          value: {
            heartbeatAgeMs: 5,
            lastHeartbeat: { timestamp: 9_995, currentRoute: 'shows' },
            page: { pageInstanceId: 'page-1', webViewSessionId: 'webview-1' }
          }
        }
      }
    }));

    await expect(pending).resolves.toMatchObject({
      cdp: { status: 'YES' },
      heartbeat: { status: 'FRESH', route: 'shows' }
    });
  });

  it('classifies only what the evidence proves', () => {
    expect(health.classifyHealth(baseSignals()).code).toBe('APP_ALIVE');
    expect(health.classifyHealth({
      ...baseSignals(),
      developerBridge: { status: 'NO' },
      appRunning: { status: 'UNKNOWN' },
      webViewTarget: { status: 'UNKNOWN' },
      inspectorCdp: { status: 'UNKNOWN' },
      pageHeartbeat: { status: 'UNKNOWN' }
    }).code).toBe('DEVELOPER_BRIDGE_UNAVAILABLE');
    expect(health.classifyHealth({
      ...baseSignals(),
      webViewTarget: { status: 'NO' },
      inspectorCdp: { status: 'UNKNOWN' },
      pageHeartbeat: { status: 'UNKNOWN' }
    }).code).toBe('WEBVIEW_TARGET_MISSING');
    expect(health.classifyHealth({
      ...baseSignals(),
      platformBoot: { status: 'YES', fingerprint: '222222222222' }
    }, '111111111111').code).toBe('PLATFORM_REBOOT_CONFIRMED');
  });

  it('uses only observational CLI operations and never probes inspector when the app is absent', async () => {
    const cliCalls: Array<{ command: string; args: string[] }> = [];
    const executeCli = vi.fn((command: string, args: string[]) => {
      cliCalls.push({ command, args });
      if (command === 'ares-setup-device') return deviceList;
      if (command === 'ares-device') return 'modelName: LG';
      if (command === 'ares-launch') return 'com.example.other';
      throw new Error('unexpected command');
    });
    const probeInspector = vi.fn();

    const report = await health.collectHealth({
      args: ['--device', 'PiggieTV-LG'],
      root: process.cwd(),
      executeCli,
      pingHost: () => ({ status: 'YES' }),
      probeTcp: () => Promise.resolve({ status: 'YES' }),
      probeBootId: () => Promise.resolve({ status: 'UNKNOWN' }),
      probeInspector,
      now: () => 1_725_000_000_000
    });

    expect(report.classification.code).toBe('APP_NOT_RUNNING');
    expect(cliCalls).toEqual([
      { command: 'ares-setup-device', args: ['--list'] },
      { command: 'ares-device', args: ['-i', '-d', 'PiggieTV-LG'] },
      { command: 'ares-launch', args: ['-r', '-d', 'PiggieTV-LG'] }
    ]);
    expect(probeInspector).not.toHaveBeenCalled();
    expect(cliCalls.some(call => call.command === 'ares-install')).toBe(false);
    expect(cliCalls.some(call => call.command === 'ares-launch' && !call.args.includes('-r'))).toBe(false);
  });

  it('keeps app heartbeat unknown when the reachable TV loses its developer bridge', async () => {
    const executeCli = vi.fn((command: string) => {
      if (command === 'ares-setup-device') return deviceList;
      throw Object.assign(new Error('bridge reset'), { code: 'ECONNRESET' });
    });

    const report = await health.collectHealth({
      args: ['--device', 'PiggieTV-LG'],
      root: process.cwd(),
      executeCli,
      pingHost: () => ({ status: 'YES' }),
      probeTcp: () => Promise.resolve({ status: 'NO' }),
      now: () => 1_725_000_000_000
    });

    expect(report.signals).toMatchObject({
      tvReachable: { status: 'YES' },
      developerBridge: { status: 'NO' },
      appRunning: { status: 'UNKNOWN' },
      webViewTarget: { status: 'UNKNOWN' },
      pageHeartbeat: { status: 'UNKNOWN' }
    });
    expect(report.classification.code).toBe('DEVELOPER_BRIDGE_UNAVAILABLE');
  });

  it('suppresses inspector URLs from reports and terminates its local tunnel', async () => {
    class FakeChild extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      killed = false;
      kill() { this.killed = true; }
    }
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const probe = health.defaultProbeInspector('PiggieTV-LG', 'com.piggietv.webosnative', {
      platform: 'win32',
      env: { PATH: 'C:\\tools' },
      findCliScript: () => 'C:\\tools\\ares-inspect.ps1',
      isFile: () => true,
      spawn,
      inspectLocalTarget: async () => ({
        target: { status: 'YES' },
        cdp: { status: 'YES' },
        heartbeat: { status: 'FRESH', heartbeatAgeMs: 20 }
      })
    });
    child.stdout.emit('data', 'Open http://localhost:43210/devtools/page/private-target');
    const result = await probe;

    expect(result).toMatchObject({ target: { status: 'YES' }, heartbeat: { status: 'FRESH' } });
    expect(child.killed).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'C:\\tools\\node.exe',
      [
        'C:\\tools\\node_modules\\@webos-tools\\cli\\bin\\ares-inspect.js',
        'com.piggietv.webosnative',
        '-d',
        'PiggieTV-LG'
      ],
      expect.objectContaining({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(spawn.mock.calls[0]?.[1]).not.toContain('-o');

    const formatted = health.formatHealthReport({
      checkedAt: '2026-08-10T00:00:00.000Z',
      deviceAlias: 'PiggieTV-LG',
      endpoint: null,
      classification: { code: 'APP_ALIVE', label: 'http://localhost:43210/private' },
      signals: {
        tvReachable: { status: 'YES' },
        developerPort: { status: 'YES' },
        developerBridge: { status: 'YES' },
        appRunning: { status: 'YES' },
        webViewTarget: { status: 'YES' },
        inspectorCdp: { status: 'YES' },
        pageHeartbeat: { status: 'FRESH', heartbeatAgeMs: 20 },
        platformBoot: { status: 'UNKNOWN' }
      }
    });
    expect(formatted).not.toContain('localhost:43210');
    expect(formatted).toContain('[suppressed inspector URL]');
  });
});
