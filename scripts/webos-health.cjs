#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { clearTimeout, setTimeout } = require('timers');
const { URL } = require('url');
const {
  findPowerShellCliScript,
  readAppInfo,
  readCliOption,
  requireDeviceAlias,
  runWebOsCli
} = require('./webos-common.cjs');

const YES = 'YES';
const NO = 'NO';
const UNKNOWN = 'UNKNOWN';
const CLI_TIMEOUT_MS = 5_000;
const NETWORK_TIMEOUT_MS = 2_000;
const INSPECTOR_TIMEOUT_MS = 7_000;
const HEARTBEAT_FRESH_MS = 12_500;
const BOOT_ID_COMMAND = 'cat /proc/sys/kernel/random/boot_id';
const SAFE_BOOT_FINGERPRINT = /^[a-f0-9]{12}$/i;
const INSPECTOR_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[^\s]*)?/i;

function signal(status, reason) {
  return reason ? { status, reason } : { status };
}

function safeErrorReason(error, fallback) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'ETIMEDOUT') return 'timed out';
  if (code === 'ENOENT') return 'tool unavailable';
  return fallback;
}

function readBaselineBootFingerprint(args = process.argv.slice(2)) {
  const value = readCliOption(args, ['--baseline-boot'], '--baseline-boot');
  if (!value) return null;
  if (!SAFE_BOOT_FINGERPRINT.test(value)) {
    throw new Error('The --baseline-boot value must be a 12-character hexadecimal fingerprint.');
  }
  return value.toLowerCase();
}

function parseDeviceEndpoint(rawOutput, requestedAlias) {
  const plainOutput = String(rawOutput).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of plainOutput.split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s{2,}[^\s@]+@([^\s:]+):(\d+)\s{2,}/);
    if (!match) continue;
    const alias = match[1].trim().replace(/\s+\(default\)$/i, '');
    if (alias !== requestedAlias) continue;
    const host = match[2];
    const port = Number(match[3]);
    if (!net.isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('The configured device endpoint is not a supported IPv4 host and port.');
    }
    return { host, port };
  }
  throw new Error('The requested device alias was not found in the credential-safe device list.');
}

function parseRunningAppPresence(rawOutput, appId) {
  const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s"'=,:])${escaped}(?=$|[\\s"',;])`, 'm').test(String(rawOutput));
}

function fingerprint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeRoute(value) {
  const route = typeof value === 'string' ? value.split(':', 1)[0].trim().toLowerCase() : '';
  return [
    'startup', 'server', 'auth', 'quick-connect', 'home', 'movies', 'shows',
    'music', 'reading', 'search', 'details', 'settings', 'diagnostics', 'playback'
  ].includes(route) ? route : null;
}

function sanitizeHeartbeatSnapshot(raw, checkedAtMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const heartbeat = raw.lastHeartbeat && typeof raw.lastHeartbeat === 'object'
    ? raw.lastHeartbeat
    : raw;
  const page = raw.page && typeof raw.page === 'object' ? raw.page : heartbeat;
  const showsLibrary = raw.showsLibrary && typeof raw.showsLibrary === 'object'
    ? raw.showsLibrary
    : null;
  const windowState = showsLibrary?.current && typeof showsLibrary.current === 'object'
    ? showsLibrary.current
    : heartbeat.showsLibrary && typeof heartbeat.showsLibrary === 'object'
      ? heartbeat.showsLibrary
      : raw.renderWindow && typeof raw.renderWindow === 'object'
        ? raw.renderWindow
        : raw.lastRenderWindow && typeof raw.lastRenderWindow === 'object'
          ? raw.lastRenderWindow
          : null;
  const heartbeatAt = finiteNumber(
    heartbeat.timestamp
      ?? heartbeat.lastHeartbeatAt
      ?? heartbeat.lastHeartbeatTimestamp
      ?? heartbeat.heartbeatAt
  );
  const reportedAgeMs = finiteNumber(raw.heartbeatAgeMs);
  const heartbeatAgeMs = reportedAgeMs !== null
    ? Math.max(0, Math.round(reportedAgeMs))
    : heartbeatAt === null
      ? null
      : Math.max(0, Math.round(checkedAtMs - heartbeatAt));
  const focusId = heartbeat.currentFocusId ?? heartbeat.focusId ?? windowState?.focusedItemId;

  return {
    status: heartbeatAgeMs === null
      ? UNKNOWN
      : heartbeatAgeMs <= HEARTBEAT_FRESH_MS ? 'FRESH' : 'STALE',
    heartbeatAt,
    heartbeatAgeMs,
    pageInstanceId: typeof page.pageInstanceId === 'string' ? page.pageInstanceId.slice(0, 128) : null,
    webViewSessionId: typeof page.webViewSessionId === 'string' ? page.webViewSessionId.slice(0, 128) : null,
    pageLoadCounter: finiteNumber(page.pageLoadCount ?? page.pageLoadCounter),
    pageLoadTimestamp: finiteNumber(page.pageLoadTimestamp),
    timeOrigin: finiteNumber(page.timeOrigin),
    route: safeRoute(heartbeat.currentRoute ?? heartbeat.route),
    focusFingerprint: fingerprint(typeof focusId === 'string' ? focusId : null),
    visibilityState: ['visible', 'hidden', 'prerender', 'unloaded'].includes(
      heartbeat.visibilityState ?? heartbeat.documentVisibility
    )
      ? heartbeat.visibilityState ?? heartbeat.documentVisibility
      : null,
    lifecycleState: typeof heartbeat.lifecycleState === 'string'
      ? heartbeat.lifecycleState.slice(0, 64)
      : null,
    renderWindow: windowState ? {
      metadataCount: finiteNumber(windowState.metadataCount),
      renderWindowStart: finiteNumber(windowState.renderWindowStart ?? windowState.startIndex),
      renderWindowEnd: finiteNumber(windowState.renderWindowEnd ?? windowState.endIndex),
      renderedCardCount: finiteNumber(windowState.renderedCardCount),
      focusedIndex: finiteNumber(windowState.focusedIndex),
      scrollTop: finiteNumber(windowState.scrollTop),
      topSpacerHeight: finiteNumber(windowState.topSpacerHeight),
      bottomSpacerHeight: finiteNumber(windowState.bottomSpacerHeight),
      artworkActive: finiteNumber(windowState.artworkActive),
      columns: finiteNumber(windowState.currentColumns ?? windowState.columns)
    } : null
  };
}

