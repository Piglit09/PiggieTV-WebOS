import { DiagnosticsService } from '../core/diagnostics';
import { redactSensitiveText } from '../core/redaction';
import {
  clampMediaSeek,
  finiteMediaDuration,
  safeMediaPosition,
  secondsToTicks,
  type MediaSeekRange
} from '../utils/format';

export type PlaybackEngineState =
  | 'idle'
  | 'resolving'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error'
  | 'stopping';

// Kept on the listener boundary until PlaybackScreen migrates from the legacy
// engine surface. It is never stored as an authoritative engine state.
export type PlaybackEngineEventState = PlaybackEngineState | 'stopped';

export type PlaybackStopReason = 'user' | 'back' | 'pagehide' | 'ended' | 'superseded' | 'detached' | 'disposed';
export type PlaybackStreamMode = 'direct-play' | 'direct-stream' | 'transcode';
export type PlaybackPlayPromiseResult = 'pending' | 'fulfilled' | 'rejected' | 'cancelled';
export type PlaybackReportKind = 'playing' | 'progress' | 'stopped';
export type PlaybackReportStatus = 'queued' | 'attempted' | 'succeeded' | 'failed' | 'skipped';

export type PlaybackReportCallbackResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string };

export interface PlaybackReportCounts {
  playing: number;
  progress: number;
  stopped: number;
}

export interface PlaybackReportEvidence {
  queued: PlaybackReportCounts;
  attempted: PlaybackReportCounts;
  succeeded: PlaybackReportCounts;
  failed: PlaybackReportCounts;
  skipped: PlaybackReportCounts;
  last: {
    kind: PlaybackReportKind;
    status: PlaybackReportStatus;
    at: number;
    reason: string | null;
  } | null;
}

export interface PlaybackTimeRangeSummary {
  count: number;
  ranges: MediaSeekRange[];
  totalSeconds: number;
  truncated: boolean;
}

export interface PlaybackMediaEventRecord {
  event: string;
  timestamp: number;
  readyState: number;
  networkState: number;
  currentTime: number;
}

export interface PlaybackStartRequest {
  itemId: string;
  startPositionSeconds?: number | null;
  metadata?: Record<string, unknown>;
}

export interface PlaybackResolvedSource {
  url: string;
  playSessionId?: string | null;
  mediaSourceId?: string | null;
  mode?: PlaybackStreamMode | null;
  container?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  sourceContainer?: string | null;
  sourceVideoCodec?: string | null;
  sourceAudioCodec?: string | null;
  requestedOutputProtocol?: string | null;
  requestedOutputContainer?: string | null;
  requestedOutputVideoCodec?: string | null;
  requestedOutputAudioCodec?: string | null;
}

export interface PlaybackResolveContext {
  attemptId: string;
  signal: AbortSignal;
}

export interface PlaybackReport {
  attemptId: string;
  itemId: string;
  playSessionId: string | null;
  mediaSourceId: string | null;
  positionSeconds: number;
  positionTicks: number;
  isPaused: boolean;
  ended: boolean;
  reason?: PlaybackStopReason;
}

export interface PlaybackStartResult {
  attemptId: string;
  status: 'started' | 'cancelled';
}

export interface PlaybackDiagnosticsSnapshot {
  attemptId: string | null;
  activeAttemptId: string | null;
  state: PlaybackEngineState;
  itemIdSuffix: string | null;
  mediaSourceIdSuffix: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sourceContainer: string | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  requestedOutputProtocol: string | null;
  requestedOutputContainer: string | null;
  requestedOutputVideoCodec: string | null;
  requestedOutputAudioCodec: string | null;
  selectedOutputProtocol: string | null;
  selectedOutputContainer: string | null;
  selectedOutputVideoCodec: string | null;
  selectedOutputAudioCodec: string | null;
  selectedOutputEvidence: string | null;
  decision: PlaybackStreamMode | null;
  finalUrlOrigin: string | null;
  finalUrlPathCategory: string | null;
  readyState: number;
  networkState: number;
  currentTime: number;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  canSeek: boolean;
  bufferedRanges: PlaybackTimeRangeSummary;
  seekableRanges: PlaybackTimeRangeSummary;
  sourcePresent: boolean;
  progressReportingActive: boolean;
  lastStopReason: PlaybackStopReason | null;
  lastMediaEvent: string | null;
  mediaEventHistory: PlaybackMediaEventRecord[];
  mediaEventHistoryTruncated: boolean;
  mediaEventCounts: Record<string, number>;
  lastMediaErrorCode: number | null;
  lastMediaErrorMessage: string | null;
  lastPlayPromiseResult: PlaybackPlayPromiseResult | null;
  lastPlayPromiseError: string | null;
  lastPlayerError: string | null;
  sourceAssignments: number;
  loadCalls: number;
  playCalls: number;
  playingReports: number;
  progressReports: number;
  stoppedReports: number;
  reportEvidence: PlaybackReportEvidence;
}

export interface PlaybackEngineListeners {
  onPlayState?: (state: PlaybackEngineEventState, payload?: Record<string, unknown>) => void;
  onError?: (message: string) => void;
  onDiagnostics?: (snapshot: PlaybackDiagnosticsSnapshot) => void;
}

export interface PlaybackEngineDependencies {
  resolveSource?: (
    request: PlaybackStartRequest,
    context: PlaybackResolveContext
  ) => Promise<PlaybackResolvedSource>;
  reportPlaying?: (report: PlaybackReport) => Promise<PlaybackReportCallbackResult | void> | PlaybackReportCallbackResult | void;
  reportProgress?: (report: PlaybackReport) => Promise<PlaybackReportCallbackResult | void> | PlaybackReportCallbackResult | void;
  reportStopped?: (report: PlaybackReport) => Promise<PlaybackReportCallbackResult | void> | PlaybackReportCallbackResult | void;
  progressIntervalMs?: number;
  readinessTimeoutMs?: number;
  createAttemptId?: () => string;
  setInterval?: (callback: () => void, milliseconds: number) => number;
  clearInterval?: (handle: number) => void;
  setTimeout?: (callback: () => void, milliseconds: number) => number;
  clearTimeout?: (handle: number) => void;
}

