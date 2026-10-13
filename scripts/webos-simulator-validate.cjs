#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { setTimeout } = require('timers');
const { URL } = require('url');
const {
  captureScreenshot,
  connectTarget,
  dispatchDpadKey,
  pressRcuKey,
  readAppSurface,
  readDiagnosticSnapshot,
  selectAppTarget,
  selectRcuTarget,
  selectShellTarget,
  waitForTargets
} = require('./webos-cdp.cjs');

const DEFAULT_SIMULATOR_VERSION = '26';
const DEFAULT_MAX_ROWS = 150;
const MAX_BOUNDARY_CROSSINGS = 2_000;
const MAX_RENDERED_CARDS = 96;
const MAX_ARTWORK_ACTIVE = 6;
const METADATA_BATCH_SIZE = 24;
const KNOWN_SHELL_FOCUS = [
  'shell-home', 'shell-movies', 'shell-shows', 'shell-music', 'shell-search',
  'shell-profile', 'shell-settings'
];
const KNOWN_FILTER_FOCUS = [
  'browse-filter-recent', 'browse-filter-az', 'browse-filter-favorites'
];
const SHOWS_BOUNDARY_PATH = [552, 560, 568, 576, 584, 592, 600];

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function readIntegerOption(args, name, fallback, minimum, maximum) {
  const raw = readOption(args, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function parseSimulatorArgs(args = process.argv.slice(2), env = process.env, root = process.cwd()) {
  if (args.includes('--device') || args.includes('-d')) {
    throw new Error('Simulator validation never accepts a physical device alias.');
  }
  if (env.PTV_WEBOS_TEST_DEVICE) {
    throw new Error('Unset PTV_WEBOS_TEST_DEVICE before Simulator validation; physical-device settings are rejected.');
  }
  const prepare = !args.includes('--no-prepare');
  const simulatorPath = readOption(args, '--simulator-path')
    ?? env.PTV_WEBOS_SIMULATOR_PATH
    ?? null;
  if (!simulatorPath) {
    throw new Error('Missing Simulator path. Pass --simulator-path or set PTV_WEBOS_SIMULATOR_PATH.');
  }
  const explicitAppDirectory = readOption(args, '--app-dir');
  if (!prepare && !explicitAppDirectory) {
    throw new Error('--no-prepare requires --app-dir with an existing package staging directory.');
  }
  const simulatorVersion = readOption(args, '--simulator-version')
    ?? env.PTV_WEBOS_SIMULATOR_VERSION
    ?? DEFAULT_SIMULATOR_VERSION;
  if (!/^\d{1,2}$/.test(simulatorVersion)) {
    throw new Error('--simulator-version must be a one- or two-digit webOS TV version.');
  }
  const appDir = explicitAppDirectory
    ? path.resolve(root, explicitAppDirectory)
    : prepare
      ? path.join(root, 'dist', '.ptv-webos-package')
      : null;
  const artifactOption = readOption(args, '--artifact-dir');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    appDir,
    artifactDir: path.resolve(root, artifactOption ?? path.join('artifacts', 'webos-simulator', timestamp)),
    authWaitMinutes: readIntegerOption(args, '--auth-wait-minutes', 0, 0, 30),
    boundaryCrossings: readIntegerOption(
      args,
      '--boundary-crossings',
      0,
      0,
      MAX_BOUNDARY_CROSSINGS
    ),
    cdpPort: readIntegerOption(args, '--cdp-port', null, 1_024, 65_535),
    enduranceMinutes: readIntegerOption(args, '--endurance-minutes', 0, 0, 720),
    keepOpen: args.includes('--keep-open'),
    lifecycleCycle: args.includes('--lifecycle-cycle'),
    maxRows: readIntegerOption(args, '--max-rows', DEFAULT_MAX_ROWS, 1, 2_000),
    prepare,
    simulatorPath: path.resolve(simulatorPath),
    simulatorVersion
  };
}

function versionParts(value) {
  return String(value).split('.').map(part => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function simulatorExecutableInfo(executablePath) {
  const match = path.basename(executablePath).match(
    /^webOS_TV_(\d{1,2})_Simulator_([0-9]+(?:\.[0-9]+){1,3})\.exe$/i
  );
  return match ? { simulatorVersion: match[2], tvVersion: match[1] } : null;
}

function validateSimulatorExecutable(candidatePath, expectedTvVersion = DEFAULT_SIMULATOR_VERSION) {
  const resolved = path.resolve(candidatePath);
  if (!fs.existsSync(resolved)) throw new Error(`Simulator path does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  const candidates = stat.isFile()
    ? [resolved]
    : fs.readdirSync(resolved, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(resolved, entry.name));
  const matches = candidates
    .map(file => ({ file, info: simulatorExecutableInfo(file) }))
    .filter(entry => entry.info?.tvVersion === String(expectedTvVersion))
    .sort((left, right) => compareVersions(right.info.simulatorVersion, left.info.simulatorVersion));
  if (!matches.length) {
    throw new Error(`No webOS TV ${expectedTvVersion} Simulator executable was found at the supplied path.`);
  }
  return matches[0].file;
}

function validateAppDirectory(candidatePath) {
  const resolved = path.resolve(candidatePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Simulator app directory does not exist: ${resolved}`);
  }
  const appInfoPath = path.join(resolved, 'appinfo.json');
  if (!fs.existsSync(appInfoPath)) throw new Error('Simulator app directory is missing appinfo.json.');
  const appInfo = JSON.parse(fs.readFileSync(appInfoPath, 'utf8'));
  const main = typeof appInfo.main === 'string' && appInfo.main ? appInfo.main : 'index.html';
  if (!fs.existsSync(path.join(resolved, main))) {
    throw new Error(`Simulator app directory is missing its main entry: ${main}`);
  }
  if (!appInfo.id || !appInfo.version) throw new Error('Simulator appinfo.json is missing id or version.');
  return resolved;
}

function safeHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function sanitizeString(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:access[_-]?token|api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .replace(/([?&](?:api_key|access_token|token|secret|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(\/devtools\/(?:browser|page)\/)[A-Za-z0-9_-]+/gi, '$1[redacted]')
    .replace(/(\/(?:Items|Videos|Users)\/)[^/?#\s]+/gi, '$1[redacted]')
    .replace(/(browse-shows-)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
}

function sanitizeSimulatorArtifact(value, key = '') {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value ?? null;
  }
  if (typeof value === 'string') {
    if (/password|authorization|cookie|secret|access.?token|api.?key/i.test(key)) return '[redacted]';
    if (/^(?:user|item|focusedItem)Id$/i.test(key) && value) return `[sha256:${safeHash(value)}]`;
    return sanitizeString(value);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeSimulatorArtifact(item, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeSimulatorArtifact(childValue, childKey)
    ]));
  }
  return String(value);
}

function summarizeRuntimeEvent(event) {
  if (event?.method === 'Runtime.consoleAPICalled') {
    return {
      argumentTypes: Array.isArray(event.params?.args)
        ? event.params.args.map(argument => argument?.subtype ?? argument?.type ?? 'unknown')
        : [],
      method: event.method,
      phase: event.validationPhase ?? 'unknown',
      timestamp: event.params?.timestamp ?? null,
      type: event.params?.type ?? 'unknown'
    };
  }
  if (event?.method === 'Runtime.exceptionThrown') {
    return {
      columnNumber: event.params?.exceptionDetails?.columnNumber ?? null,
      lineNumber: event.params?.exceptionDetails?.lineNumber ?? null,
      method: event.method,
      phase: event.validationPhase ?? 'unknown',
      text: sanitizeString(
        event.params?.exceptionDetails?.exception?.description
          ?? event.params?.exceptionDetails?.text
          ?? 'Runtime exception'
      ),
      timestamp: event.params?.timestamp ?? null,
      url: sanitizeString(event.params?.exceptionDetails?.url ?? '')
    };
  }
  return {
    level: event?.params?.entry?.level ?? 'unknown',
    method: event?.method ?? 'unknown',
    phase: event?.validationPhase ?? 'unknown',
    source: event?.params?.entry?.source ?? 'unknown',
    text: sanitizeString(event?.params?.entry?.text ?? ''),
    timestamp: event?.params?.entry?.timestamp ?? null,
    url: sanitizeString(event?.params?.entry?.url ?? '')
  };
}

function attachAppSessionTelemetry(appSession, metadataTracker, runtimeEvents, validationPhase) {
  appSession.onEvent(event => {
    metadataTracker.handle(event);
    if (
      event.method === 'Runtime.consoleAPICalled'
      || event.method === 'Runtime.exceptionThrown'
      || event.method === 'Log.entryAdded'
    ) {
      runtimeEvents.push({ ...event, validationPhase });
    }
  });
}

async function enableAppSessionTelemetry(appSession) {
  await Promise.all([
    appSession.call('Runtime.enable'),
    appSession.call('Log.enable'),
    appSession.call('Network.enable'),
    appSession.call('Page.enable')
  ]);
}

function processCleanupSucceeded(cleanup) {
  return cleanup?.portClosed === true && cleanup?.processTreeClosed === true;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotEvents(snapshot) {
  const library = snapshot?.showsLibrary;
  const events = Array.isArray(library?.recentEvents) ? library.recentEvents : [];
  return library?.current ? [...events, library.current] : [...events];
}

function classifySimulatorMetrics(snapshot) {
  const events = snapshotEvents(snapshot);
  const violations = new Set();
  const previousMetadataByScope = new Map();
  let maximumArtworkActive = null;
  let maximumMetadata = null;
  let maximumRenderedCards = null;
  for (const event of events) {
    const metadata = finiteNumber(event?.metadataCount);
    const rendered = finiteNumber(event?.renderedCardCount);
    const artwork = finiteNumber(event?.artworkActive);
    const start = finiteNumber(event?.renderWindowStart ?? event?.startIndex);
    const end = finiteNumber(event?.renderWindowEnd ?? event?.endIndex);
    const focusedIndex = finiteNumber(event?.focusedIndex);
    const focusOwnerCount = finiteNumber(event?.focusOwnerCount);
    if (metadata !== null) {
      maximumMetadata = Math.max(maximumMetadata ?? 0, metadata);
      if (event?.initialBatch === true && metadata > METADATA_BATCH_SIZE) {
        violations.add('INITIAL_BATCH_LIMIT');
      }
      const scope = String(event?.generation ?? event?.filter ?? 'default');
      const previousMetadata = previousMetadataByScope.get(scope) ?? null;
      if (previousMetadata !== null && metadata >= previousMetadata
        && metadata - previousMetadata > METADATA_BATCH_SIZE) violations.add('METADATA_BATCH_LIMIT');
      previousMetadataByScope.set(scope, metadata);
    }
    if (rendered !== null) {
      maximumRenderedCards = Math.max(maximumRenderedCards ?? 0, rendered);
      if (rendered > MAX_RENDERED_CARDS) violations.add('RENDER_WINDOW_LIMIT');
    }
    if (artwork !== null) {
      maximumArtworkActive = Math.max(maximumArtworkActive ?? 0, artwork);
      if (artwork > MAX_ARTWORK_ACTIVE) violations.add('ARTWORK_CONCURRENCY_LIMIT');
    }
    if (focusedIndex !== null && start !== null && end !== null
      && (focusedIndex < start || focusedIndex >= end)) violations.add('FOCUS_OUTSIDE_WINDOW');
    if (focusOwnerCount !== null && focusOwnerCount !== 1) violations.add('FOCUS_OWNER_COUNT');
    if (event?.duplicateMetadataRequest === true || event?.duplicateActiveRequest === true) {
      violations.add('DUPLICATE_METADATA_REQUEST');
    }
  }
  const coverage = {
    artwork: events.some(event => finiteNumber(event?.artworkActive) !== null),
    focus: events.some(event => finiteNumber(event?.focusedIndex) !== null),
    metadata: events.some(event => finiteNumber(event?.metadataCount) !== null),
    renderedCards: events.some(event => finiteNumber(event?.renderedCardCount) !== null),
    renderWindow: events.some(event => (
      finiteNumber(event?.renderWindowStart ?? event?.startIndex) !== null
      && finiteNumber(event?.renderWindowEnd ?? event?.endIndex) !== null
    ))
  };
  const observed = Object.values(coverage).every(Boolean);
  return {
    coverage,
    maximumArtworkActive,
    maximumMetadata,
    maximumRenderedCards,
    ok: violations.size === 0,
    observed,
    status: !observed ? 'UNKNOWN' : violations.size === 0 ? 'PASS' : 'FAIL',
    violations: [...violations]
  };
}

function parseMetadataRequest(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    if (!/\/Users\/[^/]+\/Items$/i.test(parsed.pathname)) return null;
    if (!String(parsed.searchParams.get('IncludeItemTypes') || '').split(',').includes('Series')) return null;
    if (parsed.searchParams.get('EnableTotalRecordCount') !== 'true') return null;
    const limit = Number(parsed.searchParams.get('Limit'));
    const startIndex = Number(parsed.searchParams.get('StartIndex') ?? 0);
    if (!Number.isInteger(limit) || !Number.isInteger(startIndex)) return null;
    const favoriteFilters = String(parsed.searchParams.get('Filters') || '').split(',');
    const filter = favoriteFilters.includes('IsFavorite')
      ? 'favorites'
      : /SortName/i.test(parsed.searchParams.get('SortBy') || '')
        ? 'az'
        : 'recent';
    return { filter, limit, startIndex };
  } catch {
    return null;
  }
}

function createMetadataRequestTracker() {
  const activeByRequestId = new Map();
  const activeSignatures = new Set();
  const requests = [];
  let duplicateActiveCount = 0;
  return {
    handle(event) {
      if (event?.method === 'Network.requestWillBeSent') {
        const metadata = parseMetadataRequest(event.params?.request?.url);
        if (!metadata) return;
        const signature = `${metadata.filter}:${metadata.startIndex}:${metadata.limit}`;
        const duplicateActive = activeSignatures.has(signature);
        if (duplicateActive) duplicateActiveCount += 1;
        activeByRequestId.set(event.params.requestId, signature);
        activeSignatures.add(signature);
        requests.push({
          ...metadata,
          duplicateActive,
          sequence: requests.length + 1,
          timestamp: Date.now()
        });
        return;
      }
      if (event?.method !== 'Network.loadingFinished' && event?.method !== 'Network.loadingFailed') return;
      const signature = activeByRequestId.get(event.params?.requestId);
      if (!signature) return;
      activeByRequestId.delete(event.params.requestId);
      if (![...activeByRequestId.values()].includes(signature)) activeSignatures.delete(signature);
    },
    snapshot() {
      return {
        activeCount: activeByRequestId.size,
        duplicateActiveCount,
        requests: requests.map(request => ({ ...request }))
      };
    }
  };
}

function classifySimulatorObservations(observations) {
  const events = [];
  const seen = new Set();
  for (const observation of observations ?? []) {
    for (const event of snapshotEvents(observation?.snapshot)) {
      const signature = JSON.stringify(event);
      if (seen.has(signature)) continue;
      seen.add(signature);
      events.push(event);
    }
  }
  return classifySimulatorMetrics({ showsLibrary: { current: null, recentEvents: events } });
}

function runtimeState(snapshot, surface = null) {
  const current = snapshot?.showsLibrary?.current ?? null;
  const heartbeat = snapshot?.lastHeartbeat ?? null;
  const surfaceLabel = String(surface?.routeText || '').trim().toLowerCase();
  const surfaceRoute = [
    ['server', /^server setup$/],
    ['auth', /^sign in$/],
    ['quick-connect', /quick connect/],
    ['home', /^home$/],
    ['movies', /^movies$/],
    ['shows', /^shows$/],
    ['music', /^music$/],
    ['search', /^search$/],
    ['settings', /^settings$/],
    ['diagnostics', /^diagnostics$/],
    ['playback', /^playback$/]
  ].find(([, pattern]) => pattern.test(surfaceLabel))?.[0] ?? null;
  return {
    currentFocusId: surface?.focusedId ?? heartbeat?.currentFocusId ?? null,
    currentRoute: surfaceRoute ?? heartbeat?.currentRoute ?? surface?.routeText ?? null,
    pageInstanceId: snapshot?.page?.pageInstanceId ?? heartbeat?.pageInstanceId ?? null,
    pageLoadCount: snapshot?.page?.pageLoadCount ?? heartbeat?.pageLoadCount ?? null,
    shows: current
  };
}

function isAuthenticatedAppRoute(route) {
  const value = String(route || '').trim();
  return Boolean(value) && !/^(?:auth|server|quick-connect|startup)$/i.test(value);
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(sanitizeSimulatorArtifact(value), null, 2)}\n`);
}

function writeJsonLines(outputPath, values) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, values.map(value => JSON.stringify(
    sanitizeSimulatorArtifact(value)
  )).join('\n') + (values.length ? '\n' : ''));
}

function reserveLocalPort(requestedPort = null) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: requestedPort ?? 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function runPreparation(
  root,
  execute = execFileSync,
  platform = process.platform,
  inheritedEnv = process.env
) {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  execute(npmCommand, ['run', 'package'], {
    cwd: root,
    env: { ...inheritedEnv, PTV_DIAGNOSTICS: '1' },
    stdio: 'inherit',
    windowsHide: true
  });
}

function startSimulator(executable, appDirectory, cdpPort, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const child = spawn(executable, [
    appDirectory,
    '{}',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`
  ], {
    cwd: path.dirname(executable),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  });
  const appendSanitized = data => fs.appendFileSync(logPath, sanitizeString(String(data)));
  child.stdout.on('data', appendSanitized);
  child.stderr.on('data', appendSanitized);
  return child;
}

function activateOwnedSimulatorWindow(child, execute = execFileSync, platform = process.platform) {
  if (platform !== 'win32') return true;
  if (!Number.isInteger(child?.pid) || child.pid < 1) return false;
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PtvOwnedWindow {
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(
    uint sourceThread, uint targetThread, bool attach
  );
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(
    IntPtr hWnd, IntPtr processId
  );
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(
    IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags
  );
}
'@
$handle = [IntPtr]::Zero
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ($handle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
  $owned = Get-Process -Id ${child.pid}
  $handle = $owned.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($handle -eq [IntPtr]::Zero) { exit 2 }
[void][PtvOwnedWindow]::ShowWindowAsync($handle, 9)
[void][PtvOwnedWindow]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate(${child.pid})
$foreground = [PtvOwnedWindow]::GetForegroundWindow()
$currentThread = [PtvOwnedWindow]::GetCurrentThreadId()
$foregroundThread = [PtvOwnedWindow]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$targetThread = [PtvOwnedWindow]::GetWindowThreadProcessId($handle, [IntPtr]::Zero)
$foregroundAttached = $false
$targetAttached = $false
try {
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
    $foregroundAttached = [PtvOwnedWindow]::AttachThreadInput(
      $currentThread, $foregroundThread, $true
    )
  }
  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
    $targetAttached = [PtvOwnedWindow]::AttachThreadInput($currentThread, $targetThread, $true)
  }
  [void][PtvOwnedWindow]::BringWindowToTop($handle)
  [void][PtvOwnedWindow]::SetForegroundWindow($handle)
} finally {
  if ($targetAttached) {
    [void][PtvOwnedWindow]::AttachThreadInput($currentThread, $targetThread, $false)
  }
  if ($foregroundAttached) {
    [void][PtvOwnedWindow]::AttachThreadInput($currentThread, $foregroundThread, $false)
  }
}
Start-Sleep -Milliseconds 100
if ([PtvOwnedWindow]::GetForegroundWindow() -ne $handle) { exit 3 }`;
  try {
    execute('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function localPortIsListening(port, timeoutMs = 300) {
  if (!port) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function stopOwnedSimulator(child, cdpPort, timeoutMs = 8_000) {
  if (!child) {
    return { exitCode: null, pid: null, portClosed: true, processTreeClosed: true };
  }
  const pid = child.pid;
  let processTreeClosed = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        });
        processTreeClosed = true;
      } catch {
        if (!child.kill()) {
          throw new Error(`Could not request shutdown of runner-owned Simulator PID ${pid}.`);
        }
      }
    } else if (!child.kill()) {
      throw new Error(`Could not request shutdown of runner-owned Simulator PID ${pid}.`);
    } else {
      processTreeClosed = true;
    }
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Runner-owned Simulator PID ${pid} did not exit within ${timeoutMs} ms.`);
  }
  if (process.platform !== 'win32') processTreeClosed = true;
  const startedAt = Date.now();
  while (await localPortIsListening(cdpPort)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Runner-owned Simulator PID ${pid} exited but CDP port ${cdpPort} remained open.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return {
    exitCode: child.exitCode,
    pid,
    portClosed: true,
    processTreeClosed,
    signalCode: child.signalCode
  };
}

