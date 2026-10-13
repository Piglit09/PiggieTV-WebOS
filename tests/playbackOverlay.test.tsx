import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackScreen } from '../src/screens/playback/PlaybackScreen';
import { AppProvider, useApp } from '../src/state/appContext';

const api = vi.hoisted(() => ({
  getNextUpForSeries: vi.fn(),
  getPlaybackInfo: vi.fn(),
  reportPlaying: vi.fn(),
  reportProgress: vi.fn(),
  reportStopped: vi.fn(),
  resolvePlaybackStreamUrl: vi.fn(),
  setAccessToken: vi.fn(),
  setServer: vi.fn()
}));

vi.mock('../src/api/jellyfin/client', () => ({
  JellyfinApiClient: vi.fn(() => ({
    getNextUpForSeries: (...args: unknown[]) => api.getNextUpForSeries(...args),
    getPlaybackInfo: (...args: unknown[]) => api.getPlaybackInfo(...args),
    reportPlaying: (...args: unknown[]) => api.reportPlaying(...args),
    reportProgress: (...args: unknown[]) => api.reportProgress(...args),
    reportStopped: (...args: unknown[]) => api.reportStopped(...args),
    setAccessToken: (token?: string) => api.setAccessToken(token),
    setServer: (serverUrl: string) => api.setServer(serverUrl)
  })),
  resolvePlaybackStreamUrl: (...args: unknown[]) => api.resolvePlaybackStreamUrl(...args)
}));

function PlaybackHarness({ autoPlayNext = true }: { autoPlayNext?: boolean }) {
  const { state, dispatch } = useApp();

  useEffect(() => {
    dispatch({ type: 'set_server_url', serverUrl: 'https://server.example.test' });
    dispatch({
      type: 'set_user_session',
      userSession: {
        userId: 'user-overlay',
        userName: 'Overlay User',
        accessToken: 'test-token',
        serverId: 'server-overlay',
        serverUrl: 'https://server.example.test',
        deviceId: 'device-overlay',
        createdAt: 1,
        updatedAt: 1
      }
    });
    dispatch({
      type: 'set_playback_intent',
      playbackIntent: {
        kind: 'episode',
        itemId: 'item-overlay',
        seriesId: 'series-overlay',
        serverId: 'server-overlay',
        userId: 'user-overlay',
        title: 'Overlay Feature',
        context: 'Season 2 · Episode 3'
      }
    });
    dispatch({ type: 'update_settings', settings: { autoPlayNext } });
    dispatch({
      type: 'reset_route',
      route: { screen: 'details', itemId: 'series-overlay', sectionId: null }
    });
    dispatch({
      type: 'set_route',
      route: { screen: 'playback', itemId: 'item-overlay', sectionId: null }
    });
  }, [autoPlayNext, dispatch]);

  const playbackReady = state.route.screen === 'playback' && state.playbackIntent && state.userSession;
  return (
    <>
      {playbackReady ? <PlaybackScreen /> : null}
      <button
        type="button"
        hidden
        data-testid="same-item-track-update"
        onClick={() => {
          if (!state.playbackIntent) return;
          dispatch({
            type: 'set_playback_intent',
            playbackIntent: { ...state.playbackIntent, audioStreamIndex: 1 }
          });
        }}
      >
        Update same item track
      </button>
      <output data-testid="playback-state">
        {`${state.route.screen}:${state.route.itemId ?? ''}${state.route.sectionId ? `?section=${state.route.sectionId}` : ''}|${state.routeHistory.map(route => `${route.screen}:${route.itemId ?? ''}`).join(',')}`}
      </output>
    </>
  );
}