interface MutablePlaybackDiagnostics {
  attemptId: string | null;
  itemIdSuffix: string | null;
  mediaSourceIdSuffix: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sourceContainer: string | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  requestedOutputProtocol: string | null;
  requestedOutputContainer: string | null;
  requestedOutputVideoCodec: string | null;
  requestedOutputAudioCodec: string | null;
  selectedOutputProtocol: string | null;
  selectedOutputContainer: string | null;
  selectedOutputVideoCodec: string | null;
  selectedOutputAudioCodec: string | null;
  selectedOutputEvidence: string | null;
  decision: PlaybackStreamMode | null;
  finalUrlOrigin: string | null;
  finalUrlPathCategory: string | null;
  lastStopReason: PlaybackStopReason | null;
  lastMediaEvent: string | null;
  mediaEventHistory: PlaybackMediaEventRecord[];
  mediaEventCount: number;
  mediaEventCounts: Record<string, number>;
  lastRecordedTimeUpdateAt: number | null;
  lastMediaErrorCode: number | null;
  lastMediaErrorMessage: string | null;
  lastPlayPromiseResult: PlaybackPlayPromiseResult | null;
  lastPlayPromiseError: string | null;
  lastPlayerError: string | null;
  sourceAssignments: number;
  loadCalls: number;
  playCalls: number;
  playingReports: number;
  progressReports: number;
  stoppedReports: number;
  reportEvidence: PlaybackReportEvidence;
}

interface ActivePlaybackAttempt {
  id: string;
  request: PlaybackStartRequest;
  controller: AbortController;
  resolvedSource: PlaybackResolvedSource | null;
  metrics: MutablePlaybackDiagnostics;
  hasStarted: boolean;
  stoppedReportQueued: boolean;
  progressReportPending: boolean;
  progressReportQueued: boolean;
}

interface ReadinessWaiter {
  attemptId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: number;
  abortListener: () => void;
}

const HAVE_FUTURE_DATA = 3;
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_RANGES = 8;
const MAX_TIME_RANGES_TO_SCAN = 64;
const MAX_MEDIA_EVENT_HISTORY = 80;
const TIMEUPDATE_DIAGNOSTIC_INTERVAL_MS = 1_000;
const PASSIVE_MEDIA_EVENTS = [
  'abort',
  'canplaythrough',
  'emptied',
  'encrypted',
  'loadstart',
  'play',
  'progress',
  'ratechange',
  'resize',
  'suspend',
  'volumechange',
  'waitingforkey'
] as const;
let attemptSequence = 0;

function createDefaultAttemptId() {
  attemptSequence += 1;
  return `playback-${Date.now().toString(36)}-${attemptSequence.toString(36)}`;
}

function emptyReportCounts(): PlaybackReportCounts {
  return { playing: 0, progress: 0, stopped: 0 };
}

function emptyReportEvidence(): PlaybackReportEvidence {
  return {
    queued: emptyReportCounts(),
    attempted: emptyReportCounts(),
    succeeded: emptyReportCounts(),
    failed: emptyReportCounts(),
    skipped: emptyReportCounts(),
    last: null
  };
}

function emptyDiagnostics(): MutablePlaybackDiagnostics {
  return {
    attemptId: null,
    itemIdSuffix: null,
    mediaSourceIdSuffix: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    sourceContainer: null,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    requestedOutputProtocol: null,
    requestedOutputContainer: null,
    requestedOutputVideoCodec: null,
    requestedOutputAudioCodec: null,
    selectedOutputProtocol: null,
    selectedOutputContainer: null,
    selectedOutputVideoCodec: null,
    selectedOutputAudioCodec: null,
    selectedOutputEvidence: null,
    decision: null,
    finalUrlOrigin: null,
    finalUrlPathCategory: null,
    lastStopReason: null,
    lastMediaEvent: null,
    mediaEventHistory: [],
    mediaEventCount: 0,
    mediaEventCounts: {},
    lastRecordedTimeUpdateAt: null,
    lastMediaErrorCode: null,
    lastMediaErrorMessage: null,
    lastPlayPromiseResult: null,
    lastPlayPromiseError: null,
    lastPlayerError: null,
    sourceAssignments: 0,
    loadCalls: 0,
    playCalls: 0,
    playingReports: 0,
    progressReports: 0,
    stoppedReports: 0,
    reportEvidence: emptyReportEvidence()
  };
}

function idSuffix(value?: string | null) {
  if (!value) return null;
  return value.slice(-6);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'Playback failed';
}

function safeErrorMessage(error: unknown) {
  return redactSensitiveText(errorMessage(error));
}

function summarizeRanges(ranges: MediaSeekRange[], sourceLength: number): PlaybackTimeRangeSummary {
  const visibleRanges = ranges.slice(0, MAX_DIAGNOSTIC_RANGES).map(range => ({ ...range }));
  const totalSeconds = ranges.reduce((total, range) => {
    const next = total + Math.max(0, range.end - range.start);
    return Number.isFinite(next) ? next : Number.MAX_SAFE_INTEGER;
  }, 0);
  return {
    count: ranges.length,
    ranges: visibleRanges,
    totalSeconds,
    truncated: ranges.length > visibleRanges.length || sourceLength > MAX_TIME_RANGES_TO_SCAN
  };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function cancelledError(message = 'Playback attempt was cancelled') {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const fallback = new Error(message);
    fallback.name = 'AbortError';
    return fallback;
  }
}