async function activateSimulatorWindow(shellSession, appSession) {
  try {
    const window = await shellSession.call('Browser.getWindowForTarget');
    if (Number.isInteger(window?.windowId)) {
      const current = await shellSession.call('Browser.getWindowBounds', {
        windowId: window.windowId
      });
      if (current?.bounds?.windowState === 'minimized') {
        await shellSession.call('Browser.setWindowBounds', {
          bounds: { windowState: 'normal' },
          windowId: window.windowId
        });
      }
    }
  } catch {
    // Older Simulator Chromium builds may not expose Browser window controls.
  }
  await shellSession.call('Page.bringToFront');
  await shellSession.evaluate('window.focus(); true').catch(() => null);
  await appSession.call('Page.bringToFront');
  await appSession.evaluate('window.focus(); true').catch(() => null);
}

function deriveShowsRenderWindowStartFromGeometry(
  columnCount,
  hasTopSpacer,
  spacerHeight,
  cardHeight,
  rowGap
) {
  if (!Number.isFinite(columnCount) || columnCount < 1) {
    return { renderWindowStart: null, renderWindowStartSource: 'unknown' };
  }
  if (!hasTopSpacer) {
    return { renderWindowStart: 0, renderWindowStartSource: 'dom-no-top-spacer' };
  }
  if (
    !Number.isFinite(spacerHeight)
    || spacerHeight < 0
    || !Number.isFinite(cardHeight)
    || cardHeight <= 0
    || !Number.isFinite(rowGap)
    || rowGap < 0
  ) return { renderWindowStart: null, renderWindowStartSource: 'unknown' };
  const rowPitch = cardHeight + rowGap;
  const rawStartRow = spacerHeight / rowPitch;
  const startRow = Math.round(rawStartRow);
  if (Math.abs(rawStartRow - startRow) > 0.02) {
    return { renderWindowStart: null, renderWindowStartSource: 'unknown' };
  }
  return {
    renderWindowStart: startRow * columnCount,
    renderWindowStartSource: 'dom-top-spacer'
  };
}

function normalizeAtomicShowsFocusSample(sample) {
  const renderWindowStart = finiteNumber(sample?.renderWindowStart);
  const focusedCardOffset = finiteNumber(sample?.focusedCardOffset);
  const focusOwnerCount = finiteNumber(sample?.focusOwnerCount);
  const columnCount = finiteNumber(sample?.columnCount);
  const renderedCardCount = finiteNumber(sample?.renderedCardCount);
  const scrollTop = finiteNumber(sample?.scrollTop);
  const timestamp = finiteNumber(sample?.timestamp);
  const focusedId = typeof sample?.focusedElement?.focusId === 'string'
    ? sample.focusedElement.focusId
    : null;
  const logicalFocusIdAtSample = typeof sample?.logicalFocusIdAtSample === 'string'
    ? sample.logicalFocusIdAtSample
    : null;
  const logicalNativeFocusAgreement = typeof sample?.logicalNativeFocusAgreement === 'boolean'
    ? sample.logicalNativeFocusAgreement
    : logicalFocusIdAtSample !== null
      && focusedId !== null
      && logicalFocusIdAtSample === focusedId;
  const validWindowStart = Number.isInteger(renderWindowStart) && renderWindowStart >= 0;
  const validOffset = Number.isInteger(focusedCardOffset) && focusedCardOffset >= 0;
  const validColumns = Number.isInteger(columnCount) && columnCount >= 1;
  const validCardCount = Number.isInteger(renderedCardCount) && renderedCardCount >= 1;
  const derivedGlobalFocusedIndex = validWindowStart && validOffset
    ? renderWindowStart + focusedCardOffset
    : null;
  const row = derivedGlobalFocusedIndex !== null && validColumns
    ? Math.floor(derivedGlobalFocusedIndex / columnCount)
    : null;
  const column = derivedGlobalFocusedIndex !== null && validColumns
    ? derivedGlobalFocusedIndex % columnCount
    : null;
  const complete = isShowsCardFocus(focusedId)
    && validWindowStart
    && validOffset
    && derivedGlobalFocusedIndex !== null
    && validColumns
    && renderWindowStart % columnCount === 0
    && row !== null
    && column !== null
    && validCardCount
    && focusedCardOffset < renderedCardCount
    && scrollTop !== null
    && scrollTop >= 0
    && focusOwnerCount === 1
    && sample?.focusedElement?.isConnected === true
    && typeof sample?.pageInstanceId === 'string'
    && sample.pageInstanceId.length > 0
    && timestamp !== null;

  return {
    ...sample,
    column,
    columnCount,
    derivedGlobalFocusedIndex,
    focusedCardOffset,
    focusedId,
    focusOwnerCount,
    logicalFocusIdAtSample,
    logicalNativeFocusAgreement,
    logicalNativeFocusAgreementSource: sample?.logicalNativeFocusAgreementSource ?? (
      logicalNativeFocusAgreement ? 'exact-focus-id' : null
    ),
    renderWindowStart,
    renderedCardCount,
    row,
    scrollTop,
    status: complete ? 'PASS' : 'UNKNOWN',
    timestamp
  };
}

