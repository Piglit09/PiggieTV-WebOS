import type { PtvDiagnosticsSnapshot } from '../types/ptv';
import type { RequestTracker } from './requestTracker';
import { redactSensitiveText } from './redaction';

interface DiagnosticsLog {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: string | null;
}

export interface DiagnosticsSnapshotInput {
  appVersion: string;
  buildTimestamp: string;
  mode: 'development' | 'production';
  route: string;
  focusId: string | null;
  previousFocusId: string | null;
  playbackState?: string;
  playbackDecision?: string | null;
  mediaCodecs?: string;
  serverUrl: string;
  serverVersion?: string | null;
  userId?: string | null;
  capabilities: string[];
  lastLifecycleEvent?: string | null;
  lastPlaybackError?: string | null;
  lastUiError?: string | null;
  commitHash?: string | null;
  ptvPluginVersion?: string | null;
  ptvApiVersion?: string | null;
  token?: string | null;
}

export class DiagnosticsService {
  private logs: DiagnosticsLog[] = [];
  private lastUiError: string | null = null;
  private lastPlaybackError: string | null = null;
  private sessionSnapshot: Record<string, unknown> | null = null;
  private playbackSnapshot: Record<string, unknown> | null = null;
  private focusTransitions: Array<Record<string, unknown>> = [];
  private logSequence = 0;
  private readonly maxLogs = 200;
  private requestTracker?: RequestTracker;

  public attachTracker(tracker: RequestTracker) {
    this.requestTracker = tracker;
  }

  public logInfo(message: string, details?: unknown) {
    this.push('info', message, details);
  }

  public logWarn(message: string, details?: unknown) {
    this.push('warn', message, details);
  }

  public logError(message: string, details?: unknown, persistAsUi = false) {
    const text = this.renderDetails(details);
    const safeMessage = redactSensitiveText(message);
    this.lastUiError = `${safeMessage}${text ? ` (${text})` : ''}`;
    this.push('error', message, details);
    if (persistAsUi) {
      this.lastUiError = safeMessage;
    }
  }

  public recordPlaybackError(message: string) {
    const safeMessage = redactSensitiveText(message);
    this.lastPlaybackError = safeMessage;
    this.push('error', safeMessage);
  }

  public recordSessionSnapshot(snapshot: Record<string, unknown>) {
    this.sessionSnapshot = this.sanitizeRecord(snapshot);
  }

  public recordPlaybackSnapshot(snapshot: Record<string, unknown>) {
    this.playbackSnapshot = this.sanitizeRecord(snapshot);
  }

  public recordFocusTransition(transition: Record<string, unknown>) {
    this.focusTransitions.push(this.sanitizeRecord(transition));
    if (this.focusTransitions.length > 30) this.focusTransitions.shift();
  }

  public resetErrors() {
    this.lastPlaybackError = null;
    this.lastUiError = null;
  }

