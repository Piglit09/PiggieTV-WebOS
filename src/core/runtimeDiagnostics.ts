export const RUNTIME_DIAGNOSTICS_ENABLED_KEY = 'ptv.runtimeDiagnostics.enabled.v1';
export const RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY = 'ptv.runtimeDiagnostics.heartbeat.v1';
const RUNTIME_DIAGNOSTICS_LAUNCH_COUNT_KEY = 'ptv.runtimeDiagnostics.pageLoadCount.v1';
const RUNTIME_DIAGNOSTICS_WEBVIEW_SESSION_KEY = 'ptv.runtimeDiagnostics.webViewSessionId.v1';
const RUNTIME_DIAGNOSTICS_PAGE_INSTANCE_KEY = 'ptv.runtimeDiagnostics.pageInstanceId.v1';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface TimerHost {
  clearInterval: (timer: number) => void;
  setInterval: (callback: () => void, intervalMs: number) => number;
}

export interface RuntimeDiagnosticsOptions {
  enabled: boolean;
  now?: () => number;
  persistentStorage?: StorageLike | null;
  random?: () => number;
  sessionStorage?: StorageLike | null;
  timeOrigin?: () => number | null;
  timerHost?: TimerHost | null;
}

export interface RuntimePageEvidence {
  pageInstanceId: string | null;
  pageLoadCount: number | null;
  pageLoadTimestamp: number;
  timeOrigin: number | null;
  webViewSessionId: string | null;
}

export interface RuntimeHeartbeatRecord extends Record<string, unknown> {
  pageInstanceId: string;
  pageLoadCount: number;
  pageLoadTimestamp: number;
  timestamp: number;
  timeOrigin: number | null;
  webViewSessionId: string;
}

export interface RuntimeHealthSnapshot {
  diagnosticMode: boolean;
  heartbeatActive: boolean;
  heartbeatAgeMs: number | null;
  lastHeartbeat: RuntimeHeartbeatRecord | null;
  page: RuntimePageEvidence;
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function safeTimeOrigin() {
  if (typeof performance === 'undefined') return null;
  if (typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin)) {
    return Math.round(performance.timeOrigin);
  }
  if (typeof performance.now === 'function') {
    return Math.round(Date.now() - performance.now());
  }
  return null;
}