async function readAtomicShowsFocusSample(appSession) {
  try {
    const sample = await appSession.evaluate(`(() => {
      var finite = function (value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return Number.isFinite(number) ? number : null;
      };
      var deriveRenderWindowStart = ${deriveShowsRenderWindowStartFromGeometry.toString()};
      var grid = document.querySelector('.ptv-poster-grid');
      var cards = grid
        ? Array.prototype.slice.call(grid.querySelectorAll('.ptv-card-btn'))
        : [];
      var focusedElement = document.activeElement;
      var focusedCardOffset = cards.indexOf(focusedElement);
      if (focusedCardOffset < 0) focusedCardOffset = null;
      var columnCount = null;
      var gridStyle = null;
      if (grid) {
        gridStyle = window.getComputedStyle(grid);
        var columns = String(gridStyle.gridTemplateColumns || '')
          .split(/\\s+/)
          .filter(Boolean);
        columnCount = columns.length > 0 ? columns.length : null;
      }

      // Derive the live window start from the DOM that owns the focused card.
      // This deliberately does not borrow renderWindowStart from an asynchronously
      // published application diagnostic snapshot.
      var renderWindowStart = null;
      var renderWindowStartSource = 'unknown';
      if (grid && columnCount !== null) {
        var previous = grid.previousElementSibling;
        var hasTopSpacer = Boolean(
          previous
          && previous.classList
          && previous.classList.contains('ptv-shows-window-spacer')
        );
        var cardHeight = cards.length > 0
          ? cards[0].getBoundingClientRect().height
          : null;
        var rowGap = parseFloat(gridStyle.rowGap || gridStyle.gridRowGap || '0');
        if (!Number.isFinite(rowGap)) rowGap = null;
        var spacerHeight = hasTopSpacer
          ? previous.getBoundingClientRect().height
          : 0;
        var derivedWindowStart = deriveRenderWindowStart(
          columnCount,
          hasTopSpacer,
          spacerHeight,
          cardHeight,
          rowGap
        );
        renderWindowStart = derivedWindowStart.renderWindowStart;
        renderWindowStartSource = derivedWindowStart.renderWindowStartSource;
      }

      var diagnosticSnapshot = null;
      try {
        var diagnostic = window.__ptvDiagnosticHealth;
        if (
          diagnostic
          && Object.isFrozen(diagnostic)
          && typeof diagnostic.snapshot === 'function'
        ) diagnosticSnapshot = diagnostic.snapshot();
      } catch (error) {
        diagnosticSnapshot = null;
      }
      var diagnosticCurrent = diagnosticSnapshot
        && diagnosticSnapshot.showsLibrary
        ? diagnosticSnapshot.showsLibrary.current
        : null;
      var diagnosticPage = diagnosticSnapshot ? diagnosticSnapshot.page : null;
      var diagnosticHeartbeat = diagnosticSnapshot ? diagnosticSnapshot.lastHeartbeat : null;
      var pageInstanceId = null;
      try {
        pageInstanceId = window.sessionStorage.getItem(
          'ptv.runtimeDiagnostics.pageInstanceId.v1'
        );
      } catch (error) {
        pageInstanceId = null;
      }
      pageInstanceId = pageInstanceId
        || (diagnosticPage && diagnosticPage.pageInstanceId)
        || (diagnosticHeartbeat && diagnosticHeartbeat.pageInstanceId)
        || null;
      var viewport = document.querySelector('.ptv-browse--shows .ptv-browse__viewport');
      var focusOwners = Array.prototype.slice.call(document.querySelectorAll(
        '[data-focus-id].is-focused, [data-focus-id]:focus'
      ));
      var derivedGlobalFocusedIndex = renderWindowStart !== null
        && focusedCardOffset !== null
        ? renderWindowStart + focusedCardOffset
        : null;
      var row = derivedGlobalFocusedIndex !== null && columnCount !== null && columnCount > 0
        ? Math.floor(derivedGlobalFocusedIndex / columnCount)
        : null;
      var column = derivedGlobalFocusedIndex !== null && columnCount !== null && columnCount > 0
        ? derivedGlobalFocusedIndex % columnCount
        : null;

      return {
        column: column,
        derivedGlobalFocusedIndex: derivedGlobalFocusedIndex,
        focusInteractionAtSample: diagnosticHeartbeat && diagnosticHeartbeat.focusInteraction
          ? diagnosticHeartbeat.focusInteraction
          : null,
        lastFocusTransitionAtSample: diagnosticHeartbeat && diagnosticHeartbeat.lastFocusTransition
          ? diagnosticHeartbeat.lastFocusTransition
          : null,
        logicalFocusIdAtSample: diagnosticHeartbeat
          && typeof diagnosticHeartbeat.currentFocusId === 'string'
          ? diagnosticHeartbeat.currentFocusId
          : null,
        logicalNativeFocusAgreement: (function () {
          var nativeFocusId = focusedElement && focusedElement.getAttribute
            ? focusedElement.getAttribute('data-focus-id')
            : null;
          var logicalFocusId = diagnosticHeartbeat
            && typeof diagnosticHeartbeat.currentFocusId === 'string'
            ? diagnosticHeartbeat.currentFocusId
            : null;
          if (!nativeFocusId || !logicalFocusId) return false;
          if (nativeFocusId === logicalFocusId) return true;
          return /^browse-shows-/i.test(nativeFocusId)
            && /^browse-shows-/i.test(logicalFocusId)
            && diagnosticCurrent
            && finite(diagnosticCurrent.focusedIndex) === derivedGlobalFocusedIndex;
        })(),
        logicalNativeFocusAgreementSource: (function () {
          var nativeFocusId = focusedElement && focusedElement.getAttribute
            ? focusedElement.getAttribute('data-focus-id')
            : null;
          var logicalFocusId = diagnosticHeartbeat
            && typeof diagnosticHeartbeat.currentFocusId === 'string'
            ? diagnosticHeartbeat.currentFocusId
            : null;
          if (nativeFocusId && logicalFocusId && nativeFocusId === logicalFocusId) {
            return 'exact-focus-id';
          }
          if (
            nativeFocusId
            && logicalFocusId
            && /^browse-shows-/i.test(nativeFocusId)
            && /^browse-shows-/i.test(logicalFocusId)
            && diagnosticCurrent
            && finite(diagnosticCurrent.focusedIndex) === derivedGlobalFocusedIndex
          ) return 'diagnostic-index+sanitized-focus-id';
          return null;
        })(),
        diagnosticAtSample: diagnosticCurrent ? {
          columnCount: finite(
            diagnosticCurrent.currentColumns !== null
              && diagnosticCurrent.currentColumns !== undefined
              ? diagnosticCurrent.currentColumns
              : diagnosticCurrent.columns
          ),
          focusedIndex: finite(diagnosticCurrent.focusedIndex),
          pageInstanceId: diagnosticCurrent.pageInstanceId || pageInstanceId,
          renderWindowStart: finite(
            diagnosticCurrent.renderWindowStart !== null
              && diagnosticCurrent.renderWindowStart !== undefined
              ? diagnosticCurrent.renderWindowStart
              : diagnosticCurrent.startIndex
          ),
          renderedCardCount: finite(diagnosticCurrent.renderedCardCount),
          scrollTop: finite(diagnosticCurrent.scrollTop)
        } : null,
        focusOwnerCount: focusOwners.length,
        focusOwnerIds: focusOwners.map(function (owner) {
          return owner.getAttribute('data-focus-id');
        }).filter(Boolean),
        focusedCardOffset: focusedCardOffset,
        focusedElement: focusedElement ? {
          className: typeof focusedElement.className === 'string'
            ? focusedElement.className.slice(0, 256)
            : null,
          focusId: focusedElement.getAttribute
            ? focusedElement.getAttribute('data-focus-id')
            : null,
          isConnected: focusedElement.isConnected !== false,
          tagName: focusedElement.tagName || null
        } : null,
        columnCount: columnCount,
        pageInstanceId: pageInstanceId,
        renderWindowStart: renderWindowStart,
        renderWindowStartSource: renderWindowStartSource,
        renderedCardCount: cards.length,
        row: row,
        scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
        timestamp: Date.now()
      };
    })()`);
    return normalizeAtomicShowsFocusSample(sample ?? {});
  } catch {
    return normalizeAtomicShowsFocusSample({
      reason: 'atomic-runtime-evaluation-failed'
    });
  }
}

function compareAtomicFocusWithDiagnostics(atomicFocus, diagnostics) {
  const diagnostic = diagnostics ?? null;
  const pairs = [
    [
      'focusedIndex',
      finiteNumber(atomicFocus?.derivedGlobalFocusedIndex),
      finiteNumber(diagnostic?.focusedIndex)
    ],
    [
      'renderWindowStart',
      finiteNumber(atomicFocus?.renderWindowStart),
      finiteNumber(diagnostic?.renderWindowStart)
    ],
    [
      'renderedCardCount',
      finiteNumber(atomicFocus?.renderedCardCount),
      finiteNumber(diagnostic?.renderedCardCount)
    ],
    ['columnCount', finiteNumber(atomicFocus?.columnCount), finiteNumber(diagnostic?.columnCount)],
    ['scrollTop', finiteNumber(atomicFocus?.scrollTop), finiteNumber(diagnostic?.scrollTop)],
    ['pageInstanceId', atomicFocus?.pageInstanceId ?? null, diagnostic?.pageInstanceId ?? null]
  ];
  const differences = pairs
    .filter(([, atomic, diagnosticValue]) => (
      atomic !== null
      && diagnosticValue !== null
      && atomic !== diagnosticValue
    ))
    .map(([field, atomic, diagnosticValue]) => ({
      atomic,
      diagnostic: diagnosticValue,
      field
    }));
  const hasMissingRequiredPair = atomicFocus?.status !== 'PASS'
    || pairs.some(([, atomic, diagnosticValue]) => atomic === null || diagnosticValue === null);
  return {
    differences,
    status: hasMissingRequiredPair
      ? 'UNKNOWN'
      : differences.length ? 'DISAGREE' : 'AGREE'
  };
}

function directionalAtomicSamples(observation) {
  const nestedEvidence = ['before', 'after']
    .filter(key => Object.prototype.hasOwnProperty.call(observation ?? {}, key));
  const samples = [];
  if (Object.prototype.hasOwnProperty.call(observation ?? {}, 'atomicFocus')) {
    samples.push(observation.atomicFocus ?? null);
  }
  for (const key of nestedEvidence) {
    samples.push(observation?.[key]?.atomicFocus ?? null);
  }
  return samples.length > 0 ? samples : [null];
}

function summarizeAtomicFocusSampling(observations) {
  const directionalKinds = new Set([
    'boundary-crossing', 'boundary-failure', 'boundary-setup',
    'down', 'up', 'endurance', 'endurance-failure', 'directional-failure'
  ]);
  const directional = (observations ?? []).filter(observation => (
    directionalKinds.has(observation?.kind)
  ));
  const comparisons = [];
  for (const observation of directional) {
    const evidenceSources = [
      ['observation', observation],
      ['before', observation?.before],
      ['after', observation?.after]
    ];
    for (const [evidenceSource, evidence] of evidenceSources) {
      for (const [diagnosticSource, comparison] of Object.entries(
        evidence?.focusDiagnosticComparison ?? {}
      )) {
        if (!comparison || typeof comparison !== 'object') continue;
        comparisons.push({
          cycle: observation?.cycle ?? null,
          differences: comparison.differences ?? [],
          evidenceSource,
          kind: observation?.kind ?? null,
          phase: observation?.phase ?? null,
          source: diagnosticSource,
          status: comparison.status ?? 'UNKNOWN'
        });
      }
    }
  }
  const disagreements = comparisons.filter(comparison => comparison.status === 'DISAGREE');
  const unknownComparisons = comparisons.filter(comparison => comparison.status === 'UNKNOWN');
  const unknownDirectionalSamples = directional.filter(observation => (
    directionalAtomicSamples(observation).some(sample => sample?.status !== 'PASS')
  )).length;
  return {
    diagnosticComparisonStatus: disagreements.length > 0
      ? 'DISAGREE'
      : comparisons.length === 0 || unknownComparisons.length > 0 ? 'UNKNOWN' : 'AGREE',
    diagnosticDisagreementCount: disagreements.length,
    directionalSampleCount: directional.length,
    recentDiagnosticDisagreements: disagreements.slice(-20),
    status: directional.length > 0 && unknownDirectionalSamples === 0 ? 'PASS' : 'UNKNOWN',
    unknownDirectionalSampleCount: unknownDirectionalSamples
  };
}

function diagnosticStateForFocusComparison(snapshot) {
  const current = snapshot?.showsLibrary?.current;
  if (!current) return null;
  return {
    columnCount: finiteNumber(current.currentColumns ?? current.columns),
    focusedIndex: finiteNumber(current.focusedIndex),
    pageInstanceId: current.pageInstanceId
      ?? snapshot?.page?.pageInstanceId
      ?? snapshot?.lastHeartbeat?.pageInstanceId
      ?? null,
    renderWindowStart: finiteNumber(current.renderWindowStart ?? current.startIndex),
    renderedCardCount: finiteNumber(current.renderedCardCount),
    scrollTop: finiteNumber(current.scrollTop)
  };
}

