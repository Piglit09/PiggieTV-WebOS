import type { PtvDiagnosticsSnapshot } from '../types/ptv';
import type { RequestTracker } from './requestTracker';
import { redactSensitiveText } from './redaction';
import {
  HomePerformanceStore,
  type HomePerformanceAttemptUpdate
} from './homePerformance';

interface DiagnosticsLog {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: string | null;
}

export interface DiagnosticsSnapshotInput {
  appVersion: string;
  packageId: string;
  buildTimestamp: string;
  mode: 'development' | 'production';
  route: string;
  previousRoute: string | null;
  focusId: string | null;
  previousFocusId: string | null;
  userAgent: string;
  visibilityState: string;
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
  currentSession?: {
    envelopeSchemaVersion: number | null;
    sessionSchemaVersion: number | null;
    sessionPresent: boolean;
    inMemorySessionPresent: boolean;
    tokenPresent: boolean;
    serverUrl?: string | null;
    userId?: string | null;
  } | null;
}

export class DiagnosticsService {
  private logs: DiagnosticsLog[] = [];
  private lastUiError: string | null = null;
  private lastPlaybackError: string | null = null;
  private sessionSnapshot: Record<string, unknown> | null = null;
  private sessionRestoreSnapshot: Record<string, unknown> | null = null;
  private playbackSnapshot: Record<string, unknown> | null = null;
  private sessionRestoreEvents: Array<Record<string, unknown>> = [];
  private inputEvents: Array<Record<string, unknown>> = [];
  private lifecycleEvents: Array<Record<string, unknown>> = [];
  private navigationEvents: Array<Record<string, unknown>> = [];
  private focusTransitions: Array<Record<string, unknown>> = [];
  private lastRouteFocusRestore: Record<string, unknown> | null = null;
  private logSequence = 0;
  private readonly maxLogs = 200;
  private requestTracker?: RequestTracker;
  private readonly homePerformance = new HomePerformanceStore();

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

  public recordSessionSnapshot(snapshot: object) {
    this.sessionSnapshot = this.sanitizeRecord(snapshot);
  }

  public recordSessionRestore(snapshot: object) {
    const safeSnapshot = this.withTimestamp(snapshot);
    this.sessionRestoreSnapshot = safeSnapshot;
    this.pushBounded(this.sessionRestoreEvents, safeSnapshot, 30);
  }

  public recordPlaybackSnapshot(snapshot: object) {
    this.playbackSnapshot = this.sanitizeRecord(snapshot);
  }

  public recordInputEvent(event: object) {
    this.pushBounded(this.inputEvents, this.withTimestamp(event), 40);
  }

  public recordLifecycleEvent(event: string | object) {
    const record = typeof event === 'string' ? { event } : event;
    this.pushBounded(this.lifecycleEvents, this.withTimestamp(record), 30);
  }

  public recordNavigationEvent(event: object) {
    this.pushBounded(this.navigationEvents, this.withTimestamp(event), 30);
  }

  public recordFocusTransition(transition: object) {
    const safeTransition = this.sanitizeRecord(transition);
    this.pushBounded(this.focusTransitions, safeTransition, 30);
    const reason = safeTransition.reason;
    if (reason === 'route-restore' || reason === 'route-fallback' || reason === 'route-change') {
      this.lastRouteFocusRestore = { ...safeTransition };
    }
  }

  public resetErrors() {
    this.lastPlaybackError = null;
    this.lastUiError = null;
  }

  public synchronizeHomePerformanceSession(sessionKey: string | null) {
    this.homePerformance.synchronizeSession(sessionKey);
  }

  public beginHomePerformanceAttempt() {
    return this.homePerformance.beginAttempt();
  }

  public recordHomePerformance(update: HomePerformanceAttemptUpdate) {
    return this.homePerformance.upsert(update);
  }

  public getHomePerformanceSnapshot() {
    return this.homePerformance.snapshot();
  }

