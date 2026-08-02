import { DiagnosticsService } from '../core/diagnostics';
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

export type PlaybackStopReason = 'user' | 'back' | 'ended' | 'superseded' | 'detached' | 'disposed';
export type PlaybackStreamMode = 'direct-play' | 'direct-stream' | 'transcode';

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
  state: PlaybackEngineState;
  itemIdSuffix: string | null;
  mediaSourceIdSuffix: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
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
  lastMediaEvent: string | null;
  lastPlayerError: string | null;
  sourceAssignments: number;
  loadCalls: number;
  playCalls: number;
  playingReports: number;
  progressReports: number;
  stoppedReports: number;
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
  reportPlaying?: (report: PlaybackReport) => Promise<void> | void;
  reportProgress?: (report: PlaybackReport) => Promise<void> | void;
  reportStopped?: (report: PlaybackReport) => Promise<void> | void;
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
  decision: PlaybackStreamMode | null;
  finalUrlOrigin: string | null;
  finalUrlPathCategory: string | null;
  lastMediaEvent: string | null;
  lastPlayerError: string | null;
  sourceAssignments: number;
  loadCalls: number;
  playCalls: number;
  playingReports: number;
  progressReports: number;
  stoppedReports: number;
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
let attemptSequence = 0;

function createDefaultAttemptId() {
  attemptSequence += 1;
  return `playback-${Date.now().toString(36)}-${attemptSequence.toString(36)}`;
}

function emptyDiagnostics(): MutablePlaybackDiagnostics {
  return {
    attemptId: null,
    itemIdSuffix: null,
    mediaSourceIdSuffix: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    decision: null,
    finalUrlOrigin: null,
    finalUrlPathCategory: null,
    lastMediaEvent: null,
    lastPlayerError: null,
    sourceAssignments: 0,
    loadCalls: 0,
    playCalls: 0,
    playingReports: 0,
    progressReports: 0,
    stoppedReports: 0
  };
}