async function pollEvidence(appSession, predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let last = { snapshot: null, surface: null };
  while (Date.now() - startedAt < timeoutMs) {
    const [snapshot, surface] = await Promise.all([
      readDiagnosticSnapshot(appSession).catch(() => null),
      readAppSurface(appSession).catch(() => null)
    ]);
    last = { snapshot, surface };
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return last;
}

async function readEvidence(appSession) {
  const [snapshot, surface, atomicFocus] = await Promise.all([
    readDiagnosticSnapshot(appSession).catch(() => null),
    readAppSurface(appSession),
    readAtomicShowsFocusSample(appSession)
  ]);
  return {
    atomicFocus,
    focusDiagnosticComparison: {
      atAtomicSample: compareAtomicFocusWithDiagnostics(
        atomicFocus,
        atomicFocus?.diagnosticAtSample
      ),
      separatelySampled: compareAtomicFocusWithDiagnostics(
        atomicFocus,
        diagnosticStateForFocusComparison(snapshot)
      )
    },
    snapshot,
    surface,
    state: runtimeState(snapshot, surface)
  };
}

function showsFocusPosition(evidence) {
  if (Object.prototype.hasOwnProperty.call(evidence ?? {}, 'atomicFocus')) {
    const atomicFocus = evidence?.atomicFocus;
    if (atomicFocus?.status !== 'PASS' || !isShowsCardFocus(atomicFocus.focusedId)) return null;
    const columns = finiteNumber(atomicFocus.columnCount);
    const index = finiteNumber(atomicFocus.derivedGlobalFocusedIndex);
    const row = finiteNumber(atomicFocus.row);
    const column = finiteNumber(atomicFocus.column);
    if (columns === null || index === null || row === null || column === null) return null;
    return { column, columns, index, row };
  }
  const state = evidence?.state ?? runtimeState(evidence?.snapshot, evidence?.surface);
  if (!isShowsCardFocus(state.currentFocusId)) return null;
  const renderWindowStart = finiteNumber(state.shows?.renderWindowStart);
  const focusedCardOffset = finiteNumber(evidence?.surface?.focusedCardOffset);
  const columns = finiteNumber(state.shows?.currentColumns ?? evidence?.surface?.gridColumns);
  if (
    renderWindowStart === null
    || focusedCardOffset === null
    || columns === null
    || columns < 1
  ) return null;
  const index = renderWindowStart + focusedCardOffset;
  return {
    column: index % columns,
    columns,
    index,
    row: Math.floor(index / columns)
  };
}

function showsRowDelta(before, after) {
  const beforePosition = showsFocusPosition(before);
  const afterPosition = showsFocusPosition(after);
  if (!beforePosition || !afterPosition || beforePosition.columns !== afterPosition.columns) {
    return null;
  }
  if (beforePosition.column !== afterPosition.column) return null;
  return afterPosition.row - beforePosition.row;
}

async function readStableShowsEvidence(appSession, timeoutMs = 2_000) {
  const startedAt = Date.now();
  let last = null;
  let previousSignature = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readEvidence(appSession);
    const position = showsFocusPosition(last);
    if (!position) {
      if (
        !/shows/i.test(String(last.state.currentRoute || ''))
        || KNOWN_FILTER_FOCUS.includes(last.state.currentFocusId)
        || KNOWN_SHELL_FOCUS.includes(last.state.currentFocusId)
      ) return last;
      previousSignature = null;
    } else {
      const signature = JSON.stringify({
        columns: position.columns,
        focus: last.atomicFocus?.focusedId ?? last.state.currentFocusId,
        hasMore: last.state.shows?.hasMore,
        index: position.index,
        metadata: finiteNumber(last.state.shows?.metadataCount),
        offset: finiteNumber(last.atomicFocus?.focusedCardOffset),
        start: finiteNumber(last.atomicFocus?.renderWindowStart)
      });
      if (signature === previousSignature) return last;
      previousSignature = signature;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return last ?? readEvidence(appSession);
}

async function sendDpadKey(appSession, rcuSession, key, options = {}) {
  if (options.viaVirtualRcu) {
    return pressRcuKey(rcuSession, key, options);
  }
  return dispatchDpadKey(appSession, key, options);
}

function compareExactDirectionalStep(beforePosition, afterPosition, key) {
  if (!beforePosition || !afterPosition || beforePosition.columns !== afterPosition.columns) {
    return { ok: false, reason: 'missing-or-incompatible-position' };
  }
  const columns = beforePosition.columns;
  const expected = {
    ArrowDown: {
      column: beforePosition.column,
      index: beforePosition.index + columns,
      row: beforePosition.row + 1
    },
    ArrowLeft: {
      column: beforePosition.column - 1,
      index: beforePosition.index - 1,
      row: beforePosition.row
    },
    ArrowRight: {
      column: beforePosition.column + 1,
      index: beforePosition.index + 1,
      row: beforePosition.row
    },
    ArrowUp: {
      column: beforePosition.column,
      index: beforePosition.index - columns,
      row: beforePosition.row - 1
    }
  }[key];
  if (!expected || expected.column < 0 || expected.column >= columns || expected.row < 0) {
    return { ok: false, reason: 'directional-boundary' };
  }
  const actual = {
    column: afterPosition.column,
    index: afterPosition.index,
    row: afterPosition.row
  };
  return {
    actual,
    expected,
    ok: actual.column === expected.column
      && actual.index === expected.index
      && actual.row === expected.row,
    reason: null
  };
}

function showsBoundaryTraversalSteps() {
  const targetIndices = [
    ...SHOWS_BOUNDARY_PATH.slice(1),
    ...SHOWS_BOUNDARY_PATH.slice(0, -1).reverse()
  ];
  let previousIndex = SHOWS_BOUNDARY_PATH[0];
  return targetIndices.map(index => {
    const step = {
      column: index % 8,
      index,
      key: index > previousIndex ? 'ArrowDown' : 'ArrowUp',
      renderBoundary: previousIndex === 568 && index === 576
        ? '512-to-520'
        : previousIndex === 576 && index === 568
          ? '520-to-512'
          : null,
      row: Math.floor(index / 8)
    };
    previousIndex = index;
    return step;
  });
}

function validateBoundaryAtomicStep(
  evidence,
  expected,
  pageInstanceId,
  beforePosition = null,
  key = null
) {
  const atomic = evidence?.atomicFocus ?? null;
  const position = showsFocusPosition(evidence);
  const interaction = atomic?.focusInteractionAtSample;
  const missing = [];
  if (!atomic || typeof atomic !== 'object') missing.push('atomicFocus');
  if (!position) missing.push('atomicPosition');
  if (finiteNumber(atomic?.focusOwnerCount) === null) missing.push('focusOwnerCount');
  if (finiteNumber(atomic?.focusedCardOffset) === null) missing.push('focusedCardOffset');
  if (finiteNumber(atomic?.renderedCardCount) === null) missing.push('renderedCardCount');
  if (typeof atomic?.focusedId !== 'string') missing.push('nativeFocusId');
  if (typeof atomic?.logicalFocusIdAtSample !== 'string') missing.push('logicalFocusId');
  if (typeof atomic?.focusedElement?.isConnected !== 'boolean') missing.push('targetConnection');
  if (!interaction || typeof interaction.mode !== 'string') missing.push('interactionMode');
  if (typeof atomic?.pageInstanceId !== 'string') missing.push('pageInstanceId');
  const stepComparison = beforePosition && key
    ? compareExactDirectionalStep(beforePosition, position, key)
    : null;
  const checks = {
    atomicSampleComplete: atomic?.status === 'PASS',
    exactDirectionalStep: stepComparison ? stepComparison.ok === true : true,
    expectedColumn: position?.column === expected.column,
    expectedGlobalIndex: position?.index === expected.index,
    expectedRow: position?.row === expected.row,
    focusOwnerOne: atomic?.focusOwnerCount === 1,
    logicalNativeIdAgreement: atomic?.logicalNativeFocusAgreement === true,
    noFilterOrHeaderFocus: isShowsCardFocus(atomic?.focusedId),
    pageInstanceUnchanged: typeof pageInstanceId === 'string'
      && pageInstanceId.length > 0
      && atomic?.pageInstanceId === pageInstanceId,
    remoteInteraction: interaction?.mode === 'remote',
    targetMounted: atomic?.focusedElement?.isConnected === true
      && Number.isInteger(atomic?.focusedCardOffset)
      && atomic.focusedCardOffset >= 0
      && atomic.focusedCardOffset < atomic?.renderedCardCount
  };
  return {
    checks,
    missing,
    position,
    status: missing.length > 0
      ? 'UNKNOWN'
      : Object.values(checks).every(passed => passed === true) ? 'PASS' : 'FAIL',
    stepComparison
  };
}

function attachBoundaryCrossingProgress(error, currentProgress) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const existing = failure.boundaryProgress && typeof failure.boundaryProgress === 'object'
    ? failure.boundaryProgress
    : {};
  failure.boundaryProgress = { ...currentProgress, ...existing };
  return failure;
}

async function runShowsBoundaryCrossingGate(
  appSession,
  rcuSession,
  requestedCrossings,
  observations,
  inputOptions = {}
) {
  const readStable = typeof inputOptions.readStableEvidence === 'function'
    ? inputOptions.readStableEvidence
    : readStableShowsEvidence;
  const sendKey = typeof inputOptions.sendKey === 'function'
    ? inputOptions.sendKey
    : sendDpadKey;
  const dpadInputOptions = { ...inputOptions };
  delete dpadInputOptions.readStableEvidence;
  delete dpadInputOptions.sendKey;
  const result = {
    completedCrossings: 0,
    completedExactKeySteps: 0,
    cyclesCompleted: 0,
    failureCount: 0,
    focusDriftFailures: 0,
    logicalNativeDisagreementCount: 0,
    pageInstanceId: null,
    recentSteps: [],
    renderBoundaryBackwardCrossings: 0,
    renderBoundaryCrossings: 0,
    renderBoundaryForwardCrossings: 0,
    requestedCrossings,
    setupSteps: 0,
    status: 'UNKNOWN',
    stoppedReason: null
  };
  let evidence = null;
  let failureContext = { failedPhase: 'activation' };
  const progress = extra => ({ ...result, ...(extra ?? {}) });
  const recordRecentStep = step => {
    result.recentSteps.push(step);
    if (result.recentSteps.length > 50) result.recentSteps.shift();
  };

  try {
    if (!Number.isInteger(requestedCrossings) || requestedCrossings < 1) {
      throw new Error('Boundary crossing gate requires at least one requested crossing.');
    }
    if (
      typeof inputOptions.reactivate === 'function'
      && !await inputOptions.reactivate()
    ) throw new Error('Simulator window could not be activated before boundary crossing stress.');
    failureContext = { failedPhase: 'initial-sample' };
    evidence = await readStable(appSession);
    let position = showsFocusPosition(evidence);
    result.pageInstanceId = evidence?.atomicFocus?.pageInstanceId ?? null;
    if (!position) throw new Error('Boundary crossing stress requires initial Shows card focus.');
    const initialValidation = validateBoundaryAtomicStep(
      evidence,
      position,
      result.pageInstanceId
    );
    if (initialValidation.status !== 'PASS') {
      throw new Error('Boundary crossing stress initial atomic focus evidence was incomplete.');
    }

    const performStep = async (key, expected, phase, renderBoundary = null) => {
      const before = evidence;
      const beforePosition = showsFocusPosition(before);
      const beforeRenderWindowStart = finiteNumber(before?.atomicFocus?.renderWindowStart);
      failureContext = {
        expected,
        failedInputSequence: [key],
        failedPhase: phase
      };
      await sendKey(appSession, rcuSession, key, {
        ...dpadInputOptions,
        holdMs: 40,
        settleMs: 50
      });
      const after = await readStable(appSession);
      const validation = validateBoundaryAtomicStep(
        after,
        expected,
        result.pageInstanceId,
        beforePosition,
        key
      );
      const afterRenderWindowStart = finiteNumber(after?.atomicFocus?.renderWindowStart);
      const expectedRenderBoundary = renderBoundary === '512-to-520'
        ? beforeRenderWindowStart === 512 && afterRenderWindowStart === 520
        : renderBoundary === '520-to-512'
          ? beforeRenderWindowStart === 520 && afterRenderWindowStart === 512
          : true;
      const compactStep = {
        actual: validation.position,
        afterRenderWindowStart,
        beforeRenderWindowStart,
        expected,
        key,
        phase,
        renderBoundary,
        status: validation.status
      };
      recordRecentStep(compactStep);
      if (validation.status !== 'PASS' || !expectedRenderBoundary) {
        result.failureCount += 1;
        if (validation.status !== 'PASS') result.focusDriftFailures += 1;
        if (validation.checks.logicalNativeIdAgreement !== true) {
          result.logicalNativeDisagreementCount += 1;
        }
        result.stoppedReason = validation.status !== 'PASS'
          ? `atomic focus ${validation.status.toLowerCase()}`
          : `render boundary ${renderBoundary} was not observed`;
        failureContext = {
          ...failureContext,
          actual: validation.position,
          atomicStatus: validation.status,
          missing: validation.missing,
          renderBoundaryObserved: expectedRenderBoundary
        };
        observations.push({
          after,
          before,
          expected,
          inputSequence: [key],
          kind: 'boundary-failure',
          phase,
          renderBoundary,
          validation
        });
        throw new Error('Shows boundary crossing step did not match strict atomic expectations.');
      }
      observations.push({
        atomicFocus: after.atomicFocus,
        expected,
        focusDiagnosticComparison: after.focusDiagnosticComparison,
        inputSequence: [key],
        kind: phase === 'setup' ? 'boundary-setup' : 'boundary-crossing',
        phase,
        renderBoundary,
        validation
      });
      evidence = after;
      return validation.position;
    };

    while (position.column > 0) {
      if (result.setupSteps >= 200) throw new Error('Boundary crossing setup exceeded its step limit.');
      position = await performStep('ArrowLeft', {
        column: position.column - 1,
        index: position.index - 1,
        row: position.row
      }, 'setup');
      result.setupSteps += 1;
    }
    while (position.index !== SHOWS_BOUNDARY_PATH[0]) {
      if (result.setupSteps >= 200) throw new Error('Boundary crossing setup exceeded its step limit.');
      const key = position.index > SHOWS_BOUNDARY_PATH[0] ? 'ArrowUp' : 'ArrowDown';
      const index = position.index + (key === 'ArrowUp' ? -position.columns : position.columns);
      position = await performStep(key, {
        column: 0,
        index,
        row: Math.floor(index / position.columns)
      }, 'setup');
      result.setupSteps += 1;
    }

    const traversalSteps = showsBoundaryTraversalSteps();
    while (result.renderBoundaryCrossings < requestedCrossings) {
      for (const step of traversalSteps) {
        position = await performStep(
          step.key,
          { column: step.column, index: step.index, row: step.row },
          'path',
          step.renderBoundary
        );
        result.completedExactKeySteps += 1;
        if (step.renderBoundary) {
          result.renderBoundaryCrossings += 1;
          result.completedCrossings = result.renderBoundaryCrossings;
          if (step.renderBoundary === '512-to-520') {
            result.renderBoundaryForwardCrossings += 1;
          } else {
            result.renderBoundaryBackwardCrossings += 1;
          }
        }
      }
      result.cyclesCompleted += 1;
    }
    result.status = 'PASS';
    result.stoppedReason = 'requested crossings completed';
    return progress({ finalIndex: position.index });
  } catch (error) {
    if (result.failureCount === 0) result.failureCount = 1;
    result.status = 'FAIL';
    result.stoppedReason = result.stoppedReason ?? (error instanceof Error
      ? error.message
      : String(error));
    throw attachBoundaryCrossingProgress(error, progress(failureContext));
  }
}

async function findParkedPointerTarget(appSession, jitter = 0) {
  return appSession.evaluate(`(() => {
    var grid = document.querySelector('.ptv-poster-grid');
    if (!grid) return null;
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.ptv-card-btn'));
    var focused = document.activeElement;
    var focusedOffset = cards.indexOf(focused);
    if (focusedOffset < 0) return null;
    var style = window.getComputedStyle(grid);
    var columns = String(style.gridTemplateColumns || '')
      .split(/\\s+/)
      .filter(Boolean).length;
    if (!columns) return null;
    var currentColumn = focusedOffset % columns;
    var rowStart = focusedOffset - currentColumn;
    var delta = currentColumn + 2 < columns && cards[rowStart + currentColumn + 2]
      ? 2
      : currentColumn - 2 >= 0 && cards[rowStart + currentColumn - 2]
        ? -2
        : null;
    if (delta === null) return null;
    var target = cards[focusedOffset + delta];
    var rect = target.getBoundingClientRect();
    return {
      delta: delta,
      focusId: target.getAttribute('data-focus-id'),
      x: rect.left + rect.width / 2 + ${Number(jitter) || 0},
      y: rect.top + rect.height / 2
    };
  })()`);
}

function pointerMoveCoordinates(point, previousPointer = null) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('A valid Shows pointer target was not available.');
  }
  let baselineX = point.x - 3;
  if (
    finiteNumber(previousPointer?.lastPointerX) === baselineX
    && finiteNumber(previousPointer?.lastPointerY) === point.y
  ) baselineX = point.x - 6;
  return [
    { x: baselineX, y: point.y },
    { x: point.x, y: point.y }
  ];
}

async function dispatchPointerCoordinate(appSession, coordinate, settleMs = 120) {
  await appSession.call('Input.dispatchMouseEvent', {
    button: 'none',
    buttons: 0,
    type: 'mouseMoved',
    x: coordinate.x,
    y: coordinate.y
  });
  await new Promise(resolve => setTimeout(resolve, settleMs));
}

async function dispatchPointerMove(appSession, point, settleMs = 120, previousPointer = null) {
  const coordinates = pointerMoveCoordinates(point, previousPointer);
  for (const coordinate of coordinates) {
    await dispatchPointerCoordinate(appSession, coordinate, 0);
  }
  await new Promise(resolve => setTimeout(resolve, settleMs));
  return coordinates;
}

function pointerOwnershipState(evidence) {
  const interaction = evidence?.atomicFocus?.focusInteractionAtSample;
  if (!interaction || typeof interaction !== 'object') return null;
  return {
    lastPointerMotionTimestamp: finiteNumber(interaction.lastPointerMotionTimestamp),
    lastPointerX: finiteNumber(interaction.lastPointerX),
    lastPointerY: finiteNumber(interaction.lastPointerY),
    mode: interaction.mode === 'remote' || interaction.mode === 'pointer'
      ? interaction.mode
      : null,
    pointerBaselinePending: typeof interaction.pointerBaselinePending === 'boolean'
      ? interaction.pointerBaselinePending
      : null
  };
}

