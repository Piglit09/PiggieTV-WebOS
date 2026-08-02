import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackScreen } from '../src/screens/playback/PlaybackScreen';
import { AppProvider, useApp } from '../src/state/appContext';

const api = vi.hoisted(() => ({
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
    getPlaybackInfo: (...args: unknown[]) => api.getPlaybackInfo(...args),
    reportPlaying: (...args: unknown[]) => api.reportPlaying(...args),
    reportProgress: (...args: unknown[]) => api.reportProgress(...args),
    reportStopped: (...args: unknown[]) => api.reportStopped(...args),
    setAccessToken: (token?: string) => api.setAccessToken(token),
    setServer: (serverUrl: string) => api.setServer(serverUrl)
  })),
  resolvePlaybackStreamUrl: (...args: unknown[]) => api.resolvePlaybackStreamUrl(...args)
}));

function PlaybackHarness() {
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
        serverId: 'server-overlay',
        userId: 'user-overlay',
        title: 'Overlay Feature',
        context: 'Season 2 · Episode 3'
      }
    });
    dispatch({
      type: 'set_route',
      route: { screen: 'playback', itemId: 'item-overlay', sectionId: null }
    });
  }, [dispatch]);

  if (state.route.screen !== 'playback' || !state.playbackIntent || !state.userSession) return null;
  return <PlaybackScreen />;
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
  api.resolvePlaybackStreamUrl.mockReturnValue('https://media.example.test/Videos/item-overlay/stream.mp4');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
});