function streamDescriptor(url: string, mode?: PlaybackStreamMode | null) {
  try {
    const base = typeof window === 'undefined' ? undefined : window.location.href;
    const parsed = base ? new URL(url, base) : new URL(url);
    const lowerPath = parsed.pathname.toLowerCase();
    const category = mode ?? (
      lowerPath.includes('transcod') ? 'transcode' :
      lowerPath.includes('/stream') ? 'stream' :
      lowerPath.includes('/videos/') ? 'video' :
      'media'
    );
    return { origin: parsed.origin, category };
  } catch {
    return { origin: null, category: mode ?? 'media' };
  }
}

function selectedOutputDescriptor(
  url: string,
  mode: PlaybackStreamMode | null | undefined,
  source: Pick<PlaybackResolvedSource, 'sourceContainer' | 'sourceVideoCodec' | 'sourceAudioCodec' | 'container' | 'videoCodec' | 'audioCodec'>
) {
  const sourceContainer = source.sourceContainer ?? source.container ?? null;
  const sourceVideoCodec = source.sourceVideoCodec ?? source.videoCodec ?? null;
  const sourceAudioCodec = source.sourceAudioCodec ?? source.audioCodec ?? null;

  try {
    const base = typeof window === 'undefined' ? undefined : window.location.href;
    const parsed = base ? new URL(url, base) : new URL(url);
    const query = new Map<string, string>();
    parsed.searchParams.forEach((value, key) => query.set(key.toLowerCase(), value));
    const queryValue = (...keys: string[]) => {
      for (const key of keys) {
        const value = query.get(key.toLowerCase());
        if (value?.trim()) return value.trim().toLowerCase();
      }
      return null;
    };
    const extensionMatch = parsed.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    const extension = extensionMatch?.[1] ?? null;
    const urlProtocol = parsed.protocol ? parsed.protocol.replace(/:$/, '').toLowerCase() : null;
    const mediaProtocol = urlProtocol === 'http' || urlProtocol === 'https' ? 'http' : urlProtocol;
    const selectedProtocol = queryValue('TranscodingProtocol', 'Protocol')
      ?? (extension === 'm3u8' ? 'hls' : mediaProtocol);
    const selectedContainer = queryValue('SegmentContainer', 'TranscodingContainer', 'Container')
      ?? (extension && extension !== 'm3u8' ? extension : null)
      ?? (mode === 'direct-play' ? sourceContainer : null);
    const selectedVideoCodec = queryValue('VideoCodec')
      ?? (mode === 'direct-play' || mode === 'direct-stream' ? sourceVideoCodec : null);
    const selectedAudioCodec = queryValue('AudioCodec')
      ?? (mode === 'direct-play' || mode === 'direct-stream' ? sourceAudioCodec : null);
    return {
      protocol: selectedProtocol,
      container: selectedContainer,
      videoCodec: selectedVideoCodec,
      audioCodec: selectedAudioCodec,
      evidence: mode === 'direct-play' ? 'direct-source-and-stream-url' : 'server-selected-stream-url'
    };
  } catch {
    return {
      protocol: null,
      container: mode === 'direct-play' ? sourceContainer : null,
      videoCodec: mode === 'direct-play' ? sourceVideoCodec : null,
      audioCodec: mode === 'direct-play' ? sourceAudioCodec : null,
      evidence: mode === 'direct-play' ? 'direct-source' : null
    };
  }
}

export class PlaybackEngine {
  private media?: HTMLVideoElement;
  private state: PlaybackEngineState = 'idle';
  private disposed = false;
  private listenersBound = false;
  private hasAssignedSource = false;
  private activeAttempt: ActivePlaybackAttempt | null = null;
  private readinessWaiter: ReadinessWaiter | null = null;
  private progressTimer: number | null = null;
  private reportChain: Promise<void> = Promise.resolve();
  private metrics: MutablePlaybackDiagnostics = emptyDiagnostics();

  constructor(
    private readonly diagnostics?: DiagnosticsService,
    private readonly listeners: PlaybackEngineListeners = {},
    private readonly dependencies: PlaybackEngineDependencies = {}
  ) {}

  public attach(media: HTMLVideoElement) {
    if (this.disposed) {
      throw new Error('Cannot attach a disposed playback engine');
    }
    if (this.media && this.media !== media) {
      this.detach();
    }
    this.media = media;
    this.attachMediaListeners();
    this.emitDiagnostics();
  }

  public detach() {
    const media = this.media;
    const shouldStop = this.hasActiveLifecycle();
    const report = shouldStop ? this.stop('detached') : this.reportChain;
    if (media) this.detachMediaListeners(media);
    this.media = undefined;
    this.emitDiagnostics();
    void report;
  }

  public dispose() {
    if (this.disposed) return;
    const media = this.media;
    const report = this.hasActiveLifecycle() ? this.stop('disposed') : this.reportChain;
    if (media) this.detachMediaListeners(media);
    this.media = undefined;
    this.disposed = true;
    this.emitDiagnostics();
    void report;
  }

  public async start(request: PlaybackStartRequest): Promise<PlaybackStartResult> {
    if (this.disposed) throw new Error('Cannot start a disposed playback engine');
    if (!this.media) throw new Error('A video element must be attached before playback starts');

    this.attachMediaListeners();
    this.supersedeCurrentAttempt();

    const attemptId = (this.dependencies.createAttemptId ?? createDefaultAttemptId)();
    const metrics = emptyDiagnostics();
    metrics.attemptId = attemptId;
    metrics.itemIdSuffix = idSuffix(request.itemId);
    const attempt: ActivePlaybackAttempt = {
      id: attemptId,
      request,
      controller: new AbortController(),
      resolvedSource: null,
      metrics,
      hasStarted: false,
      stoppedReportQueued: false,
      progressReportPending: false,
      progressReportQueued: false
    };
    this.activeAttempt = attempt;
    this.metrics = metrics;
    this.transition('resolving');

    try {
      const resolver = this.dependencies.resolveSource;
      if (!resolver) throw new Error('No playback source resolver was configured');
      const resolved = await resolver(request, {
        attemptId,
        signal: attempt.controller.signal
      });
      if (!this.isActive(attempt)) return { attemptId, status: 'cancelled' };
      if (!resolved || typeof resolved.url !== 'string' || !resolved.url.trim()) {
        throw new Error('Playback resolver did not return a media URL');
      }

      attempt.resolvedSource = resolved;
      this.updateResolvedDiagnostics(attempt, resolved);
      this.transition('loading');
      this.assignSource(resolved.url);
      await this.waitForReadiness(attempt);
      if (!this.isActive(attempt)) return { attemptId, status: 'cancelled' };

      this.transition('ready');
      const startPosition = request.startPositionSeconds;
      if (typeof startPosition === 'number' && startPosition > 0) {
        this.seek(startPosition);
      }

      const started = await this.invokePlay(attempt);
      if (!started || !this.isActive(attempt)) return { attemptId, status: 'cancelled' };
      attempt.hasStarted = true;
      this.transition('playing');
      this.queueReport('playing', attempt);
      this.startProgressTimer(attempt);
      return { attemptId, status: 'started' };
    } catch (error) {
      if (this.isExpectedCancellation(error, attempt)) {
        return { attemptId, status: 'cancelled' };
      }
      this.handleFatalError(error, attempt);
      throw error;
    } finally {
      this.clearReadinessWaiter(attempt.id);
    }
  }