function pointerOwnershipTransitionMatches(evidence, expected) {
  if (evidence?.atomicFocus?.status !== 'PASS') return false;
  const state = pointerOwnershipState(evidence);
  if (!state) return false;
  if (state.mode !== expected.mode
    || state.pointerBaselinePending !== expected.pointerBaselinePending) return false;
  if (expected.coordinate) {
    return state.lastPointerX === expected.coordinate.x
      && state.lastPointerY === expected.coordinate.y
      && state.lastPointerMotionTimestamp !== null;
  }
  return true;
}

async function readStablePointerOwnershipEvidence(appSession, expected, timeoutMs = 2_000) {
  const startedAt = Date.now();
  let last = null;
  let previousSignature = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readEvidence(appSession);
    if (pointerOwnershipTransitionMatches(last, expected)) {
      const position = showsFocusPosition(last);
      const signature = JSON.stringify({
        focus: last.atomicFocus?.focusedId ?? null,
        index: position?.index ?? null,
        ownership: pointerOwnershipState(last),
        start: finiteNumber(last.atomicFocus?.renderWindowStart)
      });
      if (signature === previousSignature) return last;
      previousSignature = signature;
    } else {
      previousSignature = null;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return last ?? readEvidence(appSession);
}

async function exercisePointerOwnership(
  appSession,
  rcuSession,
  observations,
  cycle,
  inputOptions,
  jitter
) {
  const before = await readStableShowsEvidence(appSession);
  const beforePosition = showsFocusPosition(before);
  if (!beforePosition) throw new Error('Pointer ownership stress requires Shows card focus.');
  if (!pointerOwnershipTransitionMatches(before, {
    mode: 'remote',
    pointerBaselinePending: true
  })) {
    throw new Error('Pointer ownership stress did not begin in pending-baseline remote mode.');
  }
  const target = await findParkedPointerTarget(appSession, jitter);
  if (!target || Math.abs(target.delta) !== 2) {
    throw new Error('Pointer ownership stress could not find a card two columns away.');
  }
  const pointerCoordinates = pointerMoveCoordinates(
    target,
    before.atomicFocus?.focusInteractionAtSample
  );
  await dispatchPointerCoordinate(appSession, pointerCoordinates[0], 60);
  const afterBaseline = await readStablePointerOwnershipEvidence(appSession, {
    coordinate: pointerCoordinates[0],
    mode: 'remote',
    pointerBaselinePending: false
  });
  const afterBaselinePosition = showsFocusPosition(afterBaseline);
  if (
    !afterBaselinePosition
    || afterBaselinePosition.index !== beforePosition.index
    || afterBaselinePosition.column !== beforePosition.column
    || afterBaselinePosition.row !== beforePosition.row
    || afterBaseline.atomicFocus?.focusOwnerCount !== 1
    || !pointerOwnershipTransitionMatches(afterBaseline, {
      coordinate: pointerCoordinates[0],
      mode: 'remote',
      pointerBaselinePending: false
    })
  ) {
    observations.push({
      after: afterBaseline,
      before,
      cycle,
      inputSequence: ['mouseMoved'],
      kind: 'endurance-failure',
      phase: 'pointer-baseline',
      pointerCoordinates,
      pointerTarget: target
    });
    throw new Error('The first post-DPAD pointer coordinate stole Shows focus.');
  }
  await dispatchPointerCoordinate(appSession, pointerCoordinates[1], 120);
  let current = await readStablePointerOwnershipEvidence(appSession, {
    coordinate: pointerCoordinates[1],
    mode: 'pointer',
    pointerBaselinePending: false
  });
  let currentPosition = showsFocusPosition(current);
  const expectedPointerIndex = beforePosition.index + target.delta;
  if (
    !currentPosition
    || currentPosition.index !== expectedPointerIndex
    || currentPosition.column !== beforePosition.column + target.delta
    || currentPosition.row !== beforePosition.row
    || current.atomicFocus?.focusOwnerCount !== 1
    || !pointerOwnershipTransitionMatches(current, {
      coordinate: pointerCoordinates[1],
      mode: 'pointer',
      pointerBaselinePending: false
    })
  ) {
    observations.push({
      after: current,
      before,
      cycle,
      inputSequence: ['mouseMoved', 'mouseMoved'],
      kind: 'endurance-failure',
      phase: 'pointer-reactivation',
      pointerCoordinates,
      pointerTarget: target
    });
    throw new Error('Genuine pointer movement did not take one-owner focus two columns away.');
  }
  const afterPointer = current;

  const returnKey = target.delta > 0 ? 'ArrowLeft' : 'ArrowRight';
  for (let step = 0; step < Math.abs(target.delta); step += 1) {
    const stepBefore = current;
    const stepBeforePosition = currentPosition;
    await sendDpadKey(appSession, rcuSession, returnKey, {
      ...inputOptions,
      holdMs: 40,
      settleMs: 50
    });
    current = await readStablePointerOwnershipEvidence(appSession, {
      mode: 'remote',
      pointerBaselinePending: true
    });
    currentPosition = showsFocusPosition(current);
    const comparison = compareExactDirectionalStep(
      stepBeforePosition,
      currentPosition,
      returnKey
    );
    const returnedToRemote = pointerOwnershipTransitionMatches(current, {
      mode: 'remote',
      pointerBaselinePending: true
    });
    if (!comparison.ok || current.atomicFocus?.focusOwnerCount !== 1 || !returnedToRemote) {
      observations.push({
        after: current,
        before: stepBefore,
        cycle,
        inputSequence: [returnKey],
        kind: 'endurance-failure',
        phase: 'pointer-to-remote',
        pointerTarget: target,
        stepComparison: comparison
      });
      throw new Error('DPAD did not immediately reclaim focus from pointer mode.');
    }
  }
  if (!currentPosition || currentPosition.index !== beforePosition.index) {
    throw new Error('Pointer-to-DPAD ownership stress did not restore the original card.');
  }
  return {
    evidence: current,
    ownershipStates: {
      afterBaseline: pointerOwnershipState(afterBaseline),
      afterPointer: pointerOwnershipState(afterPointer),
      before: pointerOwnershipState(before),
      afterRemote: pointerOwnershipState(current)
    },
    pointerFocusIndex: expectedPointerIndex,
    returnFocusIndex: currentPosition.index,
    targetColumnDelta: target.delta
  };
}

async function navigateBetweenKnownFocus(
  appSession,
  rcuSession,
  targetFocus,
  knownFocus,
  inputOptions = {}
) {
  for (let attempt = 0; attempt < knownFocus.length + 3; attempt += 1) {
    const evidence = await readEvidence(appSession);
    const current = evidence.state.currentFocusId;
    if (current === targetFocus) return evidence;
    const currentIndex = knownFocus.indexOf(current);
    const targetIndex = knownFocus.indexOf(targetFocus);
    if (currentIndex < 0 || targetIndex < 0) return null;
    await sendDpadKey(
      appSession,
      rcuSession,
      targetIndex > currentIndex ? 'ArrowRight' : 'ArrowLeft',
      inputOptions
    );
  }
  return null;
}

async function moveFocusToShell(appSession, rcuSession, inputOptions = {}) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const evidence = await readEvidence(appSession);
    if (KNOWN_SHELL_FOCUS.includes(evidence.state.currentFocusId)) return evidence;
    await sendDpadKey(appSession, rcuSession, 'ArrowUp', inputOptions);
  }
  return null;
}

async function navigateToShows(appSession, rcuSession, inputOptions = {}) {
  const shellEvidence = await moveFocusToShell(appSession, rcuSession, inputOptions);
  if (!shellEvidence) return false;
  const targetEvidence = await navigateBetweenKnownFocus(
    appSession,
    rcuSession,
    'shell-shows',
    KNOWN_SHELL_FOCUS,
    inputOptions
  );
  if (!targetEvidence) return false;
  await sendDpadKey(appSession, rcuSession, 'Enter', inputOptions);
  const result = await pollEvidence(appSession, evidence => /shows/i.test(
    String(runtimeState(evidence.snapshot, evidence.surface).currentRoute || '')
  ), 15_000);
  return /shows/i.test(String(runtimeState(result.snapshot, result.surface).currentRoute || ''));
}

function filterNavigationKey(evidence) {
  const focus = evidence?.state?.currentFocusId;
  if (KNOWN_SHELL_FOCUS.includes(focus)) return 'ArrowDown';
  if (isShowsCardFocus(focus)) {
    const position = showsFocusPosition(evidence);
    if (position && position.index % position.columns > 0) return 'ArrowLeft';
  }
  return 'ArrowUp';
}

async function moveFocusToFilters(appSession, rcuSession, inputOptions = {}) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const evidence = await readEvidence(appSession);
    const focus = evidence.state.currentFocusId;
    if (KNOWN_FILTER_FOCUS.includes(focus)) return evidence;
    await sendDpadKey(
      appSession,
      rcuSession,
      filterNavigationKey(evidence),
      inputOptions
    );
  }
  return null;
}

function showsFilterSettled(evidence, targetFocus) {
  const surface = evidence?.surface;
  if (
    !surface
    || surface.selectedFilterId !== targetFocus
    || surface.showsBusy !== false
    || surface.showsError === true
  ) return false;
  return targetFocus === 'browse-filter-favorites' || surface.cardCount > 0;
}

async function selectFilter(appSession, rcuSession, targetFocus, inputOptions = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const filterEvidence = await moveFocusToFilters(appSession, rcuSession, inputOptions);
    if (filterEvidence) {
      const targetEvidence = await navigateBetweenKnownFocus(
        appSession,
        rcuSession,
        targetFocus,
        KNOWN_FILTER_FOCUS,
        inputOptions
      );
      if (targetEvidence) {
        await sendDpadKey(appSession, rcuSession, 'Enter', inputOptions);
        const settled = await pollEvidence(
          appSession,
          evidence => showsFilterSettled(evidence, targetFocus),
          45_000
        );
        if (showsFilterSettled(settled, targetFocus)) return true;
      }
    }
    if (typeof inputOptions.reactivate === 'function') await inputOptions.reactivate();
  }
  return false;
}

function seriousViolations(classification) {
  return classification.violations.filter(code => [
    'RENDER_WINDOW_LIMIT',
    'ARTWORK_CONCURRENCY_LIMIT',
    'FOCUS_OUTSIDE_WINDOW',
    'FOCUS_OWNER_COUNT',
    'DUPLICATE_METADATA_REQUEST'
  ].includes(code));
}

function isShowsCardFocus(value) {
  return typeof value === 'string' && value.startsWith('browse-shows-');
}

function showsLibraryEndReached(evidence) {
  const state = evidence?.state ?? runtimeState(evidence?.snapshot, evidence?.surface);
  const shows = state.shows;
  const metadataCount = finiteNumber(shows?.metadataCount);
  const position = showsFocusPosition(evidence);
  if (
    shows?.hasMore !== false
    || metadataCount === null
    || metadataCount < 1
    || !position
  ) return false;
  const finalRowStart = Math.floor((metadataCount - 1) / position.columns) * position.columns;
  return position.index >= finalRowStart;
}

async function moveDownOneShowsRow(appSession, rcuSession, inputOptions = {}) {
  let before = await readStableShowsEvidence(appSession);
  if (
    before.surface?.documentVisibility !== 'visible'
    && typeof inputOptions.reactivate === 'function'
  ) {
    await inputOptions.reactivate();
    before = await readStableShowsEvidence(appSession);
  }
  const beforePosition = showsFocusPosition(before);
  const beforeWasFilter = KNOWN_FILTER_FOCUS.includes(before.state.currentFocusId);
  if (!beforeWasFilter && !beforePosition) {
    return { atEnd: false, before, evidence: before, moved: false };
  }
  const beforeMetadata = finiteNumber(before.state.shows?.metadataCount) ?? 0;
  let last = before;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sendDpadKey(appSession, rcuSession, 'ArrowDown', {
      ...inputOptions,
      holdMs: attempt === 0 ? 40 : 80,
      settleMs: 80
    });
    last = await readStableShowsEvidence(appSession);
    const afterPosition = showsFocusPosition(last);
    const exactStep = beforePosition && afterPosition
      ? compareExactDirectionalStep(beforePosition, afterPosition, 'ArrowDown')
      : null;
    if (beforePosition && (
      !afterPosition
      || (!exactStep?.ok && afterPosition.index !== beforePosition.index)
    )) {
      return {
        atEnd: false,
        before,
        evidence: last,
        focusDrift: true,
        moved: false,
        rowDelta: null,
        stepComparison: exactStep
      };
    }
    const rowDelta = beforeWasFilter && afterPosition
      ? 1
      : exactStep?.ok ? 1 : null;
    if (rowDelta === 1) {
      return {
        atEnd: showsLibraryEndReached(last),
        evidence: last,
        moved: true,
        rowDelta
      };
    }
    if (showsLibraryEndReached(last)) {
      return { atEnd: true, before, evidence: last, moved: false };
    }
    if (last.state.shows?.hasMore !== false) {
      if (typeof inputOptions.reactivate === 'function') await inputOptions.reactivate();
      await pollEvidence(appSession, evidence => {
        const state = runtimeState(evidence.snapshot, evidence.surface);
        return (finiteNumber(state.shows?.metadataCount) ?? 0) > beforeMetadata
          || state.shows?.hasMore === false;
      }, 20_000);
      last = await readStableShowsEvidence(appSession);
      if (showsLibraryEndReached(last)) {
        return { atEnd: true, before, evidence: last, moved: false };
      }
    }
  }
  return { atEnd: false, before, evidence: last, moved: false };
}

async function captureEvidenceScreenshot(
  appSession,
  outputPath,
  suppliedEvidence = null,
  capture = captureScreenshot,
  read = readEvidence
) {
  let evidence;
  try {
    evidence = suppliedEvidence ?? await read(appSession);
  } catch {
    return { captured: false, path: null, reason: 'evidence-failed' };
  }
  const route = String(evidence.state?.currentRoute ?? runtimeState(
    evidence.snapshot,
    evidence.surface
  ).currentRoute ?? '').toLowerCase();
  if (!route || /startup|server|auth|quick-connect|sign in|connect to/i.test(route)) {
    return { captured: false, path: null, reason: 'unauthenticated-or-unknown-route' };
  }
  try {
    await capture(appSession, outputPath);
    return { captured: true, path: outputPath, reason: null };
  } catch {
    return { captured: false, path: null, reason: 'capture-failed' };
  }
}