function AudioPlaybackHarness({ withQueue = false }: { withQueue?: boolean }) {
  const { state, dispatch } = useApp();

  useEffect(() => {
    dispatch({ type: 'set_server_url', serverUrl: 'https://server.example.test' });
    dispatch({
      type: 'set_user_session',
      userSession: {
        userId: 'user-audio-overlay',
        userName: 'Overlay Audio User',
        accessToken: 'audio-token',
        serverId: 'server-overlay',
        serverUrl: 'https://server.example.test',
        deviceId: 'device-overlay-audio',
        createdAt: 1,
        updatedAt: 1
      }
    });
    dispatch({
      type: 'set_playback_intent',
      playbackIntent: {
        kind: 'audio',
        itemId: 'audio-track-overlay',
        serverId: 'server-overlay',
        userId: 'user-audio-overlay',
        title: 'Audio Feature',
        artist: 'Overlay Artist',
        album: 'Overlay Album',
        queue: withQueue ? {
          items: [
            {
              itemId: 'audio-track-overlay',
              title: 'Audio Feature',
              artist: 'Overlay Artist',
              album: 'Overlay Album'
            },
            {
              itemId: 'audio-track-next',
              title: 'Next Audio Feature',
              artist: 'Next Artist',
              album: 'Next Album'
            }
          ],
          index: 0
        } : undefined
      }
    });
    dispatch({ type: 'set_route', route: { screen: 'playback', itemId: 'audio-track-overlay', sectionId: null } });
  }, [dispatch, withQueue]);

  const playbackReady = state.route.screen === 'playback' && state.playbackIntent?.kind === 'audio' && state.userSession;
  return (
    <>
      {playbackReady ? <PlaybackScreen /> : null}
      <output data-testid="audio-playback-state">
        {`${state.route.screen}:${state.route.itemId ?? ''}${state.route.sectionId ? `?section=${state.route.sectionId}` : ''}|${state.routeHistory.map(route => `${route.screen}:${route.itemId ?? ''}`).join(',')}`}
      </output>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  Object.values(api).forEach(mock => mock.mockReset());
  api.getPlaybackInfo.mockResolvedValue({
    PlaySessionId: 'session-overlay',
    MediaSources: [{
      Id: 'source-overlay',
      Container: 'mp4',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: true
    }]
  });
  api.reportPlaying.mockResolvedValue({});
  api.reportProgress.mockResolvedValue({});
  api.reportStopped.mockResolvedValue({});
  api.getNextUpForSeries.mockResolvedValue({ Items: [] });
  api.resolvePlaybackStreamUrl.mockImplementation((_serverUrl: string, itemId: string) => (
    `https://media.example.test/Videos/${itemId}/stream.mp4`
  ));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushPlaybackWork(rounds = 12) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Phase 2 playback overlay', () => {
  it('shows title, context, and semantic progress without replacing or reloading the video when visibility toggles', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Overlay Feature' })).toBeTruthy();
    expect(screen.getByText('Season 2 · Episode 3')).toBeTruthy();

    const videos = document.querySelectorAll('video');
    expect(videos).toHaveLength(1);
    const video = videos[0] as HTMLVideoElement;
    const source = video.getAttribute('src');
    expect(source).toBe('https://media.example.test/Videos/item-overlay/stream.mp4');

    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 30 }
    });
    await act(async () => {
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(play).toHaveBeenCalledTimes(1);
    const progress = screen.getByRole('progressbar', { name: 'Playback progress' });
    expect(progress.getAttribute('aria-valuemin')).toBe('0');
    expect(progress.getAttribute('aria-valuemax')).toBe('100');
    expect(progress.getAttribute('aria-valuenow')).toBe('25');
    expect(progress.getAttribute('aria-valuetext')).toBe('0:30 of 2:00');

    const overlay = document.querySelector('.ptv-playback__overlay') as HTMLElement;
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(overlay.classList.contains('is-hidden')).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_501);
    });
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.classList.contains('is-hidden')).toBe(true);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(document.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe(source);
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('ptv-remote-input'));
    });
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(overlay.classList.contains('is-hidden')).toBe(false);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(document.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe(source);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the same item from its current position after a bounded network media error', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 1_200 },
      currentTime: { configurable: true, writable: true, value: 615 },
      error: {
        configurable: true,
        value: { code: 2, message: 'MEDIA_ERR_NETWORK' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();
    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(1);

    fireEvent.error(video);
    expect(screen.getByText('Connection interrupted. Retrying playback (1/2)…')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(api.getPlaybackInfo.mock.calls[1]?.[1]).toBe('item-overlay');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('recovers a webOS decode error when it follows a sustained playback stall', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 3_200 },
      currentTime: { configurable: true, writable: true, value: 2_825 },
      error: {
        configurable: true,
        value: { code: 3, message: 'unknown media error' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();

    fireEvent.stalled(video);
    fireEvent.waiting(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    fireEvent.error(video);

    expect(screen.getByText('Connection interrupted. Retrying playback (1/2)…')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(api.getPlaybackInfo.mock.calls[1]?.[1]).toBe('item-overlay');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not retry an immediate decode failure merely because webOS emitted waiting first', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 1_200 },
      currentTime: { configurable: true, writable: true, value: 120 },
      error: {
        configurable: true,
        value: { code: 3, message: 'unknown media error' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();

    fireEvent.waiting(video);
    fireEvent.error(video);
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Connection interrupted\. Retrying playback/)).toBeNull();
    expect(screen.getByText('Playback error: unknown media error')).toBeTruthy();
  });

  it('does not delay a stalled-stream retry behind a pending progress report', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const pendingProgress = defer<Record<string, never>>();
    api.reportProgress.mockReturnValueOnce(pendingProgress.promise);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 3_200 },
      currentTime: { configurable: true, writable: true, value: 2_825 },
      error: {
        configurable: true,
        value: { code: 3, message: 'unknown media error' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(api.reportProgress).toHaveBeenCalledTimes(1);

    fireEvent.waiting(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    fireEvent.error(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(3);

    pendingProgress.resolve({});
    await flushPlaybackWork();
  });

  it('does not classify an isolated webOS decode error as a network interruption', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 1_200 },
      currentTime: { configurable: true, writable: true, value: 120 },
      error: {
        configurable: true,
        value: { code: 3, message: 'unknown media error' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();

    fireEvent.error(video);
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Connection interrupted\. Retrying playback/)).toBeNull();
    expect(screen.getByText('Playback error: unknown media error')).toBeTruthy();
  });

  it('retries an unsupported HEVC HLS remux once with full transcoding and does not loop', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const pendingStoppedReport = defer<Record<string, never>>();
    api.reportStopped.mockReturnValueOnce(pendingStoppedReport.promise);
    const hevcRemuxPlaybackInfo = {
      PlaySessionId: 'session-remux',
      MediaSources: [{
        Id: 'source-remux',
        Container: 'mkv',
        VideoCodec: 'hevc',
        AudioCodec: 'aac',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '/Videos/item-overlay/master.m3u8?VideoCodec=hevc&AudioCodec=aac&SegmentContainer=ts'
      }]
    };
    const fullTranscodePlaybackInfo = {
      PlaySessionId: 'session-transcode',
      MediaSources: [{
        Id: 'source-transcode',
        Container: 'mkv',
        VideoCodec: 'hevc',
        AudioCodec: 'ac3',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '/Videos/item-overlay/master.m3u8'
      }]
    };
    api.getPlaybackInfo
      .mockResolvedValueOnce(hevcRemuxPlaybackInfo)
      .mockResolvedValueOnce(fullTranscodePlaybackInfo)
      .mockResolvedValueOnce(fullTranscodePlaybackInfo);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    expect(api.getPlaybackInfo.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      allowVideoStreamCopy: true,
      allowAudioStreamCopy: true
    }));
    expect(api.resolvePlaybackStreamUrl.mock.calls[0]?.[3]).toBe('transcode');

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 1_200 },
      currentTime: { configurable: true, writable: true, value: 120 },
      seekable: {
        configurable: true,
        value: {
          length: 1,
          start: () => 0,
          end: () => 1_200
        }
      },
      error: {
        configurable: true,
        value: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' }
      }
    });
    fireEvent.loadedData(video);
    await flushPlaybackWork();

    fireEvent.error(video);
    expect(screen.getByText('Playback format is not supported directly. Retrying with a compatible stream...')).toBeTruthy();
    video.currentTime = 0;
    await flushPlaybackWork();

    expect(api.reportStopped).toHaveBeenCalledTimes(1);
    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(api.getPlaybackInfo.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      enableDirectPlay: false,
      enableDirectStream: false,
      enableTranscoding: true,
      allowVideoStreamCopy: false,
      allowAudioStreamCopy: false
    }));
    expect(api.resolvePlaybackStreamUrl.mock.calls[1]?.[3]).toBe('transcode');

    fireEvent.loadedData(video);
    await flushPlaybackWork();
    expect(video.currentTime).toBe(120);

    fireEvent.click(screen.getByTestId('same-item-track-update'));
    await flushPlaybackWork();
    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(3);
    expect(api.getPlaybackInfo.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      enableDirectPlay: false,
      enableDirectStream: false,
      enableTranscoding: true,
      allowVideoStreamCopy: false,
      allowAudioStreamCopy: false
    }));

    fireEvent.error(video);
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Playback error: MEDIA_ELEMENT_ERROR: Format error')).toBeTruthy();
    pendingStoppedReport.resolve({});
  });

  it('waits for the ended report, advances once to the next Series episode, and replaces the playback route', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    api.getNextUpForSeries.mockResolvedValue({
      Items: [
        {
          Id: 'item-overlay',
          Type: 'Episode',
          Name: 'Overlay Feature',
          SeriesId: 'series-overlay'
        },
        {
          Id: 'item-next',
          Type: 'Episode',
          Name: 'The Next Feature',
          SeriesId: 'series-overlay',
          SeriesName: 'Overlay Series',
          SeasonName: 'Season 2',
          ParentIndexNumber: 2,
          IndexNumber: 4,
          UserData: { PlaybackPositionTicks: 0 }
        }
      ]
    });

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 120 },
      ended: { configurable: true, value: true }
    });
    await act(async () => {
      fireEvent.loadedData(video);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.ended(video);
      fireEvent.ended(video);
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });

    expect(api.reportStopped).toHaveBeenCalledTimes(1);
    expect(api.getNextUpForSeries).toHaveBeenCalledTimes(1);
    expect(api.getNextUpForSeries).toHaveBeenCalledWith(
      'user-overlay',
      'series-overlay',
      2,
      expect.any(AbortSignal)
    );
    expect(api.reportStopped.mock.invocationCallOrder[0]).toBeLessThan(
      api.getNextUpForSeries.mock.invocationCallOrder[0] as number
    );
    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(api.getPlaybackInfo.mock.calls[1]?.[1]).toBe('item-next');
    expect(screen.getByRole('heading', { name: 'The Next Feature' })).toBeTruthy();
    expect(screen.getByText('Overlay Series - S2 E4')).toBeTruthy();
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(document.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe('https://media.example.test/Videos/item-next/stream.mp4');
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('playback-state').textContent).toBe(
      'playback:item-next|details:series-overlay'
    );
  });

  it('leaves an ended episode in place when auto-play next is disabled', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <PlaybackHarness autoPlayNext={false} />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 120 },
      ended: { configurable: true, value: true }
    });
    await act(async () => {
      fireEvent.loadedData(video);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.ended(video);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(api.reportStopped).toHaveBeenCalledTimes(1);
    expect(api.getNextUpForSeries).not.toHaveBeenCalled();
    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Ended' })).toBeTruthy();
    expect(screen.getByTestId('playback-state').textContent).toBe(
      'playback:item-overlay|details:series-overlay'
    );
  });

  it('cancels a pending next-episode lookup when Back leaves playback', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const lookup = defer<{ Items: Array<Record<string, unknown>> }>();
    api.getNextUpForSeries.mockReturnValue(lookup.promise);

    render(
      <AppProvider>
        <PlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 120 },
      ended: { configurable: true, value: true }
    });
    await act(async () => {
      fireEvent.loadedData(video);
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.ended(video);
    await flushPlaybackWork();
    expect(api.getNextUpForSeries).toHaveBeenCalledTimes(1);

    const lookupSignal = api.getNextUpForSeries.mock.calls[0]?.[3] as AbortSignal;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(lookupSignal.aborted).toBe(true);
      lookup.resolve({
        Items: [{
          Id: 'item-too-late',
          Type: 'Episode',
          Name: 'Too Late',
          SeriesId: 'series-overlay'
        }]
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('playback-state').textContent).toBe(
      'details:series-overlay|'
    );
    expect(document.querySelector('video')).toBeNull();
    await flushPlaybackWork();

    expect(api.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Too Late' })).toBeNull();
  });

  it('supports mini audio playback and promotes to now-playing mode on request', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <AudioPlaybackHarness />
      </AppProvider>
    );
    await flushPlaybackWork();

    expect(screen.getByRole('button', { name: 'Now Playing' })).toBeTruthy();
    const initialMiniRoute = screen.getByTestId('audio-playback-state').textContent ?? '';
    expect(initialMiniRoute).toContain('playback:audio-track-overlay|');
    expect(initialMiniRoute).not.toContain('?section=');
    expect(document.querySelector('.ptv-playback-mini')).toBeTruthy();
    expect(document.querySelector('.ptv-playback__overlay')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Now Playing' }));
      await Promise.resolve();
    });

    expect(screen.getByTestId('audio-playback-state').textContent).toContain(
      'playback:audio-track-overlay?section=now-playing|'
    );
    expect(document.querySelector('.ptv-playback-mini')).toBeNull();
    expect(document.querySelector('.ptv-playback__overlay')).toBeTruthy();
  });

  it('waits for natural audio completion and advances once to the next queued track', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    render(
      <AppProvider>
        <AudioPlaybackHarness withQueue />
      </AppProvider>
    );
    await flushPlaybackWork();

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 180 },
      currentTime: { configurable: true, writable: true, value: 180 },
      ended: { configurable: true, value: true }
    });
    await act(async () => {
      fireEvent.loadedData(video);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.ended(video);
      fireEvent.ended(video);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(api.reportStopped).toHaveBeenCalledTimes(1);
    expect(api.getNextUpForSeries).not.toHaveBeenCalled();
    expect(screen.getByTestId('audio-playback-state').textContent).toContain('playback:audio-track-next|');
    expect(screen.getByRole('heading', { name: 'Next Audio Feature' })).toBeTruthy();
  });
});