  public async play() {
    if (!this.media || this.disposed) return;
    const attempt = this.activeAttempt;
    if (!attempt || !this.isActive(attempt) || this.state === 'ended' || this.state === 'error') return;
    try {
      const started = await this.invokePlay(attempt);
      if (!started) return;
      if (attempt) {
        const firstStart = !attempt.hasStarted;
        attempt.hasStarted = true;
        if (firstStart) this.queueReport('playing', attempt);
        this.startProgressTimer(attempt);
      }
      this.transition('playing');
    } catch (error) {
      if (attempt && this.isExpectedCancellation(error, attempt)) return;
      this.handleFatalError(error, attempt);
    }
  }

  public pause() {
    if (!this.media || this.disposed) return;
    const attempt = this.activeAttempt;
    if (!attempt || !this.isActive(attempt) || this.state === 'ended' || this.state === 'error') return;
    try {
      this.media.pause();
      if (this.state !== 'stopping' && this.state !== 'idle') this.transition('paused');
      if (attempt.hasStarted) this.queueProgressReport(attempt);
    } catch (error) {
      this.handleFatalError(error, attempt);
    }
  }

  public stop(reason: PlaybackStopReason = 'user'): Promise<void> {
    const attempt = this.activeAttempt;
    const hadActiveLifecycle = this.hasActiveLifecycle();
    if (hadActiveLifecycle) {
      this.metrics.lastStopReason = reason;
      if (this.metrics.lastPlayPromiseResult === 'pending') {
        this.metrics.lastPlayPromiseResult = 'cancelled';
      }
    }
    if (attempt) {
      this.activeAttempt = null;
      attempt.controller.abort(reason);
      attempt.progressReportQueued = false;
      this.clearProgressTimer();
      this.clearReadinessWaiter(attempt.id, cancelledError());
    } else {
      this.clearProgressTimer();
      this.clearReadinessWaiter(undefined, cancelledError());
    }

    this.transition('stopping', { reason });
    const stoppedReport = attempt?.hasStarted
      ? this.queueStoppedReport(attempt, reason)
      : this.reportChain;
    this.resetMedia();
    if (this.media) this.detachMediaListeners(this.media);
    this.transition('idle', { reason });
    return stoppedReport;
  }

  public seek(seconds: number) {
    if (!this.media || this.disposed) return false;
    const duration = finiteMediaDuration(this.media.duration);
    const target = clampMediaSeek(seconds, duration, this.readMediaRanges('seekable'));
    if (target == null) return false;

    try {
      this.media.currentTime = target;
      this.recordMediaEvent('seek-requested');
      return true;
    } catch (error) {
      this.handleFatalError(error, this.activeAttempt);
      return false;
    }
  }

  public canSeek() {
    if (!this.media) return false;
    return finiteMediaDuration(this.media.duration) != null && this.readMediaRanges('seekable').length > 0;
  }

  public getState() {
    return this.state;
  }

  public getActiveAttemptId() {
    return this.activeAttempt?.id ?? null;
  }