function safeRead(storage: StorageLike | null, key: string) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(storage: StorageLike | null, key: string, value: string) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function createInstanceId(prefix: string, now: number, random: () => number) {
  const randomPart = Math.floor(Math.max(0, random()) * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0');
  return `${prefix}_${Math.max(0, Math.floor(now)).toString(36)}_${randomPart}`;
}

function parsePositiveInteger(value: string | null) {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readHeartbeat(storage: StorageLike | null): RuntimeHeartbeatRecord | null {
  const raw = safeRead(storage, RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeHeartbeatRecord>;
    if (
      typeof parsed.timestamp !== 'number'
      || typeof parsed.pageInstanceId !== 'string'
      || typeof parsed.webViewSessionId !== 'string'
      || typeof parsed.pageLoadCount !== 'number'
      || typeof parsed.pageLoadTimestamp !== 'number'
    ) return null;
    return parsed as RuntimeHeartbeatRecord;
  } catch {
    return null;
  }
}

export function runtimeDiagnosticsBuildEnabled() {
  return String(import.meta.env.VITE_PTV_DIAGNOSTICS ?? '').toLowerCase() === 'true';
}

export function runtimeDiagnosticsEnabled(storage: StorageLike | null = safeStorage('localStorage')) {
  if (runtimeDiagnosticsBuildEnabled()) return true;
  return safeRead(storage, RUNTIME_DIAGNOSTICS_ENABLED_KEY) === '1';
}

export class RuntimeDiagnosticsMonitor {
  private heartbeatOwner: object | null = null;
  private heartbeatProvider: (() => Record<string, unknown>) | null = null;
  private heartbeatTimer: number | null = null;
  private lastHeartbeat: RuntimeHeartbeatRecord | null = null;
  private readonly now: () => number;
  private readonly persistentStorage: StorageLike | null;
  private readonly timerHost: TimerHost | null;
  public readonly enabled: boolean;
  public readonly page: RuntimePageEvidence;

  public constructor(options: RuntimeDiagnosticsOptions) {
    this.enabled = options.enabled;
    this.now = options.now ?? (() => Date.now());
    this.persistentStorage = options.persistentStorage === undefined
      ? safeStorage('localStorage')
      : options.persistentStorage;
    const sessionStorage = options.sessionStorage === undefined
      ? safeStorage('sessionStorage')
      : options.sessionStorage;
    this.timerHost = options.timerHost === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.timerHost;
    const pageLoadTimestamp = this.now();

    if (!this.enabled) {
      this.page = {
        pageInstanceId: null,
        pageLoadCount: null,
        pageLoadTimestamp,
        timeOrigin: null,
        webViewSessionId: null
      };
      return;
    }

    const random = options.random ?? (() => Math.random());
    const pageInstanceId = createInstanceId('page', pageLoadTimestamp, random);
    const existingWebViewSessionId = safeRead(
      sessionStorage,
      RUNTIME_DIAGNOSTICS_WEBVIEW_SESSION_KEY
    );
    const webViewSessionId = existingWebViewSessionId
      || createInstanceId('webview', pageLoadTimestamp, random);
    const pageLoadCount = parsePositiveInteger(safeRead(
      this.persistentStorage,
      RUNTIME_DIAGNOSTICS_LAUNCH_COUNT_KEY
    )) + 1;

    safeWrite(sessionStorage, RUNTIME_DIAGNOSTICS_WEBVIEW_SESSION_KEY, webViewSessionId);
    safeWrite(sessionStorage, RUNTIME_DIAGNOSTICS_PAGE_INSTANCE_KEY, pageInstanceId);
    safeWrite(this.persistentStorage, RUNTIME_DIAGNOSTICS_LAUNCH_COUNT_KEY, String(pageLoadCount));

    this.page = {
      pageInstanceId,
      pageLoadCount,
      pageLoadTimestamp,
      timeOrigin: (options.timeOrigin ?? safeTimeOrigin)(),
      webViewSessionId
    };
    this.lastHeartbeat = readHeartbeat(this.persistentStorage);
  }

  public startHeartbeat(
    provider: () => Record<string, unknown>,
    intervalMs = 5_000
  ) {
    if (!this.enabled || !this.timerHost || !this.page.pageInstanceId || !this.page.webViewSessionId) {
      return () => undefined;
    }
    if (this.heartbeatTimer !== null) {
      return () => undefined;
    }

    const owner = {};
    this.heartbeatOwner = owner;
    this.heartbeatProvider = provider;
    this.recordHeartbeat();
    this.heartbeatTimer = this.timerHost.setInterval(
      () => this.recordHeartbeat(),
      Math.max(1_000, Math.floor(intervalMs))
    );

    return () => {
      if (this.heartbeatOwner !== owner) return;
      if (this.heartbeatTimer !== null) {
        this.timerHost?.clearInterval(this.heartbeatTimer);
      }
      this.heartbeatTimer = null;
      this.heartbeatOwner = null;
      this.heartbeatProvider = null;
    };
  }

  public recordHeartbeat(extra: Record<string, unknown> = {}) {
    if (
      !this.enabled
      || !this.heartbeatProvider
      || !this.page.pageInstanceId
      || !this.page.webViewSessionId
      || this.page.pageLoadCount === null
    ) return null;

    const record: RuntimeHeartbeatRecord = {
      ...this.heartbeatProvider(),
      ...extra,
      timestamp: this.now(),
      pageInstanceId: this.page.pageInstanceId,
      webViewSessionId: this.page.webViewSessionId,
      pageLoadCount: this.page.pageLoadCount,
      pageLoadTimestamp: this.page.pageLoadTimestamp,
      timeOrigin: this.page.timeOrigin
    };
    this.lastHeartbeat = record;
    safeWrite(
      this.persistentStorage,
      RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY,
      JSON.stringify(record)
    );
    return { ...record };
  }

  public snapshot(): RuntimeHealthSnapshot {
    const persistedHeartbeat = this.enabled
      ? readHeartbeat(this.persistentStorage)
      : null;
    const lastHeartbeat = this.lastHeartbeat ?? persistedHeartbeat;
    return {
      diagnosticMode: this.enabled,
      heartbeatActive: this.heartbeatTimer !== null,
      heartbeatAgeMs: lastHeartbeat
        ? Math.max(0, this.now() - lastHeartbeat.timestamp)
        : null,
      lastHeartbeat: lastHeartbeat ? { ...lastHeartbeat } : null,
      page: { ...this.page }
    };
  }
}