  public snapshot(input: DiagnosticsSnapshotInput): PtvDiagnosticsSnapshot {
    const safeUrl = this.redactServerUrl(input.serverUrl);
    const safeUser = this.redactSensitive(input.userId);

    return {
      appVersion: input.appVersion,
      buildTimestamp: input.buildTimestamp,
      commitHash: input.commitHash ?? null,
      mode: input.mode,
      webosVersion: this.safeRead(() => (window as any).webOS?.version || null),
      tvModel: this.safeRead(() => (window as any).webOS?.deviceInfo?.productName || null),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio ?? 1,
      serverVersion: input.serverVersion ?? null,
      serverUrl: safeUrl,
      userId: safeUser,
      pluginVersion: input.ptvPluginVersion ?? null,
      pluginApiVersion: input.ptvApiVersion ?? null,
      capabilities: input.capabilities,
      currentRoute: input.route,
      currentFocusId: input.focusId,
      previousFocusId: input.previousFocusId,
      activeRequests: this.requestTracker?.getActiveCount() ?? 0,
      peakConcurrentRequests: this.requestTracker?.getPeakConcurrency() ?? 0,
      recentCompletions: this.requestTracker?.getRecentCompletions(20).map(entry => ({
        id: entry.id,
        url: entry.url,
        method: entry.method,
        status: entry.status,
        durationMs: entry.durationMs,
        error: entry.error,
        timedOut: entry.timedOut,
        cancelled: entry.cancelled,
        category: entry.category,
        route: entry.route,
        contentType: entry.contentType,
        parseResult: entry.parseResult
      })) ?? [],
      activeFailures: this.requestTracker?.getRecentErrors(20) ?? [],
      averageRequestDuration: this.requestTracker?.getAverageDuration() ?? 0,
      failedRequestCount: this.requestTracker?.getRecentErrors(200).length ?? 0,
      cancelledRequestCount: this.requestTracker?.getCancelledCount(),
      timeoutRequestCount: this.requestTracker?.getTimeoutCount(),
      duplicateRequestCount: this.requestTracker?.getDuplicateCount(),
      slowestRequestMs: this.requestTracker?.getRecentCompletions(1).reduce(
        (max, entry) => Math.max(max, entry.durationMs ?? 0),
        0
      ) ?? 0,
      requestDurations: this.requestTracker?.getRecentDurations(30) ?? [],
      recentFailures: this.requestTracker?.getRecentErrors(20) ?? [],
      memoryEstimate: this.safeRead(() => (performance as any).memory?.usedJSHeapSize),
      playbackState: input.playbackState ?? 'idle',
      playbackDecision: input.playbackDecision ?? null,
      mediaCodecs: input.mediaCodecs,
      lastLifecycleEvent: input.lastLifecycleEvent ?? null,
      lastPlaybackError: this.lastPlaybackError,
      lastUiError: this.lastUiError,
      currentPositionTicks: undefined,
      authentication: this.sessionSnapshot ? { ...this.sessionSnapshot } : null,
      playbackDetails: this.playbackSnapshot ? { ...this.playbackSnapshot } : null,
      recentFocusTransitions: this.focusTransitions.slice(-12)
    };
  }

  public toDiagnosticText(snapshot: PtvDiagnosticsSnapshot) {
    return redactSensitiveText(JSON.stringify(snapshot, null, 2));
  }

  public getRecentLogs() {
    return [...this.logs];
  }

  private push(level: DiagnosticsLog['level'], message: string, details?: unknown) {
    const entry: DiagnosticsLog = {
      id: `log_${Date.now()}_${++this.logSequence}`,
      at: new Date().toISOString(),
      level,
      message: redactSensitiveText(message),
      details: this.renderDetails(details)
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  private renderDetails(details?: unknown) {
    if (!details) return null;
    if (typeof details === 'string') return this.redactSecrets(details);
    try {
      return this.redactSecrets(JSON.stringify(details));
    } catch {
      return '[unserializable details]';
    }
  }

  private redactSecrets(value: string) {
    return redactSensitiveText(value);
  }

  private sanitizeRecord(input: Record<string, unknown>) {
    try {
      return JSON.parse(this.redactSecrets(JSON.stringify(input))) as Record<string, unknown>;
    } catch {
      return { error: '[unserializable diagnostics]' };
    }
  }

  private redactServerUrl(rawUrl: string) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.hostname.split('.');
      if (parts.length > 2) {
        parts[0] = '***';
      }
      return `${parsed.protocol}//${parts.join('.')} (redacted)`;
    } catch {
      return '[redacted-server]';
    }
  }

  private redactSensitive(input?: string | null) {
    if (!input) return '[redacted]';
    return `${input.slice(0, 6)}...${input.slice(-4)}`;
  }

  private safeRead<T>(fn: () => T) {
    try {
      return fn();
    } catch {
      return null;
    }
  }
}