function defaultPingHost(host, options = {}) {
  const execute = options.execute ?? execFileSync;
  const platform = options.platform ?? process.platform;
  const args = platform === 'win32'
    ? ['-n', '1', '-w', String(NETWORK_TIMEOUT_MS), host]
    : ['-c', '1', '-W', '2', host];
  try {
    execute(platform === 'win32' ? 'ping.exe' : 'ping', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NETWORK_TIMEOUT_MS + 1_000,
      windowsHide: true
    });
    return signal(YES);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return signal(UNKNOWN, 'ping tool unavailable');
    }
    if (error && typeof error === 'object' && error.code === 'ETIMEDOUT') {
      return signal(UNKNOWN, 'ping timed out');
    }
    return signal(NO, 'host did not answer one ICMP probe');
  }
}

function defaultProbeTcp(host, port, timeoutMs = NETWORK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(signal(YES)));
    socket.once('timeout', () => finish(signal(NO, 'developer port timed out')));
    socket.once('error', () => finish(signal(NO, 'developer port connection failed')));
  });
}

function fixedCliInvocation(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: command, args };
  const script = findPowerShellCliScript(command, env);
  const systemRoot = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  return {
    file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, ...args
    ]
  };
}

function fixedInspectorInvocation(args, env = process.env, platform = process.platform, options = {}) {
  if (platform !== 'win32') return { file: 'ares-inspect', args };
  const findScript = options.findCliScript ?? findPowerShellCliScript;
  const isFile = options.isFile ?? (candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const shim = findScript('ares-inspect', env);
  const cliDirectory = path.dirname(shim);
  const cliScript = path.join(
    cliDirectory,
    'node_modules',
    '@webos-tools',
    'cli',
    'bin',
    'ares-inspect.js'
  );
  if (!isFile(cliScript)) throw new Error('Could not resolve the ares-inspect executable.');
  const adjacentNode = path.join(cliDirectory, 'node.exe');
  const nodeExecutable = isFile(adjacentNode)
    ? adjacentNode
    : options.nodeExecutable ?? process.execPath;
  if (!isFile(nodeExecutable)) throw new Error('Could not resolve the Node executable for ares-inspect.');
  return { file: nodeExecutable, args: [cliScript, ...args] };
}

function defaultProbeBootId(device, options = {}) {
  const execute = options.execute ?? execFileSync;
  try {
    const invocation = fixedCliInvocation(
      'ares-novacom',
      ['--run', BOOT_ID_COMMAND, '-d', device],
      options.env,
      options.platform
    );
    const output = execute(invocation.file, invocation.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      env: options.env ?? process.env
    });
    const plainOutput = String(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const match = plainOutput.match(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\s*$/im);
    if (!match) return signal(UNKNOWN, 'platform boot identity unavailable');
    return { status: YES, fingerprint: fingerprint(match[0]) };
  } catch (error) {
    return signal(UNKNOWN, safeErrorReason(error, 'platform boot identity unavailable'));
  }
}

function getJson(url, timeoutMs = NETWORK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length < 256_000) body += chunk;
      });
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error('Inspector endpoint returned an error status.'));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Inspector endpoint did not return JSON.'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Inspector endpoint timed out.')));
    request.once('error', reject);
  });
}