function idSuffix(value?: string | null) {
  if (!value) return null;
  return value.slice(-6);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Playback failed';
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
    const report = this.stop('detached');
    if (media) this.detachMediaListeners(media);
    this.media = undefined;
    void report;
  }

  public dispose() {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
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
    try {
      this.media.pause();
      if (this.state !== 'stopping' && this.state !== 'idle') this.transition('paused');
      if (this.activeAttempt?.hasStarted) this.queueProgressReport(this.activeAttempt);
    } catch (error) {
      this.handleFatalError(error, this.activeAttempt);
    }
  }

  public stop(reason: PlaybackStopReason = 'user'): Promise<void> {
    const attempt = this.activeAttempt;
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
    const target = clampMediaSeek(seconds, duration, this.readSeekableRanges());
    if (target == null) return false;

    try {
      this.media.currentTime = target;
      this.metrics.lastMediaEvent = 'seek-requested';
      this.emitDiagnostics();
      return true;
    } catch (error) {
      this.handleFatalError(error, this.activeAttempt);
      return false;
    }
  }

  public canSeek() {
    if (!this.media) return false;
    return finiteMediaDuration(this.media.duration) != null && this.readSeekableRanges().length > 0;
  }

  public getState() {
    return this.state;
  }

  public getActiveAttemptId() {
    return this.activeAttempt?.id ?? null;
  }

  public getDiagnosticsSnapshot(): PlaybackDiagnosticsSnapshot {
    const media = this.media;
    return {
      attemptId: this.metrics.attemptId,
      state: this.state,
      itemIdSuffix: this.metrics.itemIdSuffix,
      mediaSourceIdSuffix: this.metrics.mediaSourceIdSuffix,
      container: this.metrics.container,
      videoCodec: this.metrics.videoCodec,
      audioCodec: this.metrics.audioCodec,
      decision: this.metrics.decision,
      finalUrlOrigin: this.metrics.finalUrlOrigin,
      finalUrlPathCategory: this.metrics.finalUrlPathCategory,
      readyState: media?.readyState ?? 0,
      networkState: media?.networkState ?? 0,
      currentTime: safeMediaPosition(media?.currentTime),
      duration: finiteMediaDuration(media?.duration),
      paused: media?.paused ?? true,
      ended: media?.ended ?? false,
      canSeek: this.canSeek(),
      lastMediaEvent: this.metrics.lastMediaEvent,
      lastPlayerError: this.metrics.lastPlayerError,
      sourceAssignments: this.metrics.sourceAssignments,
      loadCalls: this.metrics.loadCalls,
      playCalls: this.metrics.playCalls,
      playingReports: this.metrics.playingReports,
      progressReports: this.metrics.progressReports,
      stoppedReports: this.metrics.stoppedReports
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
    this.metrics.playCalls += 1;
    this.emitDiagnostics();

    try {
      await Promise.resolve(media.play());
      if (attempt && !this.isActive(attempt)) return false;
      return true;
    } catch (error) {
      if (attempt && this.isExpectedCancellation(error, attempt)) return false;
      throw error;
    }
  }

  private supersedeCurrentAttempt() {
    const previous = this.activeAttempt;
    if (!previous && !this.hasAssignedSource) return;

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

    const hasSource = this.hasAssignedSource || media.hasAttribute('src') || Boolean(media.currentSrc);
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
    if (!this.dependencies.reportProgress || !this.isActive(attempt)) return;
    this.clearProgressTimer();
    const intervalMs = this.dependencies.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.progressTimer = this.scheduleInterval(() => {
      if (this.isActive(attempt) && attempt.hasStarted) this.queueProgressReport(attempt);
    }, intervalMs);
  }

  private clearProgressTimer() {
    if (this.progressTimer == null) return;
    const clear = this.dependencies.clearInterval ?? (handle => window.clearInterval(handle));
    clear(this.progressTimer);
    this.progressTimer = null;
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
    kind: 'playing' | 'progress' | 'stopped',
    attempt: ActivePlaybackAttempt,
    report: PlaybackReport
  ) {
    const callback = kind === 'playing'
      ? this.dependencies.reportPlaying
      : kind === 'progress'
        ? this.dependencies.reportProgress
        : this.dependencies.reportStopped;
    if (!callback) return this.reportChain;

    const run = async () => {
      try {
        await callback(report);
        if (kind === 'playing') attempt.metrics.playingReports += 1;
        if (kind === 'progress') attempt.metrics.progressReports += 1;
        if (kind === 'stopped') attempt.metrics.stoppedReports += 1;
        if (this.metrics === attempt.metrics) this.emitDiagnostics();
      } catch (error) {
        this.diagnostics?.logWarn(`Playback ${kind} report failed`, {
          attemptId: attempt.id,
          itemIdSuffix: attempt.metrics.itemIdSuffix,
          error: errorMessage(error)
        });
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
    attempt.metrics.mediaSourceIdSuffix = idSuffix(source.mediaSourceId);
    attempt.metrics.container = source.container ?? null;
    attempt.metrics.videoCodec = source.videoCodec ?? null;
    attempt.metrics.audioCodec = source.audioCodec ?? null;
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
    const message = errorMessage(error);
    if (this.state === 'error' && this.metrics.lastPlayerError === message) return;
    this.metrics.lastPlayerError = message;
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
    this.listenersBound = false;
  }

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
    if (this.state !== 'stopping' && (this.activeAttempt || this.hasAssignedSource)) {
      this.transition('playing');
    }
  };

  private readonly handlePause = () => {
    this.recordMediaEvent('pause');
    const hasStartedSource = this.activeAttempt?.hasStarted || (!this.activeAttempt && this.hasAssignedSource);
    if (this.state !== 'stopping' && this.state !== 'idle' && hasStartedSource) {
      this.transition('paused');
    }
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
    this.clearProgressTimer();
    this.transition('ended');
    if (!attempt) return;
    if (attempt.hasStarted) this.queueStoppedReport(attempt, 'ended');
  };

  private readonly handleError = () => {
    this.recordMediaEvent('error');
    const attempt = this.activeAttempt;
    if (attempt?.controller.signal.aborted || this.state === 'stopping') return;
    if (!attempt && !this.hasAssignedSource) return;
    const message = `Playback error: ${this.media?.error?.message ?? 'unknown media error'}`;
    const error = new Error(message);
    this.clearReadinessWaiter(attempt?.id, error);
    this.handleFatalError(error, attempt);
  };

  private readSeekableRanges(): MediaSeekRange[] {
    const seekable = this.media?.seekable;
    if (!seekable || seekable.length <= 0) return [];
    const ranges: MediaSeekRange[] = [];
    for (let index = 0; index < seekable.length; index += 1) {
      try {
        const start = seekable.start(index);
        const end = seekable.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
          ranges.push({ start, end });
        }
      } catch {
        // Ignore an invalid platform range and continue with the remaining data.
      }
    }
    return ranges;
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
