import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackEngine,
  type PlaybackResolvedSource
} from '../src/playback/engine';
import {
  clampMediaSeek,
  formatMediaDuration,
  formatMediaTime,
  toHms
} from '../src/utils/format';

class FakeVideoElement extends EventTarget {
  public currentTime = 0;
  public duration = Number.NaN;
  public readyState = 0;
  public networkState = 0;
  public paused = true;
  public ended = false;
  public error: MediaError | null = null;
  public ranges: Array<{ start: number; end: number }> = [];
  public bufferedRangeData: Array<{ start: number; end: number }> = [];
  public playImplementation: () => Promise<void> = async () => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  };

  private source = '';
  private sourceAttribute = false;

  public readonly load = vi.fn(() => undefined);
  public readonly pause = vi.fn(() => {
    const wasPaused = this.paused;
    this.paused = true;
    if (!wasPaused) this.dispatchEvent(new Event('pause'));
  });
  public readonly play = vi.fn(() => this.playImplementation());
  public readonly removeAttribute = vi.fn((name: string) => {
    if (name !== 'src') return;
    this.source = '';
    this.sourceAttribute = false;
  });

  public get src() {
    return this.source;
  }

  public set src(value: string) {
    this.source = value;
    this.sourceAttribute = true;
  }

  public get currentSrc() {
    return this.source;
  }

  public get seekable(): TimeRanges {
    return this.toTimeRanges(this.ranges);
  }

  public get buffered(): TimeRanges {
    return this.toTimeRanges(this.bufferedRangeData);
  }

  private toTimeRanges(ranges: Array<{ start: number; end: number }>): TimeRanges {
    return {
      length: ranges.length,
      start(index: number) {
        const range = ranges[index];
        if (!range) throw new DOMException('Invalid range', 'IndexSizeError');
        return range.start;
      },
      end(index: number) {
        const range = ranges[index];
        if (!range) throw new DOMException('Invalid range', 'IndexSizeError');
        return range.end;
      }
    };
  }

  public hasAttribute(name: string) {
    return name === 'src' && this.sourceAttribute;
  }
}

function asVideo(element: FakeVideoElement) {
  return element as unknown as HTMLVideoElement;
}