function isSafeLocalInspectorWebSocketUrl(value) {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === 'ws:'
      && !parsed.username
      && !parsed.password
      && ['localhost', '127.0.0.1'].includes(parsed.hostname)
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535;
  } catch {
    return false;
  }
}

function readHeartbeatByCdp(webSocketDebuggerUrl, options = {}) {
  return new Promise(resolve => {
    if (!isSafeLocalInspectorWebSocketUrl(webSocketDebuggerUrl)) {
      resolve({ cdp: signal(UNKNOWN, 'CDP target was not a local inspector endpoint'), heartbeat: null });
      return;
    }
    let WebSocket;
    try {
      WebSocket = options.WebSocket ?? require('ws');
    } catch {
      resolve({ cdp: signal(UNKNOWN, 'WebSocket client unavailable'), heartbeat: null });
      return;
    }

    const socket = new WebSocket(webSocketDebuggerUrl);
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.terminate(); } catch {
        // The connection may already be closed; cleanup remains best-effort.
      }
      resolve(result);
    };
    timer = setTimeout(() => finish({
      cdp: signal(UNKNOWN, 'CDP heartbeat read timed out'),
      heartbeat: null
    }), NETWORK_TIMEOUT_MS);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(function () {
            var diagnostic = window.__ptvDiagnosticHealth;
            if (!diagnostic || !Object.isFrozen(diagnostic) || typeof diagnostic.snapshot !== 'function') return null;
            return diagnostic.snapshot();
          })()`,
          returnByValue: true
        }
      }));
    });
    socket.once('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.id !== 1 || message.error || message.result?.exceptionDetails) {
          finish({ cdp: signal(UNKNOWN, 'CDP heartbeat read failed'), heartbeat: null });
          return;
        }
        finish({
          cdp: signal(YES),
          heartbeat: sanitizeHeartbeatSnapshot(message.result?.result?.value, options.now?.() ?? Date.now())
        });
      } catch {
        finish({ cdp: signal(UNKNOWN, 'CDP heartbeat response was invalid'), heartbeat: null });
      }
    });
    socket.once('error', () => finish({
      cdp: signal(UNKNOWN, 'CDP connection failed'),
      heartbeat: null
    }));
  });
}

async function inspectLocalTarget(port, options = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { target: signal(UNKNOWN, 'inspector returned an invalid local port'), cdp: signal(UNKNOWN), heartbeat: null };
  }
  try {
    const targets = await (options.getJson ?? getJson)(`http://127.0.0.1:${port}/json/list`);
    const page = Array.isArray(targets)
      ? targets.find(target => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      : null;
    if (!page) {
      return { target: signal(NO, 'no inspectable page target'), cdp: signal(UNKNOWN), heartbeat: null };
    }
    const runtime = await (options.readHeartbeat ?? readHeartbeatByCdp)(page.webSocketDebuggerUrl, options);
    return { target: signal(YES), ...runtime };
  } catch {
    return { target: signal(UNKNOWN, 'local inspector endpoint unavailable'), cdp: signal(UNKNOWN), heartbeat: null };
  }
}