  public getDiagnosticsSnapshot(): PlaybackDiagnosticsSnapshot {
    const media = this.media;
    const bufferedSourceLength = this.readMediaRangeLength('buffered');
    const seekableSourceLength = this.readMediaRangeLength('seekable');
    const bufferedRanges = this.readMediaRanges('buffered');
    const seekableRanges = this.readMediaRanges('seekable');
    const duration = finiteMediaDuration(media?.duration);
    return {
      attemptId: this.metrics.attemptId,
      activeAttemptId: this.activeAttempt?.id ?? null,
      state: this.state,
      itemIdSuffix: this.metrics.itemIdSuffix,
      mediaSourceIdSuffix: this.metrics.mediaSourceIdSuffix,
      container: this.metrics.container,
      videoCodec: this.metrics.videoCodec,
      audioCodec: this.metrics.audioCodec,
      sourceContainer: this.metrics.sourceContainer,
      sourceVideoCodec: this.metrics.sourceVideoCodec,
      sourceAudioCodec: this.metrics.sourceAudioCodec,
      requestedOutputProtocol: this.metrics.requestedOutputProtocol,
      requestedOutputContainer: this.metrics.requestedOutputContainer,
      requestedOutputVideoCodec: this.metrics.requestedOutputVideoCodec,
      requestedOutputAudioCodec: this.metrics.requestedOutputAudioCodec,
      selectedOutputProtocol: this.metrics.selectedOutputProtocol,
      selectedOutputContainer: this.metrics.selectedOutputContainer,
      selectedOutputVideoCodec: this.metrics.selectedOutputVideoCodec,
      selectedOutputAudioCodec: this.metrics.selectedOutputAudioCodec,
      selectedOutputEvidence: this.metrics.selectedOutputEvidence,
      decision: this.metrics.decision,
      finalUrlOrigin: this.metrics.finalUrlOrigin,
      finalUrlPathCategory: this.metrics.finalUrlPathCategory,
      readyState: media?.readyState ?? 0,
      networkState: media?.networkState ?? 0,
      currentTime: safeMediaPosition(media?.currentTime),
      duration,
      paused: media?.paused ?? true,
      ended: media?.ended ?? false,
      canSeek: duration != null && seekableRanges.length > 0,
      bufferedRanges: summarizeRanges(bufferedRanges, bufferedSourceLength),
      seekableRanges: summarizeRanges(seekableRanges, seekableSourceLength),
      sourcePresent: this.sourceIsPresent(),
      progressReportingActive: this.progressTimer !== null,
      lastStopReason: this.metrics.lastStopReason,
      lastMediaEvent: this.metrics.lastMediaEvent,
      mediaEventHistory: this.metrics.mediaEventHistory.map(entry => ({ ...entry })),
      mediaEventHistoryTruncated: this.metrics.mediaEventCount > this.metrics.mediaEventHistory.length,
      mediaEventCounts: { ...this.metrics.mediaEventCounts },
      lastMediaErrorCode: this.metrics.lastMediaErrorCode,
      lastMediaErrorMessage: this.metrics.lastMediaErrorMessage,
      lastPlayPromiseResult: this.metrics.lastPlayPromiseResult,
      lastPlayPromiseError: this.metrics.lastPlayPromiseError,
      lastPlayerError: this.metrics.lastPlayerError,
      sourceAssignments: this.metrics.sourceAssignments,
      loadCalls: this.metrics.loadCalls,
      playCalls: this.metrics.playCalls,
      playingReports: this.metrics.playingReports,
      progressReports: this.metrics.progressReports,
      stoppedReports: this.metrics.stoppedReports,
      reportEvidence: {
        queued: { ...this.metrics.reportEvidence.queued },
        attempted: { ...this.metrics.reportEvidence.attempted },
        succeeded: { ...this.metrics.reportEvidence.succeeded },
        failed: { ...this.metrics.reportEvidence.failed },
        skipped: { ...this.metrics.reportEvidence.skipped },
        last: this.metrics.reportEvidence.last ? { ...this.metrics.reportEvidence.last } : null
      }
    };
  }

  private assignSource(src: string) {
    if (!this.media) throw new Error('No video element is attached');
    const descriptor = streamDescriptor(src, this.metrics.decision);
    this.metrics.finalUrlOrigin = descriptor.origin;
    this.metrics.finalUrlPathCategory = descriptor.category;
    this.metrics.sourceAssignments += 1;
    this.media.src = src;
    this.hasAssignedSource = true;
    this.metrics.loadCalls += 1;
    this.media.load();
    this.emitDiagnostics();
  }

  private async invokePlay(attempt: ActivePlaybackAttempt | null) {
    const media = this.media;
    if (!media) return false;
    if (attempt && !this.isActive(attempt)) return false;
    const metrics = attempt?.metrics ?? this.metrics;
    metrics.playCalls += 1;
    metrics.lastPlayPromiseResult = 'pending';
    metrics.lastPlayPromiseError = null;
    if (this.metrics === metrics) this.emitDiagnostics();

    try {
      await Promise.resolve(media.play());
      if (attempt && !this.isActive(attempt)) {
        metrics.lastPlayPromiseResult = 'cancelled';
        if (this.metrics === metrics) this.emitDiagnostics();
        return false;
      }
      metrics.lastPlayPromiseResult = 'fulfilled';
      if (this.metrics === metrics) this.emitDiagnostics();
      return true;
    } catch (error) {
      if (attempt && this.isExpectedCancellation(error, attempt)) {
        metrics.lastPlayPromiseResult = 'cancelled';
        metrics.lastPlayPromiseError = null;
        if (this.metrics === metrics) this.emitDiagnostics();
        return false;
      }
      metrics.lastPlayPromiseResult = 'rejected';
      metrics.lastPlayPromiseError = safeErrorMessage(error);
      if (this.metrics === metrics) this.emitDiagnostics();
      throw error;
    }
  }

  private supersedeCurrentAttempt() {
    const previous = this.activeAttempt;
    if (!previous && !this.hasAssignedSource) return;

    this.metrics.lastStopReason = 'superseded';
    if (this.metrics.lastPlayPromiseResult === 'pending') {
      this.metrics.lastPlayPromiseResult = 'cancelled';
    }
    this.transition('stopping', { reason: 'superseded' });
    if (previous) {
      this.activeAttempt = null;
      previous.controller.abort('superseded');
      previous.progressReportQueued = false;
      this.clearReadinessWaiter(previous.id, cancelledError('Playback attempt was superseded'));
      if (previous.hasStarted) this.queueStoppedReport(previous, 'superseded');
    }
    this.clearProgressTimer();
    this.resetMedia();
  }

  private resetMedia() {
    const media = this.media;
    if (!media) return;
    try {
      media.pause();
    } catch {
      // Reset continues even if the platform rejects pause during teardown.
    }

    const hasSource = this.sourceIsPresent();
    if (!hasSource) return;
    media.removeAttribute('src');
    this.hasAssignedSource = false;
    this.metrics.loadCalls += 1;
    try {
      media.load();
    } catch {
      // The source has already been removed; there is no useful recovery here.
    }
    this.emitDiagnostics();
  }