  public snapshot(input: DiagnosticsSnapshotInput): PtvDiagnosticsSnapshot {
    const safeUrl = this.redactServerUrl(input.serverUrl);
    const safeUser = this.redactSensitive(input.userId);
    const lastRouteChange = this.navigationEvents
      .slice()
      .reverse()
      .find(event => event.type === 'route-change');
    const recordedPreviousRoute = lastRouteChange?.previousRoute;
    const recordedPlaybackState = this.playbackSnapshot?.state;
    const recordedPlaybackDecision = this.playbackSnapshot?.decision;
    const recordedVideoCodec = this.playbackSnapshot?.videoCodec;
    const recordedAudioCodec = this.playbackSnapshot?.audioCodec;
    const recordedPosition = this.playbackSnapshot?.currentTime;

    return {
      appVersion: input.appVersion,
      packageId: input.packageId,
      buildTimestamp: input.buildTimestamp,
      commitHash: input.commitHash ?? null,
      mode: input.mode,
      webosVersion: this.safeRead(() => (window as any).webOS?.version || null),
      tvModel: this.safeRead(() => (window as any).webOS?.deviceInfo?.productName || null),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio ?? 1,
      userAgent: redactSensitiveText(input.userAgent),
      visibilityState: input.visibilityState,
      serverVersion: input.serverVersion ?? null,
      serverUrl: safeUrl,
      userId: safeUser,
      pluginVersion: input.ptvPluginVersion ?? null,
      pluginApiVersion: input.ptvApiVersion ?? null,
      capabilities: input.capabilities,
      currentRoute: this.sanitizeRoute(input.route) ?? 'unknown',
      previousRoute: this.sanitizeRoute(typeof recordedPreviousRoute === 'string' ? recordedPreviousRoute : input.previousRoute),
      currentFocusId: this.sanitizeFocusId(input.focusId),
      previousFocusId: this.sanitizeFocusId(input.previousFocusId),
      activeRequests: this.requestTracker?.getActiveCount() ?? 0,
      peakConcurrentRequests: this.requestTracker?.getPeakConcurrency() ?? 0,
      recentCompletions: this.requestTracker?.getRecentRequests(20).map(entry => ({
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
      slowestRequestMs: this.requestTracker?.getSlowestDuration() ?? 0,
      requestDurations: this.requestTracker?.getRecentDurations(30) ?? [],
      recentFailures: this.requestTracker?.getRecentErrors(20) ?? [],
      memoryEstimate: this.safeRead(() => (performance as any).memory?.usedJSHeapSize),
      playbackState: input.playbackState
        ?? (typeof recordedPlaybackState === 'string' ? recordedPlaybackState : 'idle'),
      playbackDecision: input.playbackDecision
        ?? (typeof recordedPlaybackDecision === 'string' ? recordedPlaybackDecision : null),
      mediaCodecs: input.mediaCodecs ?? (
        [recordedVideoCodec, recordedAudioCodec]
          .filter((codec): codec is string => typeof codec === 'string' && codec.length > 0)
          .join('/') || undefined
      ),
      lastLifecycleEvent: input.lastLifecycleEvent ?? this.getLastEventLabel(this.lifecycleEvents),
      lastPlaybackError: this.lastPlaybackError,
      lastUiError: this.lastUiError,
      currentPositionTicks: typeof recordedPosition === 'number' && Number.isFinite(recordedPosition)
        ? Math.max(0, Math.round(recordedPosition * 10_000_000))
        : undefined,
      authentication: this.sessionSnapshot ? { ...this.sessionSnapshot } : null,
      currentSession: input.currentSession ? {
        envelopeSchemaVersion: input.currentSession.envelopeSchemaVersion,
        sessionSchemaVersion: input.currentSession.sessionSchemaVersion,
        sessionPresent: input.currentSession.sessionPresent,
        inMemorySessionPresent: input.currentSession.inMemorySessionPresent,
        tokenPresent: input.currentSession.tokenPresent,
        serverOrigin: input.currentSession.serverUrl
          ? this.redactServerUrl(input.currentSession.serverUrl)
          : null,
        userIdSuffix: this.redactSensitive(input.currentSession.userId)
      } : null,
      sessionRestore: this.sessionRestoreSnapshot ? { ...this.sessionRestoreSnapshot } : null,
      recentSessionRestoreEvents: this.sessionRestoreEvents.slice(-12).map(event => ({ ...event })),
      playbackDetails: this.playbackSnapshot ? { ...this.playbackSnapshot } : null,
      lastInputEvent: this.getLastEvent(this.inputEvents),
      recentInputEvents: this.inputEvents.slice(-16).map(event => ({ ...event })),
      lastNavigationEvent: this.getLastEvent(this.navigationEvents),
      recentNavigationEvents: this.navigationEvents.slice(-12).map(event => ({ ...event })),
      recentLifecycleEvents: this.lifecycleEvents.slice(-12).map(event => ({ ...event })),
      lastRouteFocusRestore: this.lastRouteFocusRestore ? { ...this.lastRouteFocusRestore } : null,
      recentFocusTransitions: this.focusTransitions.slice(-12).map(event => ({ ...event })),
      homePerformance: this.homePerformance.snapshot()
    };
  }

  public toDiagnosticText(snapshot: unknown) {
    try {
      return redactSensitiveText(JSON.stringify(snapshot, null, 2) ?? '[diagnostics unavailable]');
    } catch {
      return '[diagnostics unavailable]';
    }
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

  private sanitizeRecord(input: object) {
    try {
      const safe = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
      return this.sanitizeKnownFields(safe) as Record<string, unknown>;
    } catch {
      return { error: '[unserializable diagnostics]' };
    }
  }

  private sanitizeKnownFields(value: unknown, key = ''): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.sanitizeKnownFields(item));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, childKey) => {
        result[childKey] = this.sanitizeKnownFields((value as Record<string, unknown>)[childKey], childKey);
        return result;
      }, {});
    }
    if (typeof value !== 'string') return value;

    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      normalizedKey === 'token' ||
      normalizedKey === 'accesstoken' ||
      normalizedKey === 'apikey' ||
      normalizedKey === 'authorization' ||
      normalizedKey === 'password' ||
      normalizedKey === 'secret' ||
      normalizedKey === 'code'
    ) {
      return '[redacted]';
    }
    if (normalizedKey === 'userid') return this.redactSensitive(value);
    if (normalizedKey === 'serverurl' || normalizedKey === 'serverorigin') return this.redactServerUrl(value);
    if (normalizedKey.endsWith('route') || normalizedKey === 'routeid') return this.sanitizeRoute(value);
    if (normalizedKey.endsWith('focusid')) return this.sanitizeFocusId(value);
    return redactSensitiveText(value);
  }

  private withTimestamp(input: object) {
    const candidate = input as Record<string, unknown>;
    return this.sanitizeRecord({ timestamp: Date.now(), ...candidate });
  }

  private pushBounded(target: Array<Record<string, unknown>>, event: Record<string, unknown>, maximum: number) {
    target.push({ ...event });
    while (target.length > maximum) target.shift();
  }

  private getLastEvent(events: Array<Record<string, unknown>>) {
    const event = events[events.length - 1];
    return event ? { ...event } : null;
  }

  private getLastEventLabel(events: Array<Record<string, unknown>>) {
    const event = events[events.length - 1];
    if (!event) return null;
    const label = event.event ?? event.name ?? event.type;
    return typeof label === 'string' ? label : null;
  }

  private redactServerUrl(rawUrl: string) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.hostname.split('.');
      if (parts.length > 2) {
        parts[0] = '***';
      }
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//${parts.join('.')}${port} (redacted)`;
    } catch {
      return '[redacted-server]';
    }
  }

  private redactSensitive(input?: string | null) {
    if (!input) return '[redacted]';
    return input.length > 4 ? `...${input.slice(-4)}` : '[redacted]';
  }

  private sanitizeRoute(input?: string | null) {
    if (!input) return null;
    return redactSensitiveText(input)
      .replace(/\b(details|playback):[^?\s]+/gi, '$1:[redacted]')
      .replace(/([?&]section=)[^&\s]+/gi, '$1[redacted]');
  }

  private sanitizeFocusId(input?: string | null) {
    if (!input) return null;
    return redactSensitiveText(input)
      .replace(/^(home-(?:continue|nextup|movies|shows)-).+$/i, '$1[redacted]')
      .replace(/^((?:browse|movie|show|search)-[^-]+-).+$/i, '$1[redacted]')
      .replace(/^(details-(?:episode|season)-)\w{8,}$/i, '$1[redacted]');
  }

  private safeRead<T>(fn: () => T) {
    try {
      return fn();
    } catch {
      return null;
    }
  }
}