function defaultProbeInspector(device, appId, options = {}) {
  return new Promise(resolve => {
    let invocation;
    try {
      invocation = fixedInspectorInvocation(
        [appId, '-d', device],
        options.env,
        options.platform,
        options
      );
    } catch (error) {
      resolve({ target: signal(UNKNOWN, safeErrorReason(error, 'inspector tool unavailable')), cdp: signal(UNKNOWN), heartbeat: null });
      return;
    }

    const launchProcess = options.spawn ?? spawn;
    const child = launchProcess(invocation.file, invocation.args, {
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let probing = false;
    let buffered = '';
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {
        // The inspector may have exited already; cleanup remains best-effort.
      }
      resolve(result);
    };
    timer = setTimeout(() => finish({
      target: signal(UNKNOWN, 'inspector target probe timed out'),
      cdp: signal(UNKNOWN),
      heartbeat: null
    }), INSPECTOR_TIMEOUT_MS);
    const onData = data => {
      if (settled || probing) return;
      buffered = `${buffered}${String(data)}`.slice(-32_000);
      const match = buffered.match(INSPECTOR_URL);
      if (!match) return;
      probing = true;
      const port = Number(match[1]);
      void (options.inspectLocalTarget ?? inspectLocalTarget)(port, options).then(finish, () => finish({
        target: signal(UNKNOWN, 'inspector target probe failed'),
        cdp: signal(UNKNOWN),
        heartbeat: null
      }));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', error => finish({
      target: signal(UNKNOWN, safeErrorReason(error, 'inspector tool failed')),
      cdp: signal(UNKNOWN),
      heartbeat: null
    }));
    child.once('exit', code => {
      if (settled || probing) return;
      const explicitMissingTarget = /not\s+(?:running|found)|no\s+such\s+app|cannot\s+find/i.test(buffered);
      finish({
        target: signal(explicitMissingTarget ? NO : UNKNOWN, explicitMissingTarget
          ? 'no inspectable target was reported'
          : `inspector ended before exposing a target${code === null ? '' : ` (exit ${code})`}`),
        cdp: signal(UNKNOWN),
        heartbeat: null
      });
    });
  });
}

function classifyHealth(signals, baselineBootFingerprint = null) {
  if (
    baselineBootFingerprint
    && signals.platformBoot?.status === YES
    && signals.platformBoot.fingerprint !== baselineBootFingerprint
  ) {
    return { code: 'PLATFORM_REBOOT_CONFIRMED', label: 'Platform reboot confirmed by changed boot identity' };
  }
  if (signals.developerBridge.status === NO) {
    if (signals.tvReachable.status === YES) {
      return { code: 'DEVELOPER_BRIDGE_UNAVAILABLE', label: 'TV reachable; developer bridge unavailable' };
    }
    if (signals.tvReachable.status === NO && signals.developerPort.status === NO) {
      return { code: 'TV_OR_NETWORK_UNREACHABLE', label: 'TV or its network path is unreachable' };
    }
    return { code: 'DEVICE_TRANSPORT_DISCONNECT', label: 'Device transport unavailable; TV state unknown' };
  }
  if (signals.developerBridge.status !== YES) {
    return { code: 'HEALTH_INCONCLUSIVE', label: 'Developer bridge health is unknown' };
  }
  if (signals.appRunning.status === NO) {
    return { code: 'APP_NOT_RUNNING', label: 'Developer bridge is healthy; application is not running' };
  }
  if (signals.appRunning.status !== YES) {
    return { code: 'APP_PRESENCE_UNKNOWN', label: 'Developer bridge is healthy; application presence is unknown' };
  }
  if (signals.webViewTarget.status === NO) {
    return { code: 'WEBVIEW_TARGET_MISSING', label: 'Application is listed as running; WebView target is missing' };
  }
  if (signals.pageHeartbeat?.status === 'FRESH') {
    return { code: 'APP_ALIVE', label: 'Application heartbeat is fresh' };
  }
  if (signals.pageHeartbeat?.status === 'STALE') {
    return { code: 'PAGE_HEARTBEAT_STALE', label: 'Inspector responds; application heartbeat is stale' };
  }
  if (signals.inspectorCdp.status === YES) {
    return { code: 'APP_HEARTBEAT_UNKNOWN', label: 'WebView responds; diagnostic heartbeat is unavailable' };
  }
  if (signals.webViewTarget.status === YES) {
    return { code: 'INSPECTOR_CDP_UNAVAILABLE', label: 'WebView target exists; CDP health is unknown' };
  }
  return { code: 'WEBVIEW_HEALTH_UNKNOWN', label: 'Application is running; WebView health is unknown' };
}

