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
    const ranges = this.ranges;
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
    audioCodec: 'aac'
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
      itemIdSuffix: '123456',
      mediaSourceIdSuffix: 'abcdef',
      decision: 'direct-play',
      finalUrlOrigin: 'https://piggietv.com',
      finalUrlPathCategory: 'direct-play',
      sourceAssignments: 1,
      loadCalls: 1,
      playCalls: 1,
      duration: 120,
      canSeek: true
    });
    expect(JSON.stringify(diagnostics)).not.toContain('secret');

    engine.dispose();
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
    expect(engine.getDiagnosticsSnapshot().lastPlayerError).toBeNull();
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
    const engine = new PlaybackEngine(undefined, {}, {
      resolveSource: vi.fn(async () => resolvedSource()),
      reportStopped
    });
    engine.attach(asVideo(video));
    await engine.start({ itemId: 'movie-stop' });

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
    expect(engine.getState()).toBe('idle');
    expect(engine.getDiagnosticsSnapshot()).toMatchObject({
      sourceAssignments: 1,
      loadCalls: 2,
      playCalls: 1,
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