  private waitForReadiness(attempt: ActivePlaybackAttempt) {
    if (!this.media) return Promise.reject(new Error('Video element was detached while loading'));
    if (this.media.readyState >= HAVE_FUTURE_DATA) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
      const abortListener = () => {
        this.clearReadinessWaiter(attempt.id, cancelledError());
      };
      const timeoutHandle = this.scheduleTimeout(() => {
        this.clearReadinessWaiter(attempt.id, new Error('Timed out waiting for media readiness'));
      }, timeoutMs);
      this.readinessWaiter = {
        attemptId: attempt.id,
        resolve,
        reject,
        timeoutHandle,
        abortListener
      };
      attempt.controller.signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  private resolveReadinessIfReady() {
    const waiter = this.readinessWaiter;
    if (!waiter || !this.media || this.media.readyState < HAVE_FUTURE_DATA) return;
    this.readinessWaiter = null;
    this.cancelTimeout(waiter.timeoutHandle);
    const attempt = this.activeAttempt;
    attempt?.controller.signal.removeEventListener('abort', waiter.abortListener);
    waiter.resolve();
  }

  private clearReadinessWaiter(attemptId?: string, rejection?: Error) {
    const waiter = this.readinessWaiter;
    if (!waiter || (attemptId && waiter.attemptId !== attemptId)) return;
    this.readinessWaiter = null;
    this.cancelTimeout(waiter.timeoutHandle);
    const attempt = this.activeAttempt;
    attempt?.controller.signal.removeEventListener('abort', waiter.abortListener);
    if (rejection) waiter.reject(rejection);
  }

  private startProgressTimer(attempt: ActivePlaybackAttempt) {
    if (!this.dependencies.reportProgress || !attempt.resolvedSource?.playSessionId || !this.isActive(attempt)) return;
    this.clearProgressTimer();
    const intervalMs = this.dependencies.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.progressTimer = this.scheduleInterval(() => {
      if (this.isActive(attempt) && attempt.hasStarted) this.queueProgressReport(attempt);
    }, intervalMs);
    this.emitDiagnostics();
  }

  private clearProgressTimer() {
    if (this.progressTimer == null) return;
    const clear = this.dependencies.clearInterval ?? (handle => window.clearInterval(handle));
    clear(this.progressTimer);
    this.progressTimer = null;
    this.emitDiagnostics();
  }

  private queueProgressReport(attempt: ActivePlaybackAttempt) {
    if (!this.dependencies.reportProgress || !this.isActive(attempt)) return;
    if (attempt.progressReportPending) {
      attempt.progressReportQueued = true;
      return;
    }

    attempt.progressReportPending = true;
    const report = this.createReport(attempt);
    void this.enqueueReport('progress', attempt, report).finally(() => {
      attempt.progressReportPending = false;
      if (attempt.progressReportQueued && this.isActive(attempt)) {
        attempt.progressReportQueued = false;
        this.queueProgressReport(attempt);
      }
    });
  }

  private queueStoppedReport(attempt: ActivePlaybackAttempt, reason: PlaybackStopReason) {
    if (attempt.stoppedReportQueued || !this.dependencies.reportStopped) return this.reportChain;
    attempt.stoppedReportQueued = true;
    attempt.progressReportQueued = false;
    return this.enqueueReport('stopped', attempt, this.createReport(attempt, reason));
  }

  private queueReport(kind: 'playing', attempt: ActivePlaybackAttempt) {
    if (!this.dependencies.reportPlaying) return;
    void this.enqueueReport(kind, attempt, this.createReport(attempt));
  }

  private enqueueReport(
    kind: PlaybackReportKind,
    attempt: ActivePlaybackAttempt,
    report: PlaybackReport
  ) {
    const callback = kind === 'playing'
      ? this.dependencies.reportPlaying
      : kind === 'progress'
        ? this.dependencies.reportProgress
        : this.dependencies.reportStopped;
    if (!callback) return this.reportChain;

    const evidence = attempt.metrics.reportEvidence;
    evidence.queued[kind] += 1;
    evidence.last = { kind, status: 'queued', at: Date.now(), reason: null };
    if (this.metrics === attempt.metrics) this.emitDiagnostics();

    const run = async () => {
      evidence.attempted[kind] += 1;
      evidence.last = { kind, status: 'attempted', at: Date.now(), reason: null };
      if (this.metrics === attempt.metrics) this.emitDiagnostics();
      try {
        const result = await callback(report);
        if (result?.status === 'skipped') {
          evidence.skipped[kind] += 1;
          evidence.last = {
            kind,
            status: 'skipped',
            at: Date.now(),
            reason: redactSensitiveText(result.reason)
          };
        } else {
          evidence.succeeded[kind] += 1;
          evidence.last = { kind, status: 'succeeded', at: Date.now(), reason: null };
          if (kind === 'playing') attempt.metrics.playingReports += 1;
          if (kind === 'progress') attempt.metrics.progressReports += 1;
          if (kind === 'stopped') attempt.metrics.stoppedReports += 1;
        }
      } catch (error) {
        const safeError = safeErrorMessage(error);
        evidence.failed[kind] += 1;
        evidence.last = { kind, status: 'failed', at: Date.now(), reason: safeError };
        this.diagnostics?.logWarn(`Playback ${kind} report failed`, {
          attemptId: attempt.id,
          itemIdSuffix: attempt.metrics.itemIdSuffix,
          error: safeError
        });
      } finally {
        if (this.metrics === attempt.metrics) this.emitDiagnostics();
      }
    };
    this.reportChain = this.reportChain.then(run, run);
    return this.reportChain;
  }

  private createReport(attempt: ActivePlaybackAttempt, reason?: PlaybackStopReason): PlaybackReport {
    const media = this.media;
    const positionSeconds = safeMediaPosition(media?.currentTime);
    return {
      attemptId: attempt.id,
      itemId: attempt.request.itemId,
      playSessionId: attempt.resolvedSource?.playSessionId ?? null,
      mediaSourceId: attempt.resolvedSource?.mediaSourceId ?? null,
      positionSeconds,
      positionTicks: secondsToTicks(positionSeconds),
      isPaused: media?.paused ?? true,
      ended: media?.ended ?? reason === 'ended',
      reason
    };
  }

  private updateResolvedDiagnostics(attempt: ActivePlaybackAttempt, source: PlaybackResolvedSource) {
    const descriptor = streamDescriptor(source.url, source.mode);
    const selectedOutput = selectedOutputDescriptor(source.url, source.mode, source);
    const sourceContainer = source.sourceContainer ?? source.container ?? null;
    const sourceVideoCodec = source.sourceVideoCodec ?? source.videoCodec ?? null;
    const sourceAudioCodec = source.sourceAudioCodec ?? source.audioCodec ?? null;
    attempt.metrics.mediaSourceIdSuffix = idSuffix(source.mediaSourceId);
    attempt.metrics.container = sourceContainer;
    attempt.metrics.videoCodec = sourceVideoCodec;
    attempt.metrics.audioCodec = sourceAudioCodec;
    attempt.metrics.sourceContainer = sourceContainer;
    attempt.metrics.sourceVideoCodec = sourceVideoCodec;
    attempt.metrics.sourceAudioCodec = sourceAudioCodec;
    attempt.metrics.requestedOutputProtocol = source.requestedOutputProtocol ?? null;
    attempt.metrics.requestedOutputContainer = source.requestedOutputContainer ?? null;
    attempt.metrics.requestedOutputVideoCodec = source.requestedOutputVideoCodec ?? null;
    attempt.metrics.requestedOutputAudioCodec = source.requestedOutputAudioCodec ?? null;
    attempt.metrics.selectedOutputProtocol = selectedOutput.protocol;
    attempt.metrics.selectedOutputContainer = selectedOutput.container;
    attempt.metrics.selectedOutputVideoCodec = selectedOutput.videoCodec;
    attempt.metrics.selectedOutputAudioCodec = selectedOutput.audioCodec;
    attempt.metrics.selectedOutputEvidence = selectedOutput.evidence;
    attempt.metrics.decision = source.mode ?? null;
    attempt.metrics.finalUrlOrigin = descriptor.origin;
    attempt.metrics.finalUrlPathCategory = descriptor.category;
    this.emitDiagnostics();
  }

  private isActive(attempt: ActivePlaybackAttempt) {
    return this.activeAttempt === attempt && !attempt.controller.signal.aborted && !this.disposed;
  }

  private isExpectedCancellation(error: unknown, attempt: ActivePlaybackAttempt) {
    return !this.isActive(attempt) || (attempt.controller.signal.aborted && isAbortError(error));
  }

  private handleFatalError(error: unknown, attempt: ActivePlaybackAttempt | null) {
    if (attempt && !this.isActive(attempt)) return;
    const message = safeErrorMessage(error);
    if (this.state === 'error' && this.metrics.lastPlayerError === message) return;
    this.metrics.lastPlayerError = message;
    this.clearProgressTimer();
    this.transition('error');
    this.diagnostics?.recordPlaybackError(message);
    this.listeners.onError?.(message);
  }

  private transition(state: PlaybackEngineState, payload?: Record<string, unknown>) {
    const changed = this.state !== state;
    this.state = state;
    if (changed) {
      this.listeners.onPlayState?.(state, {
        attemptId: this.metrics.attemptId,
        ...payload
      });
    }
    this.emitDiagnostics();
  }

  private emitDiagnostics() {
    this.listeners.onDiagnostics?.(this.getDiagnosticsSnapshot());
  }

  private recordMediaEvent(event: string) {
    this.metrics.lastMediaEvent = event;
    this.metrics.mediaEventCount += 1;
    this.metrics.mediaEventCounts[event] = (this.metrics.mediaEventCounts[event] ?? 0) + 1;
    const timestamp = Date.now();
    if (
      event === 'timeupdate' &&
      this.metrics.lastRecordedTimeUpdateAt !== null &&
      timestamp - this.metrics.lastRecordedTimeUpdateAt < TIMEUPDATE_DIAGNOSTIC_INTERVAL_MS
    ) {
      return;
    }
    if (event === 'timeupdate') this.metrics.lastRecordedTimeUpdateAt = timestamp;

    if (this.metrics.mediaEventHistory.length >= MAX_MEDIA_EVENT_HISTORY) {
      const oldestTimeUpdate = this.metrics.mediaEventHistory.findIndex(entry => entry.event === 'timeupdate');
      if (oldestTimeUpdate >= 0) this.metrics.mediaEventHistory.splice(oldestTimeUpdate, 1);
      else this.metrics.mediaEventHistory.shift();
    }
    this.metrics.mediaEventHistory.push({
      event,
      timestamp,
      readyState: this.media?.readyState ?? 0,
      networkState: this.media?.networkState ?? 0,
      currentTime: safeMediaPosition(this.media?.currentTime)
    });
    this.emitDiagnostics();
  }

  private attachMediaListeners() {
    if (!this.media || this.listenersBound) return;
    this.media.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.media.addEventListener('loadeddata', this.handleLoadedData);
    this.media.addEventListener('durationchange', this.handleDurationChange);
    this.media.addEventListener('canplay', this.handleCanPlay);
    this.media.addEventListener('playing', this.handlePlaying);
    this.media.addEventListener('pause', this.handlePause);
    this.media.addEventListener('waiting', this.handleWaiting);
    this.media.addEventListener('stalled', this.handleStalled);
    this.media.addEventListener('seeking', this.handleSeeking);
    this.media.addEventListener('seeked', this.handleSeeked);
    this.media.addEventListener('timeupdate', this.handleTimeUpdate);
    this.media.addEventListener('ended', this.handleEnded);
    this.media.addEventListener('error', this.handleError);
    PASSIVE_MEDIA_EVENTS.forEach(event => this.media?.addEventListener(event, this.handlePassiveMediaEvent));
    this.listenersBound = true;
  }

  private detachMediaListeners(media: HTMLVideoElement) {
    if (!this.listenersBound) return;
    media.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    media.removeEventListener('loadeddata', this.handleLoadedData);
    media.removeEventListener('durationchange', this.handleDurationChange);
    media.removeEventListener('canplay', this.handleCanPlay);
    media.removeEventListener('playing', this.handlePlaying);
    media.removeEventListener('pause', this.handlePause);
    media.removeEventListener('waiting', this.handleWaiting);
    media.removeEventListener('stalled', this.handleStalled);
    media.removeEventListener('seeking', this.handleSeeking);
    media.removeEventListener('seeked', this.handleSeeked);
    media.removeEventListener('timeupdate', this.handleTimeUpdate);
    media.removeEventListener('ended', this.handleEnded);
    media.removeEventListener('error', this.handleError);
    PASSIVE_MEDIA_EVENTS.forEach(event => media.removeEventListener(event, this.handlePassiveMediaEvent));
    this.listenersBound = false;
  }

  private readonly handlePassiveMediaEvent = (event: Event) => {
    this.recordMediaEvent(event.type);
  };

  private readonly handleLoadedMetadata = () => {
    this.recordMediaEvent('loadedmetadata');
  };

  private readonly handleLoadedData = () => {
    this.recordMediaEvent('loadeddata');
    this.resolveReadinessIfReady();
  };

  private readonly handleDurationChange = () => {
    this.recordMediaEvent('durationchange');
  };

  private readonly handleCanPlay = () => {
    this.recordMediaEvent('canplay');
    this.resolveReadinessIfReady();
  };

  private readonly handlePlaying = () => {
    this.recordMediaEvent('playing');
    const attempt = this.activeAttempt;
    if (!attempt || !this.isActive(attempt) || this.state === 'stopping' || this.state === 'idle' || this.state === 'ended' || this.state === 'error') return;
    this.transition('playing');
  };

  private readonly handlePause = () => {
    this.recordMediaEvent('pause');
    const attempt = this.activeAttempt;
    if (!attempt?.hasStarted || !this.isActive(attempt) || this.state === 'stopping' || this.state === 'idle' || this.state === 'ended' || this.state === 'error') return;
    this.transition('paused');
  };

  private readonly handleWaiting = () => {
    this.recordMediaEvent('waiting');
    if (this.state === 'playing') this.transition('buffering');
  };

  private readonly handleStalled = () => {
    this.recordMediaEvent('stalled');
    if (this.state === 'playing') this.transition('buffering');
  };

  private readonly handleSeeking = () => {
    this.recordMediaEvent('seeking');
  };

  private readonly handleSeeked = () => {
    this.recordMediaEvent('seeked');
  };

  private readonly handleTimeUpdate = () => {
    this.recordMediaEvent('timeupdate');
  };

  private readonly handleEnded = () => {
    this.recordMediaEvent('ended');
    const attempt = this.activeAttempt;
    if (!attempt || !this.isActive(attempt) || this.state === 'stopping' || this.state === 'idle' || this.state === 'ended' || this.state === 'error') return;
    this.metrics.lastStopReason = 'ended';
    this.activeAttempt = null;
    attempt.controller.abort('ended');
    attempt.progressReportQueued = false;
    this.clearProgressTimer();
    this.transition('ended');
    if (attempt.hasStarted) this.queueStoppedReport(attempt, 'ended');
  };

  private readonly handleError = () => {
    const attempt = this.activeAttempt;
    if (!attempt || !this.isActive(attempt) || this.state === 'stopping' || this.state === 'idle' || this.state === 'ended' || this.state === 'error') {
      this.recordMediaEvent('error');
      return;
    }
    const mediaError = this.media?.error;
    const errorCode = Number(mediaError?.code);
    const mediaMessage = safeErrorMessage(mediaError?.message || 'unknown media error');
    this.metrics.lastMediaErrorCode = Number.isFinite(errorCode) && errorCode > 0 ? errorCode : null;
    this.metrics.lastMediaErrorMessage = mediaMessage;
    this.recordMediaEvent('error');
    const message = `Playback error: ${mediaMessage}`;
    const error = new Error(message);
    this.clearReadinessWaiter(attempt?.id, error);
    this.handleFatalError(error, attempt);
  };

  private readMediaRanges(kind: 'buffered' | 'seekable'): MediaSeekRange[] {
    let source: TimeRanges | null = null;
    try {
      source = this.media?.[kind] ?? null;
    } catch {
      return [];
    }
    if (!source) return [];
    const sourceLength = Number(source.length);
    if (!Number.isFinite(sourceLength) || sourceLength <= 0) return [];
    const scanLength = Math.min(Math.floor(sourceLength), MAX_TIME_RANGES_TO_SCAN);
    const ranges: MediaSeekRange[] = [];
    for (let index = 0; index < scanLength; index += 1) {
      try {
        const start = source.start(index);
        const end = source.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
          ranges.push({ start, end });
        }
      } catch {
        // Ignore an invalid platform range and continue with the remaining data.
      }
    }
    return ranges;
  }