async function collectHealth(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const root = options.root ?? process.cwd();
  const now = options.now ?? (() => Date.now());
  const device = requireDeviceAlias(args, env);
  const appId = readAppInfo(root).id;
  const baselineBootFingerprint = options.baselineBootFingerprint
    ?? readBaselineBootFingerprint(args);
  const executeCli = options.executeCli ?? runWebOsCli;
  let endpoint = null;
  try {
    const deviceList = executeCli('ares-setup-device', ['--list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS
    });
    endpoint = parseDeviceEndpoint(deviceList, device);
  } catch {
    // An unavailable device list is represented by UNKNOWN signals below.
  }

  let ping = signal(UNKNOWN, 'device endpoint unavailable');
  let developerPort = signal(UNKNOWN, 'device endpoint unavailable');
  if (endpoint) {
    ping = await (options.pingHost ?? defaultPingHost)(endpoint.host, options);
    developerPort = await (options.probeTcp ?? defaultProbeTcp)(endpoint.host, endpoint.port, NETWORK_TIMEOUT_MS);
  }

  let developerBridge;
  try {
    executeCli('ares-device', ['-i', '-d', device], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS
    });
    developerBridge = signal(YES);
  } catch (error) {
    developerBridge = signal(
      error && typeof error === 'object' && error.code === 'ENOENT' ? UNKNOWN : NO,
      safeErrorReason(error, 'developer bridge did not respond')
    );
  }

  const tvReachable = developerBridge.status === YES ? signal(YES) : ping;
  let appRunning = signal(UNKNOWN, 'developer bridge unavailable');
  let platformBoot = signal(UNKNOWN, 'developer bridge unavailable');
  let inspector = { target: signal(UNKNOWN, 'application presence unavailable'), cdp: signal(UNKNOWN), heartbeat: null };
  if (developerBridge.status === YES) {
    try {
      const running = executeCli('ares-launch', ['-r', '-d', device], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS
      });
      appRunning = signal(parseRunningAppPresence(running, appId) ? YES : NO);
    } catch (error) {
      appRunning = signal(UNKNOWN, safeErrorReason(error, 'running-app list unavailable'));
    }
    platformBoot = await (options.probeBootId ?? defaultProbeBootId)(device, options);
    if (appRunning.status === YES) {
      inspector = await (options.probeInspector ?? defaultProbeInspector)(device, appId, { ...options, now });
    }
  }

  const signals = {
    tvReachable,
    icmpPing: ping,
    developerPort,
    developerBridge,
    appRunning,
    webViewTarget: inspector.target,
    inspectorCdp: inspector.cdp,
    pageHeartbeat: inspector.heartbeat ?? { status: UNKNOWN },
    platformBoot: platformBoot.status === YES ? {
      ...platformBoot,
      changedFromBaseline: baselineBootFingerprint
        ? platformBoot.fingerprint === baselineBootFingerprint ? NO : YES
        : UNKNOWN
    } : { ...platformBoot, changedFromBaseline: UNKNOWN }
  };

  return {
    checkedAt: new Date(now()).toISOString(),
    deviceAlias: device,
    endpoint: endpoint ? `${endpoint.host}:${endpoint.port}` : null,
    appId,
    classification: classifyHealth(signals, baselineBootFingerprint),
    signals
  };
}

function formatHealthReport(report) {
  const heartbeat = report.signals.pageHeartbeat;
  const lines = [
    `PiggieTV webOS health snapshot — ${report.checkedAt}`,
    `Device: ${report.deviceAlias}${report.endpoint ? ` (${report.endpoint})` : ''}`,
    `TV reachable: ${report.signals.tvReachable.status}`,
    `Developer port: ${report.signals.developerPort.status}`,
    `Developer bridge: ${report.signals.developerBridge.status}`,
    `App running: ${report.signals.appRunning.status}`,
    `WebView target: ${report.signals.webViewTarget.status}`,
    `Inspector/CDP: ${report.signals.inspectorCdp.status}`,
    `App heartbeat: ${heartbeat.status}${Number.isFinite(heartbeat.heartbeatAgeMs) ? ` (${heartbeat.heartbeatAgeMs} ms old)` : ''}`,
    `Platform boot identity: ${report.signals.platformBoot.status}${report.signals.platformBoot.fingerprint ? ` (${report.signals.platformBoot.fingerprint})` : ''}`,
    `Classification: ${report.classification.code} — ${report.classification.label}`,
    'No application or device state was changed.'
  ];
  return lines.join('\n').replace(/https?:\/\/[^\s]+/gi, '[suppressed inspector URL]');
}

async function main() {
  try {
    const report = await collectHealth();
    if (process.argv.slice(2).includes('--json')) {
      console.log(JSON.stringify(report, null, 2).replace(/https?:\/\/[^\s"\\]+/gi, '[suppressed inspector URL]'));
    } else {
      console.log(formatHealthReport(report));
    }
  } catch (error) {
    console.error(safeErrorReason(error, 'Could not collect the webOS health snapshot.'));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  BOOT_ID_COMMAND,
  HEARTBEAT_FRESH_MS,
  NO,
  UNKNOWN,
  YES,
  classifyHealth,
  collectHealth,
  defaultProbeBootId,
  defaultProbeInspector,
  fixedInspectorInvocation,
  formatHealthReport,
  isSafeLocalInspectorWebSocketUrl,
  inspectLocalTarget,
  parseDeviceEndpoint,
  parseRunningAppPresence,
  readBaselineBootFingerprint,
  readHeartbeatByCdp,
  sanitizeHeartbeatSnapshot
};