async function testDetailsBack(appSession, rcuSession, artifactDir, label, inputOptions = {}) {
  let before = await readStableShowsEvidence(appSession);
  if (
    before.surface?.documentVisibility !== 'visible'
    && typeof inputOptions.reactivate === 'function'
  ) {
    await inputOptions.reactivate();
    before = await readStableShowsEvidence(appSession);
  }
  if (!String(before.state.currentFocusId || '').startsWith('browse-shows-')) return null;
  await sendDpadKey(appSession, rcuSession, 'Enter', {
    ...inputOptions,
    holdMs: 75,
    settleMs: 200
  });
  const details = await pollEvidence(appSession, evidence => /details/i.test(String(
    runtimeState(evidence.snapshot, evidence.surface).currentRoute || ''
  )), 10_000);
  const detailsState = runtimeState(details.snapshot, details.surface);
  if (!/details/i.test(String(detailsState.currentRoute || ''))) {
    return { before: before.state, enteredDetails: false, exactFocusRestored: false };
  }
  const screenshot = await captureEvidenceScreenshot(
    appSession,
    path.join(artifactDir, `details-${label}.png`),
    { ...details, state: detailsState }
  );
  const backOptions = {
    ...inputOptions,
    holdMs: inputOptions.viaVirtualRcu ? 700 : 80,
    settleMs: 250
  };
  let restored = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sendDpadKey(appSession, rcuSession, 'Back', backOptions);
    restored = await pollEvidence(appSession, evidence => {
      const state = runtimeState(evidence.snapshot, evidence.surface);
      return /shows/i.test(String(state.currentRoute || ''))
        && state.currentFocusId === before.state.currentFocusId;
    }, 10_000);
    const restoredState = runtimeState(restored.snapshot, restored.surface);
    if (/shows/i.test(String(restoredState.currentRoute || ''))) break;
  }
  const stableRestored = await readStableShowsEvidence(appSession);
  const after = stableRestored.state;
  return {
    after,
    before: before.state,
    enteredDetails: true,
    exactFocusRestored: after.currentFocusId === before.state.currentFocusId,
    screenshot
  };
}

async function stressShows(
  appSession,
  rcuSession,
  options,
  artifactDir,
  observations,
  inputOptions = {},
  metadataTracker = null
) {
  if (
    typeof inputOptions.reactivate === 'function'
    && !await inputOptions.reactivate()
  ) throw new Error('Simulator window could not be activated before Shows stress traversal.');
  const result = {
    backwardRows: 0,
    detailsRestorations: [],
    exactVerticalTraversal: false,
    filterResults: [],
    forwardRows: 0,
    metadataRequestCountAtEnd: null,
    renderWindowStarts: [],
    stoppedReason: null
  };
  const detailsMilestones = new Set([1, 33, 66, 99, 128].filter(row => row <= options.maxRows));
  const filters = [
    'browse-filter-recent', 'browse-filter-az', 'browse-filter-favorites',
    'browse-filter-recent', 'browse-filter-az'
  ];
  for (const filter of filters) {
    const selected = await selectFilter(appSession, rcuSession, filter, inputOptions);
    const evidence = await readEvidence(appSession);
    result.filterResults.push({ filter, selected, state: evidence.state });
    observations.push({ kind: 'filter', ...evidence });
  }
  const traversalFilterSelected = await selectFilter(
    appSession,
    rcuSession,
    'browse-filter-recent',
    inputOptions
  );
  const traversalFilterEvidence = await readStableShowsEvidence(appSession);
  result.traversalFilter = {
    selected: traversalFilterSelected,
    selectedFilterId: traversalFilterEvidence.surface?.selectedFilterId ?? null
  };
  if (
    !traversalFilterSelected
    || traversalFilterEvidence.surface?.selectedFilterId !== 'browse-filter-recent'
  ) throw new Error('Recently Added did not settle before full-library traversal.');
  while (result.forwardRows < options.maxRows) {
    const previousForwardRows = result.forwardRows;
    const movement = await moveDownOneShowsRow(appSession, rcuSession, inputOptions);
    const evidence = movement.evidence;
    if (movement.focusDrift) {
      observations.push({
        after: evidence,
        before: movement.before,
        inputSequence: ['ArrowDown'],
        kind: 'directional-failure',
        phase: 'down',
        stepComparison: movement.stepComparison ?? null
      });
      throw new Error('Shows DOWN input did not move exactly one card row in the same column.');
    }
    if (!movement.moved) {
      if (movement.atEnd) {
        result.metadataRequestCountAtEnd = metadataTracker?.snapshot().requests.length ?? null;
        result.stoppedReason = 'library end reached';
        result.screenshots = result.screenshots ?? [];
        result.screenshots.push(await captureEvidenceScreenshot(
          appSession,
          path.join(artifactDir, 'shows-near-bottom.png'),
          evidence
        ));
        break;
      }
      observations.push({
        after: evidence,
        before: movement.before,
        inputSequence: ['ArrowDown'],
        kind: 'directional-failure',
        phase: 'down'
      });
      throw new Error('Shows focus could not advance one card row after waiting for loading.');
    }
    result.forwardRows += 1;
    const row = result.forwardRows;
    if (movement.atEnd && result.metadataRequestCountAtEnd === null) {
      result.metadataRequestCountAtEnd = metadataTracker?.snapshot().requests.length ?? null;
    }
    observations.push({ kind: 'down', row, ...evidence });
    const start = finiteNumber(evidence.atomicFocus?.renderWindowStart);
    if (start !== null && result.renderWindowStarts.at(-1) !== start) result.renderWindowStarts.push(start);
    const classification = classifySimulatorMetrics(evidence.snapshot);
    const serious = seriousViolations(classification);
    if (serious.length) {
      result.stoppedReason = `serious invariant failure: ${serious.join(', ')}`;
      result.screenshots = result.screenshots ?? [];
      result.screenshots.push(await captureEvidenceScreenshot(
        appSession,
        path.join(artifactDir, 'failure-invariant.png'),
        evidence
      ));
      break;
    }
    if (row === 50) {
      result.screenshots = result.screenshots ?? [];
      result.screenshots.push(await captureEvidenceScreenshot(
        appSession,
        path.join(artifactDir, 'shows-deep-50-rows.png'),
        evidence
      ));
    }
    const crossedDetailsMilestones = [...detailsMilestones].filter(
      milestone => previousForwardRows < milestone && milestone <= row
    );
    for (const milestone of crossedDetailsMilestones) {
      const restoration = await testDetailsBack(
        appSession,
        rcuSession,
        artifactDir,
        `row-${milestone}`,
        inputOptions
      );
      if (!restoration?.enteredDetails || !restoration.exactFocusRestored) {
        throw new Error(`Details/Back did not restore exact Shows focus at row ${milestone}.`);
      }
      result.detailsRestorations.push({ label: `row-${milestone}`, ...restoration });
    }
    if (movement.atEnd && row > 10) {
      result.stoppedReason = 'library end reached';
      result.screenshots = result.screenshots ?? [];
      result.screenshots.push(await captureEvidenceScreenshot(
        appSession,
        path.join(artifactDir, 'shows-near-bottom.png'),
        evidence
      ));
      break;
    }
  }
  if (!result.stoppedReason && result.forwardRows >= options.maxRows) {
    result.stoppedReason = 'row limit reached before library end';
  }
  const upwardTarget = Math.min(60, Math.max(0, result.forwardRows - 1));
  while (result.backwardRows < upwardTarget) {
    const before = await readStableShowsEvidence(appSession);
    await sendDpadKey(appSession, rcuSession, 'ArrowUp', {
      ...inputOptions,
      holdMs: 40,
      settleMs: 80
    });
    const after = await readStableShowsEvidence(appSession);
    const stepComparison = compareExactDirectionalStep(
      showsFocusPosition(before),
      showsFocusPosition(after),
      'ArrowUp'
    );
    if (!stepComparison.ok) {
      observations.push({
        after,
        before,
        inputSequence: ['ArrowUp'],
        kind: 'directional-failure',
        phase: 'up',
        stepComparison
      });
      throw new Error('Upward reconstruction did not move exactly one card row in the same column.');
    }
    result.backwardRows += 1;
    if ((result.backwardRows - 1) % 8 === 0) {
      observations.push({ kind: 'up', row: result.backwardRows - 1, ...after });
    }
  }
  const restoration = await testDetailsBack(
    appSession,
    rcuSession,
    artifactDir,
    'after-upward',
    inputOptions
  );
  if (!restoration?.enteredDetails || !restoration.exactFocusRestored) {
    throw new Error('Details/Back did not restore exact Shows focus after upward reconstruction.');
  }
  result.detailsRestorations.push({ label: 'after-upward', ...restoration });
  result.exactVerticalTraversal = true;
  return result;
}

function attachEnduranceProgress(error, currentProgress) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const existing = failure.enduranceProgress && typeof failure.enduranceProgress === 'object'
    ? failure.enduranceProgress
    : {};
  failure.enduranceProgress = { ...currentProgress, ...existing };
  return failure;
}

async function runEndurance(appSession, rcuSession, minutes, observations, inputOptions = {}) {
  if (!minutes) return {
    completedMinutes: 0,
    cycles: 0,
    directionalSteps: 0,
    focusDriftFailures: 0,
    pointerOwnershipTransitionPasses: 0,
    pointerSwitches: 0,
    renderWindowTransitions: 0
  };
  let startedAt = null;
  let deadline = null;
  let cycles = 0;
  let directionalSteps = 0;
  let focusDriftFailures = 0;
  let pointerOwnershipTransitionPasses = 0;
  let pointerSwitches = 0;
  let renderWindowTransitions = 0;
  let lastRenderWindowStart = null;
  let failureContext = {
    failedCycle: 0,
    failedInputSequence: [],
    failedPhase: 'activation'
  };
  const progress = extra => ({
    completedMinutes: startedAt === null ? 0 : (Date.now() - startedAt) / 60_000,
    cycles,
    directionalSteps,
    focusDriftFailures,
    pointerOwnershipTransitionPasses,
    pointerSwitches,
    renderWindowTransitions,
    ...(extra ?? {})
  });
  const recordWindowTransition = evidence => {
    const next = finiteNumber(evidence?.atomicFocus?.renderWindowStart);
    if (next !== null && lastRenderWindowStart !== null && next !== lastRenderWindowStart) {
      renderWindowTransitions += 1;
    }
    if (next !== null) lastRenderWindowStart = next;
  };

  try {
    if (
      typeof inputOptions.reactivate === 'function'
      && !await inputOptions.reactivate()
    ) throw new Error('Simulator window could not be activated before endurance.');
    failureContext = { failedCycle: 0, failedInputSequence: [], failedPhase: 'initial' };
    const initial = await readStableShowsEvidence(appSession);
    if (!showsFocusPosition(initial)) {
      focusDriftFailures += 1;
      observations.push({
        after: initial,
        before: null,
        cycle: 0,
        inputSequence: [],
        kind: 'endurance-failure',
        phase: 'initial'
      });
      throw new Error('Endurance must begin with focus on a Shows card.');
    }
    startedAt = Date.now();
    deadline = startedAt + minutes * 60_000;
    lastRenderWindowStart = finiteNumber(initial.atomicFocus?.renderWindowStart);

    while (Date.now() < deadline) {
      failureContext = {
        failedCycle: cycles + 1,
        failedInputSequence: [],
        failedPhase: 'before-cycle'
      };
      let before = await readStableShowsEvidence(appSession);
      if (
        before.surface?.documentVisibility !== 'visible'
        && typeof inputOptions.reactivate === 'function'
      ) {
        failureContext.failedPhase = 'reactivation';
        if (!await inputOptions.reactivate()) {
          throw new Error('Simulator window could not be reactivated during endurance.');
        }
        failureContext.failedPhase = 'after-reactivation';
        before = await readStableShowsEvidence(appSession);
      }
      let beforePosition = showsFocusPosition(before);
      if (!beforePosition) {
        focusDriftFailures += 1;
        observations.push({
          after: before,
          before: null,
          cycle: cycles + 1,
          inputSequence: [],
          kind: 'endurance-failure',
          phase: 'before-cycle'
        });
        throw new Error('Endurance focus left the Shows poster grid.');
      }
      if (cycles % 50 === 0) {
        failureContext.failedPhase = 'pointer-ownership';
        let pointerResult;
        try {
          pointerResult = await exercisePointerOwnership(
            appSession,
            rcuSession,
            observations,
            cycles + 1,
            inputOptions,
            pointerSwitches % 2 === 0 ? 0 : 4
          );
        } catch (error) {
          focusDriftFailures += 1;
          throw error;
        }
        pointerSwitches += 1;
        pointerOwnershipTransitionPasses += 1;
        observations.push({
          cycle: cycles + 1,
          kind: 'pointer-ownership',
          ownershipStates: pointerResult.ownershipStates
        });
        before = pointerResult.evidence;
        beforePosition = showsFocusPosition(before);
        recordWindowTransition(before);
        if (!beforePosition) {
          focusDriftFailures += 1;
          failureContext.failedPhase = 'pointer-restoration';
          throw new Error('Pointer ownership stress did not restore Shows focus.');
        }
      }
      const sendEnduranceKey = async key => {
        await sendDpadKey(appSession, rcuSession, key, {
          ...inputOptions,
          holdMs: 40,
          settleMs: 50
        });
      };
      const sequence = [
        ['ArrowDown', 'down-1'],
        ['ArrowDown', 'down-2'],
        ['ArrowRight', 'right'],
        ['ArrowLeft', 'left'],
        ['ArrowUp', 'up-1'],
        ['ArrowUp', 'up-2']
      ];
      let evidence = before;
      let stepPosition = beforePosition;
      const cycleSteps = [];
      for (const [key, phase] of sequence) {
        failureContext = {
          failedCycle: cycles + 1,
          failedInputSequence: [key],
          failedPhase: phase
        };
        const stepBefore = evidence;
        const stepBeforePosition = stepPosition;
        await sendEnduranceKey(key);
        evidence = await readStableShowsEvidence(appSession);
        stepPosition = showsFocusPosition(evidence);
        const comparison = compareExactDirectionalStep(
          stepBeforePosition,
          stepPosition,
          key
        );
        directionalSteps += 1;
        recordWindowTransition(evidence);
        cycleSteps.push({
          column: stepPosition?.column ?? null,
          focusOwnerCount: evidence.atomicFocus?.focusOwnerCount ?? null,
          index: stepPosition?.index ?? null,
          key,
          phase,
          renderWindowStart: evidence.atomicFocus?.renderWindowStart ?? null,
          row: stepPosition?.row ?? null
        });
        if (!comparison.ok || evidence.atomicFocus?.focusOwnerCount !== 1) {
          focusDriftFailures += 1;
          observations.push({
            after: evidence,
            before: stepBefore,
            cycle: cycles + 1,
            inputSequence: [key],
            kind: 'endurance-failure',
            phase,
            stepComparison: comparison
          });
          throw new Error(`Endurance ${key} did not produce the exact Shows focus step.`);
        }
      }
      failureContext = {
        failedCycle: cycles + 1,
        failedInputSequence: ['ArrowUp', 'ArrowUp'],
        failedPhase: 'cycle-restoration'
      };
      const afterPosition = showsFocusPosition(evidence);
      if (
        !afterPosition
        || afterPosition.columns !== beforePosition.columns
        || afterPosition.index !== beforePosition.index
      ) {
        focusDriftFailures += 1;
        observations.push({
          after: evidence,
          before,
          cycle: cycles + 1,
          inputSequence: ['ArrowUp', 'ArrowUp'],
          kind: 'endurance-failure',
          phase: 'up'
        });
        throw new Error('Endurance DPAD cycle did not return to its starting Shows card.');
      }
      cycles += 1;
      if (cycles % 10 === 0) {
        failureContext = {
          failedCycle: cycles,
          failedInputSequence: [],
          failedPhase: 'cycle-verification'
        };
        observations.push({
          cycle: cycles,
          directionalSteps: cycleSteps,
          kind: 'endurance',
          ...evidence
        });
        if (
          !/shows/i.test(String(evidence.state.currentRoute || ''))
          || !isShowsCardFocus(evidence.state.currentFocusId)
        ) {
          focusDriftFailures += 1;
          throw new Error('Endurance focus left the Shows poster grid.');
        }
        const serious = seriousViolations(classifySimulatorMetrics(evidence.snapshot));
        if (serious.length) throw new Error(`Endurance invariant failure: ${serious.join(', ')}`);
      }
    }
    return progress();
  } catch (error) {
    throw attachEnduranceProgress(error, progress(failureContext));
  }
}