function resolvedSource(url = 'https://piggietv.com/Videos/item/stream?api_key=secret'): PlaybackResolvedSource {
  return {
    url,
    playSessionId: 'play-session-123456',
    mediaSourceId: 'media-source-abcdef',
    mode: 'direct-play',
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    sourceContainer: 'mp4',
    sourceVideoCodec: 'h264',
    sourceAudioCodec: 'aac',
    requestedOutputProtocol: 'http',
    requestedOutputContainer: 'mp4',
    requestedOutputVideoCodec: 'h264',
    requestedOutputAudioCodec: 'aac'
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PlaybackEngine authoritative lifecycle', () => {
  it('assigns and loads one source, waits for readiness, then calls play once', async () => {
    const video = new FakeVideoElement();
    video.duration = 120;
    video.ranges = [{ start: 0, end: 120 }];
    video.bufferedRangeData = [{ start: 0, end: 24.5 }];
    const addListener = vi.spyOn(video, 'addEventListener');
    const reportPlaying = vi.fn(async () => undefined);
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportPlaying
    });

    engine.attach(asVideo(video));
    const listenerCount = addListener.mock.calls.length;
    engine.attach(asVideo(video));
    expect(addListener).toHaveBeenCalledTimes(listenerCount);

    const started = engine.start({ itemId: 'movie-123456' });
    await flushPromises();

    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.play).not.toHaveBeenCalled();
    expect(engine.getState()).toBe('loading');

    video.readyState = 3;
    video.dispatchEvent(new Event('canplay'));
    const result = await started;
    await flushPromises();

    expect(result.status).toBe('started');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(reportPlaying).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toBe('playing');

    const diagnostics = engine.getDiagnosticsSnapshot();
    expect(diagnostics).toMatchObject({
      activeAttemptId: result.attemptId,
      itemIdSuffix: '123456',
      mediaSourceIdSuffix: 'abcdef',
      decision: 'direct-play',
      finalUrlOrigin: 'https://piggietv.com',
      finalUrlPathCategory: 'direct-play',
      sourceContainer: 'mp4',
      sourceVideoCodec: 'h264',
      sourceAudioCodec: 'aac',
      requestedOutputProtocol: 'http',
      requestedOutputContainer: 'mp4',
      requestedOutputVideoCodec: 'h264',
      requestedOutputAudioCodec: 'aac',
      selectedOutputProtocol: 'http',
      selectedOutputContainer: 'mp4',
      selectedOutputVideoCodec: 'h264',
      selectedOutputAudioCodec: 'aac',
      selectedOutputEvidence: 'direct-source-and-stream-url',
      sourceAssignments: 1,
      loadCalls: 1,
      playCalls: 1,
      duration: 120,
      canSeek: true,
      bufferedRanges: {
        count: 1,
        ranges: [{ start: 0, end: 24.5 }],
        totalSeconds: 24.5,
        truncated: false
      },
      seekableRanges: {
        count: 1,
        ranges: [{ start: 0, end: 120 }],
        totalSeconds: 120,
        truncated: false
      },
      sourcePresent: true,
      progressReportingActive: false,
      lastPlayPromiseResult: 'fulfilled'
    });
    expect(diagnostics.mediaEventHistory.map(entry => entry.event)).toEqual(expect.arrayContaining(['canplay', 'playing']));
    expect(diagnostics.mediaEventHistory.every(entry => Number.isFinite(entry.timestamp))).toBe(true);
    expect(diagnostics.reportEvidence).toMatchObject({
      queued: { playing: 1 },
      attempted: { playing: 1 },
      succeeded: { playing: 1 },
      failed: { playing: 0 },
      skipped: { playing: 0 }
    });
    expect(JSON.stringify(diagnostics)).not.toContain('secret');

    engine.dispose();
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      activeAttemptId: null,
      sourcePresent: false,
      lastStopReason: 'disposed',
      loadCalls: 2
    });
  });

  it('starts when loadeddata provides current media data on webOS', async () => {
    const video = new FakeVideoElement();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource())
    });
    engine.attach(asVideo(video));

    const started = engine.start({ itemId: 'movie-current-data' });
    await flushPromises();
    expect(video.play).not.toHaveBeenCalled();

    video.readyState = 2;
    video.dispatchEvent(new Event('loadeddata'));

    await expect(started).resolves.toMatchObject({ status: 'started' });
    expect(video.play).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('gives a transcode a bounded startup window beyond the direct-play deadline', async () => {
    vi.useFakeTimers();
    const video = new FakeVideoElement();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => ({ ...resolvedSource(), mode: 'transcode' as const }))
    });
    engine.attach(asVideo(video));

    const started = engine.start({ itemId: 'movie-slow-transcode' });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(16_000);

    expect(engine.getState()).toBe('loading');
    expect(video.play).not.toHaveBeenCalled();
    video.readyState = 2;
    video.dispatchEvent(new Event('loadeddata'));

    await expect(started).resolves.toMatchObject({ status: 'started' });
    expect(video.play).toHaveBeenCalledTimes(1);
    engine.dispose();
    vi.useRealTimers();
  });

  it('ends an inactive transcode at its 30-second hard deadline', async () => {
    vi.useFakeTimers();
    const video = new FakeVideoElement();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => ({ ...resolvedSource(), mode: 'transcode' as const }))
    });
    engine.attach(asVideo(video));

    const started = engine.start({ itemId: 'movie-inactive-transcode' });
    const rejected = expect(started).rejects.toThrow('30000ms waiting for media readiness');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(engine.getState()).toBe('loading');
    await vi.advanceTimersByTimeAsync(2);
    await rejected;

    expect(engine.getState()).toBe('error');
    engine.dispose();
    vi.useRealTimers();
  });

  it('does not let stalled or suspended events extend the hard readiness deadline', async () => {
    vi.useFakeTimers();
    const video = new FakeVideoElement();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      readinessTimeoutMs: 100
    });
    engine.attach(asVideo(video));

    const started = engine.start({ itemId: 'movie-no-readiness' });
    const rejected = expect(started).rejects.toThrow('100ms waiting for media readiness');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(90);
    video.dispatchEvent(new Event('stalled'));
    video.dispatchEvent(new Event('suspend'));
    await vi.advanceTimersByTimeAsync(11);
    await rejected;

    expect(video.play).not.toHaveBeenCalled();
    expect(engine.getState()).toBe('error');
    engine.dispose();
    vi.useRealTimers();
  });

  it('supersedes an unresolved attempt and prevents its stale source from winning', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 90;
    video.ranges = [{ start: 0, end: 90 }];
    let resolveFirst!: (source: PlaybackResolvedSource) => void;
    let firstSignal: AbortSignal | null = null;
    const resolver = vi.fn((request: { itemId: string }, context: { signal: AbortSignal }) => {
      if (request.itemId === 'old-item') {
        firstSignal = context.signal;
        return new Promise<PlaybackResolvedSource>(resolve => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(resolvedSource('https://piggietv.com/Videos/new-item/stream?api_key=secret'));
    });
    const engine = new PlaybackEngine(undefined, {}, { resolveSource: resolver });
    engine.attach(asVideo(video));

    const oldStart = engine.start({ itemId: 'old-item' });
    const oldAttemptId = engine.getActiveAttemptId();
    const newStart = engine.start({ itemId: 'new-item' });
    const newResult = await newStart;
    const newAttemptId = newResult.attemptId;

    resolveFirst(resolvedSource('https://piggietv.com/Videos/old-item/stream?api_key=secret'));
    const oldResult = await oldStart;

    expect(firstSignal?.aborted).toBe(true);
    expect(oldAttemptId).not.toBe(newAttemptId);
    expect(oldResult).toEqual({ attemptId: oldAttemptId, status: 'cancelled' });
    expect(video.src).toContain('/new-item/');
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(engine.getDiagnosticsSnapshot().sourceAssignments).toBe(1);

    engine.dispose();
  });

  it('treats AbortError from an explicitly stopped play request as nonfatal', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 60;
    video.ranges = [{ start: 0, end: 60 }];
    let rejectPlay!: (error: unknown) => void;
    video.playImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    const onError = vi.fn();
    const engine = new PlaybackEngine(undefined, { onError }, {
      resolveSource: vi.fn(async () => resolvedSource())
    });
    engine.attach(asVideo(video));

    const start = engine.start({ itemId: 'movie-1' });
    await flushPromises();
    expect(video.play).toHaveBeenCalledTimes(1);

    const stopped = engine.stop('back');
    rejectPlay(new DOMException('The play request was interrupted', 'AbortError'));
    const result = await start;
    await stopped;

    expect(result.status).toBe('cancelled');
    expect(onError).not.toHaveBeenCalled();
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      activeAttemptId: null,
      sourcePresent: false,
      lastStopReason: 'back',
      lastPlayPromiseResult: 'cancelled',
      lastPlayPromiseError: null,
      lastPlayerError: null
    });
    expect(engine.getState()).toBe('idle');
  });

  it('fully resets on stop and removes the exact listeners it attached', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 180;
    video.currentTime = 42;
    video.ranges = [{ start: 0, end: 180 }];
    const addListener = vi.spyOn(video, 'addEventListener');
    const removeListener = vi.spyOn(video, 'removeEventListener');
    const reportStopped = vi.fn(async () => undefined);
    const reportProgress = vi.fn(async () => undefined);
    const setInterval = vi.fn(() => 17);
    const clearInterval = vi.fn();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportProgress,
      reportStopped,
      setInterval,
      clearInterval
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'movie-stop' });
    expect(engine.getDiagnosticsSnapshot().progressReportingActive).toBe(true);

    await engine.stop('back');

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalledTimes(2);
    expect(video.src).toBe('');
    expect(reportStopped).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'back',
      positionSeconds: 42,
      positionTicks: 420_000_000
    }));
    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
    expect(clearInterval).toHaveBeenCalledWith(17);
    expect(engine.getState()).toBe('idle');
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      activeAttemptId: null,
      sourcePresent: false,
      progressReportingActive: false,
      lastStopReason: 'back',
      sourceAssignments: 1,
      loadCalls: 2,
      playCalls: 1,
      stoppedReports: 1
    });

    engine.detach();
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      lastStopReason: 'back',
      loadCalls: 2,
      stoppedReports: 1
    });
  });

  it('rejects non-finite seeks and clamps finite seeks to seekable media', () => {
    const video = new FakeVideoElement();
    const engine = new PlaybackEngine();
    engine.attach(asVideo(video));

    video.duration = Number.POSITIVE_INFINITY;
    expect(engine.canSeek()).toBe(false);
    expect(engine.seek(30)).toBe(false);
    expect(engine.getDiagnosticsSnapshot().duration).toBeNull();

    video.duration = 120;
    video.ranges = [{ start: 10, end: 100 }];
    expect(engine.seek(Number.POSITIVE_INFINITY)).toBe(false);
    expect(engine.seek(500)).toBe(true);
    expect(video.currentTime).toBe(100);

    engine.dispose();
  });

  it('ends the active attempt, stops progress reporting, and queues one stopped report', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 60;
    video.ranges = [{ start: 0, end: 60 }];
    const reportStopped = vi.fn(async () => undefined);
    const setInterval = vi.fn(() => 29);
    const clearInterval = vi.fn();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportProgress: vi.fn(async () => undefined),
      reportStopped,
      setInterval,
      clearInterval
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'movie-ended' });

    video.currentTime = 60;
    video.ended = true;
    video.dispatchEvent(new Event('ended'));
    await flushPromises();

    expect(clearInterval).toHaveBeenCalledWith(29);
    expect(reportStopped).toHaveBeenCalledTimes(1);
    expect(reportStopped).toHaveBeenCalledWith(expect.objectContaining({ reason: 'ended', ended: true }));
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      state: 'ended',
      activeAttemptId: null,
      sourcePresent: true,
      progressReportingActive: false,
      lastStopReason: 'ended',
      stoppedReports: 1
    });

    const playCallsAtEnd = video.play.mock.calls.length;
    await engine.play();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('pause'));
    expect(video.play).toHaveBeenCalledTimes(playCallsAtEnd);
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      state: 'ended',
      activeAttemptId: null,
      progressReportingActive: false,
      stoppedReports: 1
    });

    engine.dispose();
  });

  it('waits for the deferred stopped report queued after ended', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 60;
    video.ranges = [{ start: 0, end: 60 }];
    let resolveStopped!: () => void;
    const stoppedReport = new Promise<void>(resolve => {
      resolveStopped = resolve;
    });
    const reportStopped = vi.fn(() => stoppedReport);
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportStopped
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'episode-ended' });

    video.currentTime = 60;
    video.ended = true;
    video.dispatchEvent(new Event('ended'));

    const barrier = engine.whenReportsSettled();
    let settled = false;
    void barrier.then(() => {
      settled = true;
    });
    await flushPromises();

    expect(engine.whenReportsSettled()).toBe(barrier);
    expect(reportStopped).toHaveBeenCalledTimes(1);
    expect(reportStopped).toHaveBeenCalledWith(expect.objectContaining({ reason: 'ended', ended: true }));
    expect(settled).toBe(false);
    expect(engine.getDiagnosticsSnapshot().reportEvidence.queued.stopped).toBe(1);

    resolveStopped();
    await barrier;

    expect(settled).toBe(true);
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      stoppedReports: 1,
      reportEvidence: {
        succeeded: { stopped: 1 }
      }
    });

    engine.dispose();
  });

  it('reports finite ranges, throttles timeupdate churn, and preserves critical media evidence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const video = new FakeVideoElement();
    video.duration = 120;
    video.ranges = [
      { start: 0, end: 60 },
      { start: Number.NaN, end: 80 },
      { start: 90, end: Number.POSITIVE_INFINITY },
      { start: 100, end: 95 }
    ];
    video.bufferedRangeData = [
      { start: 0, end: 20 },
      { start: 30, end: 45 }
    ];
    const engine = new PlaybackEngine();
    engine.attach(asVideo(video));
    video.dispatchEvent(new Event('loadedmetadata'));

    for (let index = 0; index < 100; index += 1) {
      video.currentTime = index;
      video.dispatchEvent(new Event('timeupdate'));
      vi.advanceTimersByTime(1_000);
    }

    const snapshot = engine.getDiagnosticsSnapshot();
    expect(snapshot.seekableRanges).toEqual({
      count: 1,
      ranges: [{ start: 0, end: 60 }],
      totalSeconds: 60,
      truncated: false
    });
    expect(snapshot.bufferedRanges).toEqual({
      count: 2,
      ranges: [{ start: 0, end: 20 }, { start: 30, end: 45 }],
      totalSeconds: 35,
      truncated: false
    });
    expect(snapshot.mediaEventHistory).toHaveLength(80);
    expect(snapshot.mediaEventHistoryTruncated).toBe(true);
    expect(snapshot.mediaEventHistory.some(entry => entry.event === 'loadedmetadata')).toBe(true);
    expect(snapshot.mediaEventCounts).toMatchObject({ loadedmetadata: 1, timeupdate: 100 });
    expect(snapshot.mediaEventHistory.every(entry => (
      Number.isFinite(entry.timestamp) &&
      Number.isFinite(entry.readyState) &&
      Number.isFinite(entry.networkState) &&
      Number.isFinite(entry.currentTime)
    ))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/NaN|Infinity/);

    engine.dispose();
    vi.useRealTimers();
  });

  it('records skipped and failed report outcomes without claiming successful Jellyfin reports', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    const reportPlaying = vi.fn(async () => ({
      status: 'skipped' as const,
      reason: 'play-session-id-unavailable'
    }));
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => ({ ...resolvedSource(), playSessionId: null })),
      reportPlaying,
      reportProgress: vi.fn(async () => ({ status: 'sent' as const }))
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'movie-no-session' });
    await flushPromises();

    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      playingReports: 0,
      progressReportingActive: false,
      reportEvidence: {
        queued: { playing: 1, progress: 0 },
        attempted: { playing: 1, progress: 0 },
        succeeded: { playing: 0, progress: 0 },
        failed: { playing: 0, progress: 0 },
        skipped: { playing: 1, progress: 0 },
        last: { kind: 'playing', status: 'skipped', reason: 'play-session-id-unavailable' }
      }
    });
    engine.dispose();

    const failedVideo = new FakeVideoElement();
    failedVideo.readyState = 3;
    const failedEngine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportPlaying: vi.fn(async () => {
        throw new Error('Report failed at https://piggietv.com?api_key=report-secret');
      })
    });
    failedEngine.attach(asVideo(failedVideo));
    await failedEngine.start({ itemId: 'movie-report-failure' });
    await flushPromises();

    const failedSnapshot = failedEngine.getDiagnosticsSnapshot();
    expect(failedSnapshot).toMatchObject({
      playingReports: 0,
      reportEvidence: {
        queued: { playing: 1 },
        attempted: { playing: 1 },
        succeeded: { playing: 0 },
        failed: { playing: 1 },
        skipped: { playing: 0 },
        last: { kind: 'playing', status: 'failed' }
      }
    });
    expect(failedSnapshot.reportEvidence.last?.reason).toContain('***redacted***');
    expect(JSON.stringify(failedSnapshot)).not.toContain('report-secret');
    failedEngine.dispose();
  });

  it('reports the selected media source, play method, seekability, and stream indexes', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 120;
    video.ranges = [{ start: 0, end: 120 }];
    const reportPlaying = vi.fn(async () => undefined);
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => ({
        ...resolvedSource(),
        mode: 'direct-stream' as const,
        audioStreamIndex: 2,
        subtitleStreamIndex: 5
      })),
      reportPlaying
    });
    engine.attach(asVideo(video));

    await engine.start({ itemId: 'movie-report-contract' });
    await engine.whenReportsSettled();

    expect(reportPlaying).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'movie-report-contract',
      playSessionId: 'play-session-123456',
      mediaSourceId: 'media-source-abcdef',
      playMethod: 'DirectStream',
      canSeek: true,
      audioStreamIndex: 2,
      subtitleStreamIndex: 5,
      isPaused: false
    }));
    engine.dispose();
  });

  it('skips a queued stale progress report once a stopped report supersedes it', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 120;
    video.ranges = [{ start: 0, end: 120 }];
    let resolvePlaying!: () => void;
    const playingReport = new Promise<void>(resolve => {
      resolvePlaying = resolve;
    });
    const reportPlaying = vi.fn(() => playingReport);
    const reportProgress = vi.fn(async () => undefined);
    const reportStopped = vi.fn(async () => undefined);
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportPlaying,
      reportProgress,
      reportStopped,
      setInterval: vi.fn(() => 41),
      clearInterval: vi.fn()
    });
    engine.attach(asVideo(video));

    await engine.start({ itemId: 'movie-stop-priority' });
    await flushPromises();
    expect(reportPlaying).toHaveBeenCalledTimes(1);

    engine.pause();
    const stopped = engine.stop('back');
    resolvePlaying();
    await stopped;

    expect(reportProgress).not.toHaveBeenCalled();
    expect(reportStopped).toHaveBeenCalledTimes(1);
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      stoppedReports: 1,
      progressReports: 0,
      reportEvidence: {
        queued: { progress: 1, stopped: 1 },
        attempted: { progress: 0, stopped: 1 },
        skipped: { progress: 1 },
        succeeded: { progress: 0, stopped: 1 }
      }
    });
  });

  it('separates source codecs from requested and server-selected transcode output', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => ({
        url: 'https://piggietv.com/Videos/item/master.m3u8?VideoCodec=h264&AudioCodec=aac&SegmentContainer=ts&api_key=secret',
        playSessionId: 'transcode-session',
        mediaSourceId: 'source-hevc',
        mode: 'transcode' as const,
        sourceContainer: 'mkv',
        sourceVideoCodec: 'hevc',
        sourceAudioCodec: 'eac3',
        requestedOutputProtocol: 'hls',
        requestedOutputContainer: 'ts',
        requestedOutputVideoCodec: 'h264',
        requestedOutputAudioCodec: 'aac'
      }))
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'movie-transcode' });

    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      decision: 'transcode',
      sourceContainer: 'mkv',
      sourceVideoCodec: 'hevc',
      sourceAudioCodec: 'eac3',
      requestedOutputProtocol: 'hls',
      requestedOutputContainer: 'ts',
      requestedOutputVideoCodec: 'h264',
      requestedOutputAudioCodec: 'aac',
      selectedOutputProtocol: 'hls',
      selectedOutputContainer: 'ts',
      selectedOutputVideoCodec: 'h264',
      selectedOutputAudioCodec: 'aac',
      selectedOutputEvidence: 'server-selected-stream-url'
    });
    expect(JSON.stringify(engine.getDiagnosticsSnapshot())).not.toContain('secret');
    engine.dispose();
  });

  it('records a rejected play promise without exposing a token-bearing URL', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 60;
    video.ranges = [{ start: 0, end: 60 }];
    video.playImplementation = async () => {
      throw new Error('Play denied at https://piggietv.com/stream?api_key=play-secret');
    };
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource())
    });
    engine.attach(asVideo(video));

    await expect(engine.start({ itemId: 'movie-rejected' })).rejects.toThrow('Play denied');

    const snapshot = engine.getDiagnosticsSnapshot();
    expect(snapshot).toMatchObject({
      state: 'error',
      lastPlayPromiseResult: 'rejected'
    });
    expect(snapshot.lastPlayPromiseError).toContain('***redacted***');
    expect(JSON.stringify(snapshot)).not.toContain('play-secret');

    engine.dispose();
  });

  it('captures numeric media errors and their redacted event evidence', async () => {
    const video = new FakeVideoElement();
    video.readyState = 3;
    video.duration = 60;
    video.ranges = [{ start: 0, end: 60 }];
    const setInterval = vi.fn(() => 23);
    const clearInterval = vi.fn();
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportProgress: vi.fn(async () => undefined),
      setInterval,
      clearInterval
    });
    engine.attach(asVideo(video));

    await engine.start({ itemId: 'movie-media-error' });
    expect(engine.getDiagnosticsSnapshot().progressReportingActive).toBe(true);
    video.error = {
      code: 4,
      message: 'Unsupported source https://piggietv.com/stream?token=media-secret'
    } as unknown as MediaError;
    video.dispatchEvent(new Event('error'));

    const snapshot = engine.getDiagnosticsSnapshot();
    expect(snapshot).toMatchObject({
      state: 'error',
      lastMediaEvent: 'error',
      lastMediaErrorCode: 4,
      lastPlayPromiseResult: 'fulfilled',
      progressReportingActive: false
    });
    expect(clearInterval).toHaveBeenCalledWith(23);
    expect(snapshot.lastMediaErrorMessage).toContain('***redacted***');
    expect(snapshot.mediaEventHistory[snapshot.mediaEventHistory.length - 1]?.event).toBe('error');
    expect(JSON.stringify(snapshot)).not.toContain('media-secret');

    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('ended'));
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      state: 'error',
      progressReportingActive: false
    });

    engine.dispose();
  });
});

describe('safe media-time helpers', () => {
  it('never renders NaN or Infinity and keeps unknown duration explicit', () => {
    expect(formatMediaDuration(Number.NaN)).toBe('--:--');
    expect(formatMediaDuration(Number.POSITIVE_INFINITY)).toBe('--:--');
    expect(formatMediaDuration(0)).toBe('--:--');
    expect(formatMediaDuration(65)).toBe('1:05');
    expect(formatMediaTime(-1)).toBe('--:--');
    expect(formatMediaTime(3_661)).toBe('1:01:01');
    expect(toHms(Number.POSITIVE_INFINITY)).toBe('--:--');
  });

  it('requires finite duration and seekable ranges when clamping seeks', () => {
    expect(clampMediaSeek(15, Number.POSITIVE_INFINITY, [{ start: 0, end: 20 }])).toBeNull();
    expect(clampMediaSeek(Number.NaN, 20, [{ start: 0, end: 20 }])).toBeNull();
    expect(clampMediaSeek(15, 20, [])).toBeNull();
    expect(clampMediaSeek(30, 40, [{ start: 0, end: 10 }, { start: 20, end: 25 }])).toBe(25);
  });
});