  private readMediaRangeLength(kind: 'buffered' | 'seekable') {
    try {
      const length = Number(this.media?.[kind]?.length ?? 0);
      return Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
    } catch {
      return 0;
    }
  }

  private sourceIsPresent() {
    if (this.hasAssignedSource) return true;
    const media = this.media;
    if (!media) return false;
    try {
      return media.hasAttribute('src') || Boolean(media.currentSrc);
    } catch {
      return false;
    }
  }

  private hasActiveLifecycle() {
    return Boolean(
      this.activeAttempt ||
      this.hasAssignedSource ||
      this.progressTimer !== null ||
      this.readinessWaiter ||
      this.state !== 'idle'
    );
  }

  private scheduleInterval(callback: () => void, milliseconds: number) {
    const schedule = this.dependencies.setInterval ?? ((handler, delay) => window.setInterval(handler, delay));
    return schedule(callback, milliseconds);
  }

  private scheduleTimeout(callback: () => void, milliseconds: number) {
    const schedule = this.dependencies.setTimeout ?? ((handler, delay) => window.setTimeout(handler, delay));
    return schedule(callback, milliseconds);
  }

  private cancelTimeout(handle: number) {
    const clear = this.dependencies.clearTimeout ?? (timer => window.clearTimeout(timer));
    clear(handle);
  }
}