function classifyRuntimeConsole(events) {
  if (!Array.isArray(events)) return { issueCount: 0, issues: [], status: 'UNKNOWN' };
  const issues = [];
  let missingSeverity = false;
  for (const event of events) {
    const method = typeof event?.method === 'string' ? event.method : null;
    if (method === 'Runtime.exceptionThrown') {
      issues.push(event);
    } else if (method === 'Log.entryAdded') {
      if (typeof event.level !== 'string') {
        missingSeverity = true;
      } else if (/^(?:warn|warning|error)$/i.test(event.level)) {
        issues.push(event);
      }
    } else if (method === 'Runtime.consoleAPICalled') {
      if (typeof event.type !== 'string') {
        missingSeverity = true;
      } else if (/^(?:warn|warning|error|assert)$/i.test(event.type)) {
        issues.push(event);
      }
    } else {
      missingSeverity = true;
    }
  }
  return {
    issueCount: issues.length,
    issues,
    status: issues.length > 0 ? 'FAIL' : missingSeverity ? 'UNKNOWN' : 'PASS'
  };
}

function atomicFocusSamples(observations) {
  const samples = [];
  for (const observation of observations ?? []) {
    for (const evidence of [observation, observation?.before, observation?.after]) {
      if (evidence?.atomicFocus && typeof evidence.atomicFocus === 'object') {
        samples.push(evidence.atomicFocus);
      }
    }
  }
  return samples;
}

function evaluateAcceptanceCoverage(report, options) {
  const stress = report.stress ?? {};
  const surface = report.surface ?? {};
  const details = Array.isArray(stress.detailsRestorations) ? stress.detailsRestorations : [];
  const filters = Array.isArray(stress.filterResults) ? stress.filterResults : [];
  const metadataRequests = Array.isArray(report.metadataNetwork?.requests)
    ? report.metadataNetwork.requests
    : [];
  const focusOwnerCounts = atomicFocusSamples(report.observations)
    .map(sample => finiteNumber(sample.focusOwnerCount))
    .filter(value => value !== null);
  const pageInstances = new Set((report.observations ?? [])
    .map(observation => (
      observation?.atomicFocus?.pageInstanceId
      ?? runtimeState(observation?.snapshot, observation?.surface).pageInstanceId
    ))
    .filter(Boolean));
  const finalShows = [...(report.observations ?? [])].reverse()
    .map(observation => runtimeState(observation?.snapshot, observation?.surface).shows)
    .find(Boolean) ?? null;
  const consoleClassification = classifyRuntimeConsole(report.console);
  const requestedBoundaryCrossings = finiteNumber(options.boundaryCrossings) ?? 0;
  const boundaryGate = report.boundaryCrossingGate ?? null;
  const checks = {
    atomicDiagnosticComparisonObserved: ['AGREE', 'DISAGREE'].includes(
      report.atomicFocusSampling?.diagnosticComparisonStatus
    ),
    atomicDirectionalSampling: report.atomicFocusSampling?.status === 'PASS',
    artworkBoundObserved: report.metrics?.coverage?.artwork === true,
    automatedDpad: report.automatedDpad === 'PASS',
    boundaryCrossingGate: requestedBoundaryCrossings === 0 || (
      boundaryGate?.status === 'PASS'
      && boundaryGate.requestedCrossings === requestedBoundaryCrossings
      && finiteNumber(boundaryGate.completedCrossings) >= requestedBoundaryCrossings
      && boundaryGate.completedCrossings === boundaryGate.renderBoundaryCrossings
      && boundaryGate.completedExactKeySteps === boundaryGate.cyclesCompleted * 12
      && boundaryGate.renderBoundaryCrossings === boundaryGate.cyclesCompleted * 2
      && boundaryGate.renderBoundaryForwardCrossings === boundaryGate.cyclesCompleted
      && boundaryGate.renderBoundaryBackwardCrossings === boundaryGate.cyclesCompleted
      && boundaryGate.failureCount === 0
      && boundaryGate.focusDriftFailures === 0
      && boundaryGate.logicalNativeDisagreementCount === 0
    ),
    cardWidth180: Math.abs((finiteNumber(surface.cardWidth) ?? -1) - 180) <= 0.5,
    consoleClean: consoleClassification.status === 'PASS',
    detailsBackFiveDepths: details.length >= 5 && details.every(item => item.exactFocusRestored),
    enduranceDirectionalSteps: finiteNumber(report.endurance?.cycles) > 0
      && report.endurance?.directionalSteps === report.endurance.cycles * 6,
    enduranceThirtyMinutes: options.enduranceMinutes >= 30
      && finiteNumber(report.endurance?.completedMinutes) >= 30,
    enduranceWindowTransitions: finiteNumber(report.endurance?.renderWindowTransitions) >= 10,
    filtersExercised: filters.length >= 5 && filters.every(item => item.selected === true),
    focusOwnerOne: focusOwnerCounts.length > 0 && focusOwnerCounts.every(count => count === 1),
    fullLibraryReached: report.metrics?.maximumMetadata === 1_048
      && stress.stoppedReason === 'library end reached'
      && finalShows?.hasMore === false,
    lifecycle: !options.lifecycleCycle || report.lifecycle?.closeAndRelaunch === 'PASS',
    lifecycleFirstCloseCleanup: !options.lifecycleCycle
      || processCleanupSucceeded(report.lifecycle?.firstClose),
    layout1920x1080: surface.viewport?.width === 1_920 && surface.viewport?.height === 1_080,
    metadataAndWindowBounds: report.metrics?.status === 'PASS',
    metadataBatches24: metadataRequests.length > 0
      && metadataRequests[0].startIndex === 0
      && metadataRequests.every(request => request.limit === METADATA_BATCH_SIZE),
    noDuplicateActiveMetadata: report.metadataNetwork?.duplicateActiveCount === 0,
    noMetadataAfterEnd: stress.metadataRequestsAfterEnd === 0,
    noOverflow: surface.bodyOverflow === 0
      && surface.gridOverflow === 0
      && surface.longTitleOverflow === 0,
    posterGridEightColumns: surface.gridColumns === 8,
    pointerOwnershipStress: finiteNumber(report.endurance?.pointerSwitches) >= 2
      && report.endurance?.pointerOwnershipTransitionPasses === report.endurance.pointerSwitches
      && report.endurance?.focusDriftFailures === 0,
    processTreeCleanup: report.cleanup?.processTreeClosed === true,
    renderedDocumentVisible: surface.documentVisibility === 'visible',
    singlePageInstance: pageInstances.size === 1,
    renderWindowTransitions: Array.isArray(stress.renderWindowStarts)
      && new Set(stress.renderWindowStarts).size >= 2,
    traversalExactVerticalRows: stress.exactVerticalTraversal === true,
    traversedAtLeastFiftyRows: finiteNumber(stress.forwardRows) >= 50,
    upwardReconstruction: finiteNumber(stress.backwardRows) >= 50
  };
  return {
    checks,
    complete: Object.values(checks).every(passed => passed === true),
    missing: Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name)
  };
}

async function runSimulatorValidation(options, root = process.cwd()) {
  if (options.prepare) runPreparation(root);
  const executable = validateSimulatorExecutable(options.simulatorPath, options.simulatorVersion);
  const appDirectory = validateAppDirectory(options.appDir);
  fs.mkdirSync(options.artifactDir, { recursive: true });
  const appInfo = JSON.parse(fs.readFileSync(path.join(appDirectory, 'appinfo.json'), 'utf8'));
  const executableInfo = simulatorExecutableInfo(executable);
  const cdpPort = await reserveLocalPort(options.cdpPort);
  const report = {
    acceptance: 'HOLD',
    app: { id: appInfo.id, version: appInfo.version },
    appDirectory,
    artifactDir: options.artifactDir,
    automatedDpad: 'UNKNOWN',
    boundaryCrossingGate: {
      requestedCrossings: options.boundaryCrossings,
      status: options.boundaryCrossings > 0 ? 'UNKNOWN' : 'SKIPPED'
    },
    cdp: { address: '127.0.0.1', port: cdpPort },
    console: [],
    errors: [],
    observations: [],
    simulator: {
      executable,
      simulatorVersion: executableInfo?.simulatorVersion ?? null,
      tvVersion: executableInfo?.tvVersion ?? options.simulatorVersion
    },
    startedAt: new Date().toISOString(),
    statusReason: null
  };
  writeJson(path.join(options.artifactDir, 'run-manifest.json'), report);
  let child = null;
  let activeCdpPort = cdpPort;
  let appSession = null;
  let metadataTracker = null;
  let rcuSession = null;
  const runtimeEvents = [];
  let shellSession = null;
  try {
    child = startSimulator(
      executable,
      appDirectory,
      cdpPort,
      path.join(options.artifactDir, 'simulator-process.log')
    );
    report.processOwnership = [{ phase: 'initial', pid: child.pid, port: cdpPort }];
    writeJson(path.join(options.artifactDir, 'run-manifest.json'), report);
    const targets = await waitForTargets(`http://127.0.0.1:${cdpPort}`, {
      predicate: available => Boolean(
        selectAppTarget(available, appDirectory)
        && selectRcuTarget(available)
        && selectShellTarget(available)
      ),
      timeoutMs: 30_000
    });
    writeJson(path.join(options.artifactDir, 'cdp-targets.json'), targets.map(target => ({
      title: target.title,
      type: target.type,
      url: target.url
    })));
    const appTarget = selectAppTarget(targets, appDirectory);
    const rcuTarget = selectRcuTarget(targets);
    const shellTarget = selectShellTarget(targets);
    if (!appTarget) throw new Error('PiggieTV CDP target was not found.');
    if (!rcuTarget) throw new Error('Simulator virtual-RCU CDP target was not found.');
    if (!shellTarget) throw new Error('Simulator main-window CDP target was not found.');
    appSession = await connectTarget(appTarget);
    rcuSession = await connectTarget(rcuTarget);
    shellSession = await connectTarget(shellTarget);
    metadataTracker = createMetadataRequestTracker();
    attachAppSessionTelemetry(appSession, metadataTracker, runtimeEvents, 'initial');
    await Promise.all([
      enableAppSessionTelemetry(appSession),
      rcuSession.call('Runtime.enable'),
      shellSession.call('Page.enable')
    ]);
    report.windowActivation = [{
      osActivated: activateOwnedSimulatorWindow(child),
      phase: 'initial'
    }];
    await activateSimulatorWindow(shellSession, appSession);
    const ready = await pollEvidence(
      appSession,
      evidence => {
        const state = runtimeState(evidence.snapshot, evidence.surface);
        return evidence.surface?.readyState === 'complete'
          && evidence.surface?.viewport?.width > 0
          && !/^startup$/i.test(String(state.currentRoute || ''));
      },
      45_000
    );
    const readyState = runtimeState(ready.snapshot, ready.surface);
    if (!ready.surface?.viewport?.width || /^startup$/i.test(String(readyState.currentRoute || ''))) {
      throw new Error('PiggieTV did not reach a stable route after cold Simulator launch.');
    }
    if (!readyState.pageInstanceId) {
      throw new Error(
        'Simulator runtime diagnostics are disabled; rebuild the candidate with PTV_DIAGNOSTICS=1.'
      );
    }
    report.observations.push({ kind: 'cold-launch', ...ready });
    const initial = await readEvidence(appSession);
    const initialFocus = initial.state.currentFocusId;
    await sendDpadKey(appSession, rcuSession, 'ArrowDown', { viaVirtualRcu: true });
    const virtualMoved = await readEvidence(appSession);
    const virtualRcuDelivered = virtualMoved.state.currentFocusId !== initialFocus;
    let moved = virtualMoved;
    let restored;
    if (virtualRcuDelivered) {
      await sendDpadKey(appSession, rcuSession, 'ArrowUp', { viaVirtualRcu: true });
      restored = await readEvidence(appSession);
    } else {
      await sendDpadKey(appSession, rcuSession, 'ArrowDown');
      moved = await readEvidence(appSession);
      await sendDpadKey(appSession, rcuSession, 'ArrowUp');
      restored = await readEvidence(appSession);
    }
    const directCdpDelivered = !virtualRcuDelivered && moved.state.currentFocusId !== initialFocus;
    report.automatedDpad = virtualRcuDelivered || directCdpDelivered ? 'PASS' : 'HOLD';
    report.automatedDpadMethod = virtualRcuDelivered
      ? 'simulator-virtual-rcu'
      : directCdpDelivered
        ? 'app-target-cdp-input'
        : null;
    report.rcuProbe = {
      afterDirectDown: moved.state.currentFocusId,
      afterDirectUp: restored.state.currentFocusId,
      afterVirtualRcuDown: virtualMoved.state.currentFocusId,
      before: initialFocus,
      directCdpDelivered,
      virtualRcuDelivered
    };
    report.observations.push(
      { kind: 'virtual-rcu-down', ...virtualMoved },
      { kind: 'direct-cdp-down', ...moved },
      { kind: 'direct-cdp-up', ...restored }
    );
    let visible = await pollEvidence(
      appSession,
      evidence => evidence.surface?.documentVisibility === 'visible',
      5_000
    );
    if (visible.surface?.documentVisibility !== 'visible') {
      report.windowActivation.push({
        osActivated: activateOwnedSimulatorWindow(child),
        phase: 'initial-retry'
      });
      await activateSimulatorWindow(shellSession, appSession);
      visible = await pollEvidence(
        appSession,
        evidence => evidence.surface?.documentVisibility === 'visible',
        5_000
      );
    }
    if (visible.surface?.documentVisibility !== 'visible') {
      throw new Error('Simulator app WebView remained hidden after main-window activation.');
    }
    const reactivateStressWindow = async () => {
      const osActivated = activateOwnedSimulatorWindow(child);
      await activateSimulatorWindow(shellSession, appSession);
      const active = await pollEvidence(
        appSession,
        evidence => evidence.surface?.documentVisibility === 'visible',
        5_000
      );
      report.windowActivation.push({
        osActivated,
        phase: 'stress-reactivation',
        visible: active.surface?.documentVisibility === 'visible'
      });
      return active.surface?.documentVisibility === 'visible';
    };
    const stressInputOptions = {
      reactivate: reactivateStressWindow,
      viaVirtualRcu: false
    };
    report.automatedDpadMethod = virtualRcuDelivered
      ? 'simulator-virtual-rcu-probe + app-target-cdp-stress'
      : directCdpDelivered
        ? 'app-target-cdp-input'
        : null;
    report.stressDpadMethod = 'app-target-cdp-input';
    report.screenshots = [await captureEvidenceScreenshot(
      appSession,
      path.join(options.artifactDir, 'cold-launch.png'),
      { ...restored, state: runtimeState(restored.snapshot, restored.surface) }
    )];
    let authenticatedEvidence = restored;
    let authenticatedRoute = isAuthenticatedAppRoute(restored.state.currentRoute);
    if (!authenticatedRoute && options.authWaitMinutes > 0) {
      report.statusReason = 'Waiting for interactive authentication in the runner-owned Simulator.';
      writeJson(path.join(options.artifactDir, 'run-manifest.json'), report);
      const signedIn = await pollEvidence(
        appSession,
        evidence => isAuthenticatedAppRoute(
          runtimeState(evidence.snapshot, evidence.surface).currentRoute
        ),
        options.authWaitMinutes * 60_000
      );
      authenticatedEvidence = {
        ...signedIn,
        state: runtimeState(signedIn.snapshot, signedIn.surface)
      };
      authenticatedRoute = isAuthenticatedAppRoute(authenticatedEvidence.state.currentRoute);
      if (authenticatedRoute) {
        report.observations.push({ kind: 'interactive-auth-complete', ...signedIn });
      }
    }
    if (!authenticatedRoute) {
      report.statusReason = 'The packaged app reached authentication, but no authenticated Simulator session was available.';
      report.errors.push({
        code: 'AUTHENTICATED_SESSION_REQUIRED',
        message: 'Shows-library traversal was not attempted without an authorized Jellyfin session.'
      });
    } else {
      const reachedShows = /shows/i.test(String(authenticatedEvidence.state.currentRoute || ''))
        || await navigateToShows(appSession, rcuSession, stressInputOptions);
      if (!reachedShows) throw new Error('Simulator DPAD input could not navigate the authenticated app to Shows.');
      const showsInitial = await pollEvidence(appSession, evidence => {
        const state = runtimeState(evidence.snapshot, evidence.surface);
        return Boolean(
          state.shows?.metadataCount
          && evidence.surface?.cardCount > 0
          && evidence.surface?.showsBusy === false
          && evidence.surface?.selectedFilterId === 'browse-filter-recent'
        );
      }, 45_000);
      const showsInitialState = runtimeState(showsInitial.snapshot, showsInitial.surface);
      if (
        !showsInitialState.shows?.metadataCount
        || !showsInitial.surface?.cardCount
        || showsInitial.surface?.showsBusy !== false
      ) throw new Error('Shows did not reach a settled diagnostic first batch.');
      report.observations.push({ kind: 'shows-initial', ...showsInitial });
      report.screenshots.push(await captureEvidenceScreenshot(
        appSession,
        path.join(options.artifactDir, 'shows-initial.png'),
        {
          ...showsInitial,
          state: showsInitialState
        }
      ));
      report.stress = await stressShows(
        appSession,
        rcuSession,
        options,
        options.artifactDir,
        report.observations,
        stressInputOptions,
        metadataTracker
      );
      if (options.boundaryCrossings > 0) {
        report.boundaryCrossingGate = await runShowsBoundaryCrossingGate(
          appSession,
          rcuSession,
          options.boundaryCrossings,
          report.observations,
          stressInputOptions
        );
      }
      report.endurance = await runEndurance(
        appSession,
        rcuSession,
        options.enduranceMinutes,
        report.observations,
        stressInputOptions
      );
      if (!await reactivateStressWindow()) {
        throw new Error('Simulator window could not be activated for final evidence.');
      }
      let finalEvidence = await readStableShowsEvidence(appSession);
      if (report.stress.stoppedReason === 'library end reached') {
        await new Promise(resolve => setTimeout(resolve, 1_500));
        finalEvidence = await readStableShowsEvidence(appSession);
        const requestCountAtEnd = finiteNumber(report.stress.metadataRequestCountAtEnd);
        report.stress.metadataRequestsAfterEnd = requestCountAtEnd === null
          ? null
          : Math.max(0, metadataTracker.snapshot().requests.length - requestCountAtEnd);
      }
      report.observations.push({ kind: 'final', ...finalEvidence });
      report.metrics = classifySimulatorObservations(report.observations);
      report.metadataNetwork = metadataTracker.snapshot();
      report.surface = finalEvidence.surface;
      report.console = runtimeEvents.map(summarizeRuntimeEvent);
      report.statusReason = 'Simulator stress scenarios completed; final lifecycle and cleanup checks are pending.';
    }
    report.console = runtimeEvents.map(summarizeRuntimeEvent);
    report.metadataNetwork = metadataTracker.snapshot();
    if (options.lifecycleCycle) {
      appSession.close();
      rcuSession.close();
      shellSession.close();
      appSession = null;
      rcuSession = null;
      shellSession = null;
      const firstClose = await stopOwnedSimulator(child, activeCdpPort);
      child = null;
      report.lifecycle = {
        closeAndRelaunch: 'HOLD',
        firstClose
      };
      if (!processCleanupSucceeded(firstClose)) {
        throw new Error('Initial Simulator process tree did not fully close before relaunch.');
      }
      const cyclePort = await reserveLocalPort(null);
      const cycleChild = startSimulator(
        executable,
        appDirectory,
        cyclePort,
        path.join(options.artifactDir, 'simulator-relaunch-process.log')
      );
      child = cycleChild;
      activeCdpPort = cyclePort;
      report.processOwnership.push({ phase: 'relaunch', pid: child.pid, port: cyclePort });
      const cycleTargets = await waitForTargets(`http://127.0.0.1:${cyclePort}`, {
        predicate: available => Boolean(
          selectAppTarget(available, appDirectory) && selectShellTarget(available)
        ),
        timeoutMs: 30_000
      });
      const cycleTarget = selectAppTarget(cycleTargets, appDirectory);
      const cycleShellTarget = selectShellTarget(cycleTargets);
      if (!cycleTarget) throw new Error('PiggieTV target was absent after Simulator relaunch.');
      if (!cycleShellTarget) throw new Error('Simulator main-window target was absent after relaunch.');
      appSession = await connectTarget(cycleTarget);
      shellSession = await connectTarget(cycleShellTarget);
      attachAppSessionTelemetry(appSession, metadataTracker, runtimeEvents, 'relaunch');
      await Promise.all([
        enableAppSessionTelemetry(appSession),
        shellSession.call('Page.enable')
      ]);
      report.windowActivation.push({
        osActivated: activateOwnedSimulatorWindow(cycleChild),
        phase: 'relaunch'
      });
      await activateSimulatorWindow(shellSession, appSession);
      const relaunched = await pollEvidence(appSession, evidence => {
        const state = runtimeState(evidence.snapshot, evidence.surface);
        return evidence.surface?.readyState === 'complete'
          && evidence.surface?.viewport?.width > 0
          && isAuthenticatedAppRoute(state.currentRoute);
      }, 45_000);
      const relaunchedState = runtimeState(relaunched.snapshot, relaunched.surface);
      if (
        !relaunched.surface?.viewport?.width
        || !isAuthenticatedAppRoute(relaunchedState.currentRoute)
      ) throw new Error('PiggieTV did not restore an authenticated route after Simulator relaunch.');
      report.screenshots.push(await captureEvidenceScreenshot(
        appSession,
        path.join(options.artifactDir, 'relaunch.png'),
        { ...relaunched, state: relaunchedState }
      ));
      report.lifecycle = {
        ...report.lifecycle,
        closeAndRelaunch: 'PASS',
        relaunchedPageInstanceId: relaunchedState.pageInstanceId,
        relaunchedRoute: relaunchedState.currentRoute
      };
    }
  } catch (error) {
    report.acceptance = 'HOLD';
    if (error && typeof error === 'object' && error.enduranceProgress) {
      report.endurance = error.enduranceProgress;
    }
    if (error && typeof error === 'object' && error.boundaryProgress) {
      report.boundaryCrossingGate = error.boundaryProgress;
    }
    report.errors.push({ code: 'SIMULATOR_VALIDATION_ERROR', message: error.message });
    report.statusReason = report.statusReason ?? error.message;
    if (appSession) {
      try {
        const failure = await readEvidence(appSession);
        report.observations.push({ kind: 'failure', ...failure });
        report.failureEvidence = failure;
        report.surface = failure.surface ?? report.surface ?? null;
        report.failureScreenshot = await captureEvidenceScreenshot(
          appSession,
          path.join(options.artifactDir, 'failure.png'),
          failure
        );
      } catch (captureError) {
        report.errors.push({ code: 'FAILURE_CAPTURE_ERROR', message: captureError.message });
      }
    }
  } finally {
    report.completedAt = new Date().toISOString();
    report.console = runtimeEvents.map(summarizeRuntimeEvent);
    report.consoleClassification = classifyRuntimeConsole(report.console);
    if (metadataTracker) report.metadataNetwork = metadataTracker.snapshot();
    writeJsonLines(path.join(options.artifactDir, 'runtime-events.jsonl'), report.console);
    report.metrics = report.metrics ?? classifySimulatorObservations(report.observations);
    report.atomicFocusSampling = summarizeAtomicFocusSampling(report.observations);
    appSession?.close();
    rcuSession?.close();
    shellSession?.close();
    if (!options.keepOpen) {
      try {
        report.cleanup = await stopOwnedSimulator(child, activeCdpPort);
      } catch (cleanupError) {
        report.acceptance = 'HOLD';
        report.errors.push({ code: 'SIMULATOR_CLEANUP_ERROR', message: cleanupError.message });
        report.statusReason = cleanupError.message;
      }
    } else {
      report.cleanup = { keptOpen: true, pid: child?.pid ?? null, port: activeCdpPort };
    }
    if (report.stress) {
      report.metrics = classifySimulatorObservations(report.observations);
      report.coverage = evaluateAcceptanceCoverage(report, options);
      if (
        report.coverage.complete
        && report.errors.length === 0
        && !options.keepOpen
        && report.cleanup?.portClosed === true
        && report.cleanup?.processTreeClosed === true
      ) {
        report.acceptance = 'SIMULATOR_PASS_PHYSICAL_HOLD';
        report.statusReason = 'Simulator checks passed; physical LG acceptance remains required.';
      } else {
        report.acceptance = 'HOLD';
        report.statusReason = report.errors.length
          ? report.statusReason
          : `Simulator coverage remains incomplete: ${report.coverage.missing.join(', ')}.`;
      }
    }
    writeJson(path.join(options.artifactDir, 'report.json'), report);
  }
  return report;
}

async function main() {
  try {
    const options = parseSimulatorArgs();
    const report = await runSimulatorValidation(options);
    console.log(`Simulator validation: ${report.acceptance}`);
    console.log(`Artifacts: ${report.artifactDir}`);
    if (report.statusReason) console.log(report.statusReason);
    process.exitCode = report.acceptance === 'SIMULATOR_PASS_PHYSICAL_HOLD' ? 0 : 2;
  } catch (error) {
    console.error(`Simulator validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  activateOwnedSimulatorWindow,
  activateSimulatorWindow,
  attachBoundaryCrossingProgress,
  attachEnduranceProgress,
  attachAppSessionTelemetry,
  captureEvidenceScreenshot,
  classifySimulatorMetrics,
  classifySimulatorObservations,
  classifyRuntimeConsole,
  compareAtomicFocusWithDiagnostics,
  compareExactDirectionalStep,
  deriveShowsRenderWindowStartFromGeometry,
  dispatchPointerMove,
  enableAppSessionTelemetry,
  evaluateAcceptanceCoverage,
  filterNavigationKey,
  normalizeAtomicShowsFocusSample,
  parseSimulatorArgs,
  parseMetadataRequest,
  pointerMoveCoordinates,
  pointerOwnershipTransitionMatches,
  processCleanupSucceeded,
  readAtomicShowsFocusSample,
  runEndurance,
  runPreparation,
  runShowsBoundaryCrossingGate,
  runSimulatorValidation,
  sanitizeSimulatorArtifact,
  showsFocusPosition,
  showsLibraryEndReached,
  showsFilterSettled,
  showsBoundaryTraversalSteps,
  showsRowDelta,
  summarizeAtomicFocusSampling,
  summarizeRuntimeEvent,
  simulatorExecutableInfo,
  validateAppDirectory,
  validateBoundaryAtomicStep,
  validateSimulatorExecutable
};
