import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import {
  clearHomeCache,
  readHomeCacheSection,
  writeHomeCacheSection
} from '../../src/state/homeCache';
import { clearMediaCache } from '../../src/state/mediaCache';
import { defaultStorageState, STORAGE_KEY } from '../../src/storage/sessionStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const mockValidateServer = vi.fn();
const mockValidateSession = vi.fn();
const mockAuthenticateByName = vi.fn();
const mockAuthenticateWithQuickConnect = vi.fn();
const mockInitiateQuickConnect = vi.fn();
const mockGetQuickConnectState = vi.fn();
const mockDiscoverCapabilities = vi.fn();
const mockGetResume = vi.fn();
const mockGetNextUp = vi.fn();
const mockGetRecentlyAdded = vi.fn();
const mockGetItems = vi.fn();
const mockGetItem = vi.fn();
const mockGetSeasons = vi.fn();
const mockGetEpisodes = vi.fn();
const mockGetSearch = vi.fn();
const mockGetPlaybackInfo = vi.fn();
const mockReportPlaying = vi.fn();
const mockReportProgress = vi.fn();
const mockReportStopped = vi.fn();
const mockSetAccessToken = vi.fn();
const serverHistory: string[] = [];

vi.mock('../../src/api/jellyfin/client', () => ({
  JellyfinApiClient: vi.fn((config: { baseUrl: string }) => {
    let baseUrl = config.baseUrl;
    serverHistory.push(baseUrl);
    return {
      setAccessToken: (token?: string) => mockSetAccessToken(token),
      setServer: (next: string) => {
        baseUrl = next;
        serverHistory.push(next);
      },
      getServerUrl: () => baseUrl,
      validateServer: (...args: unknown[]) => mockValidateServer(...args),
      validateSession: (...args: unknown[]) => mockValidateSession(...args),
      authenticateByName: (...args: unknown[]) => mockAuthenticateByName(...args),
      authenticateWithQuickConnect: (...args: unknown[]) => mockAuthenticateWithQuickConnect(...args),
      initiateQuickConnect: (...args: unknown[]) => mockInitiateQuickConnect(...args),
      getQuickConnectState: (...args: unknown[]) => mockGetQuickConnectState(...args),
      discoverCapabilities: (...args: unknown[]) => mockDiscoverCapabilities(...args),
      getResume: (...args: unknown[]) => mockGetResume(...args),
      getNextUp: (...args: unknown[]) => mockGetNextUp(...args),
      getRecentlyAdded: (...args: unknown[]) => mockGetRecentlyAdded(...args),
      getItems: (...args: unknown[]) => mockGetItems(...args),
      getItem: (...args: unknown[]) => mockGetItem(...args),
      getSeasons: (...args: unknown[]) => mockGetSeasons(...args),
      getEpisodes: (...args: unknown[]) => mockGetEpisodes(...args),
      getSearch: (...args: unknown[]) => mockGetSearch(...args),
      getPlaybackInfo: (...args: unknown[]) => mockGetPlaybackInfo(...args),
      reportPlaying: (...args: unknown[]) => mockReportPlaying(...args),
      reportProgress: (...args: unknown[]) => mockReportProgress(...args),
      reportStopped: (...args: unknown[]) => mockReportStopped(...args),
      getImageUrl: (itemId: string, imageType: string, tag?: string) =>
        `https://server.example.com/Items/${itemId}/Images/${imageType}?tag=${tag ?? ''}`
    };
  }),
  resolvePlaybackStreamUrl: vi.fn(() => 'https://server.example.com/Videos/item/stream?api_key=redacted'),
  createPlaybackStreamUrl: vi.fn(() => 'https://server.example.com/Videos/item/stream?api_key=redacted')
}));

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function systemInfo(serverId = 'server-demo') {
  return {
    ServerId: serverId,
    ServerName: 'PiggieTV',
    Version: '10.11.11'
  };
}

function seedSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...defaultStorageState(),
    servers: [{
      serverId: 'server-demo',
      baseUrl: 'https://server.example.com',
      serverName: 'PiggieTV',
      serverVersion: '10.11.11',
      connectedAt: now
    }],
    session: {
      schemaVersion: 1,
      serverUrl: 'https://server.example.com',
      accessToken: 'stored-token',
      userId: 'user-1',
      userName: 'Stored User',
      deviceId: 'device-1',
      deviceName: 'LG webOS TV',
      applicationVersion: '0.1.0',
      savedAt: now
    },
    lastServerUrl: 'https://server.example.com',
    recentServers: ['https://server.example.com'],
    ...overrides
  }));
}

async function waitForAuth() {
  return screen.findByRole('button', { name: /^sign in$/i });
}

async function openDiagnostics() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Diagnostics/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open diagnostics' }));
  await screen.findByRole('heading', { name: 'Diagnostics' });
}

async function signOutFromSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(await screen.findByRole('button', { name: /End this TV session/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out of PTV' }));
}

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  serverHistory.length = 0;
  for (const mock of [
    mockValidateServer,
    mockValidateSession,
    mockAuthenticateByName,
    mockAuthenticateWithQuickConnect,
    mockInitiateQuickConnect,
    mockGetQuickConnectState,
    mockDiscoverCapabilities,
    mockGetResume,
    mockGetNextUp,
    mockGetRecentlyAdded,
    mockGetItems,
    mockGetItem,
    mockGetSeasons,
    mockGetEpisodes,
    mockGetSearch,
    mockGetPlaybackInfo,
    mockReportPlaying,
    mockReportProgress,
    mockReportStopped,
    mockSetAccessToken
  ]) mock.mockReset();

  mockValidateServer.mockResolvedValue(systemInfo());
  mockValidateSession.mockResolvedValue({ Id: 'user-1', Name: 'Stored User' });
  mockAuthenticateByName.mockResolvedValue({
    User: { Id: 'user-1', Name: 'Local User' },
    AccessToken: 'new-token',
    ServerId: 'server-demo'
  });
  mockInitiateQuickConnect.mockResolvedValue({ Secret: 'quick-secret', Code: 'ABCD12' });
  mockGetQuickConnectState.mockResolvedValue({
    Authenticated: true,
    Secret: 'quick-secret',
    Code: 'ABCD12',
    DateAdded: '2026-08-01T00:00:00Z',
    DeviceId: 'device-1',
    DeviceName: 'LG webOS TV',
    AppName: 'PiggieTV',
    AppVersion: '0.1.0'
  });
  mockAuthenticateWithQuickConnect.mockResolvedValue({
    User: { Id: 'user-1', Name: 'Local User' },
    AccessToken: 'quick-token',
    ServerId: 'server-demo'
  });
  mockDiscoverCapabilities.mockResolvedValue([]);
  mockGetResume.mockResolvedValue({ Items: [] });
  mockGetNextUp.mockResolvedValue({ Items: [] });
  mockGetRecentlyAdded.mockResolvedValue({ Items: [] });
  mockGetItems.mockResolvedValue({ Items: [] });
  mockGetItem.mockResolvedValue({ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie', Overview: 'Overview' });
  mockGetSeasons.mockResolvedValue({ Items: [] });
  mockGetEpisodes.mockResolvedValue({ Items: [] });
  mockGetSearch.mockResolvedValue({ Items: [] });
  mockGetPlaybackInfo.mockResolvedValue({
    PlaySessionId: 'play-session-1',
    MediaSources: [{
      Id: 'source-1',
      Container: 'mp4',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: true
    }]
  });
  mockReportPlaying.mockResolvedValue({});
  mockReportProgress.mockResolvedValue({});
  mockReportStopped.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('ptv-reduced-motion');
  clearHomeCache();
  clearMediaCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('integration: Phase 2 preference and Search restoration', () => {
  it('applies and removes the reduced-motion document preference', async () => {
    seedSession();
    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Appearance/ }));
    const motion = await screen.findByRole('button', { name: /Reduced motion/ });
    fireEvent.click(motion);
    await waitFor(() => expect(document.documentElement.classList.contains('ptv-reduced-motion')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Reduced motion/ }));
    await waitFor(() => expect(document.documentElement.classList.contains('ptv-reduced-motion')).toBe(false));
  });

  it('restores Search results and the remembered result focus after Details Back', async () => {
    seedSession();
    const searchResponse = {
      Items: [{ Id: 'search-movie-1', Name: 'Search Movie', Type: 'Movie', ProductionYear: 2025 }]
    };
    const refresh = defer<typeof searchResponse>();
    mockGetSearch.mockResolvedValueOnce(searchResponse).mockReturnValueOnce(refresh.promise);
    mockGetItem.mockResolvedValue({
      Id: 'search-movie-1',
      Name: 'Search Movie',
      Type: 'Movie',
      Overview: 'Search result overview'
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const input = await screen.findByPlaceholderText('Movies, shows, music, and books');
    fireEvent.change(input, { target: { value: 'search movie' } });
    const result = await screen.findByRole('button', { name: /Search Movie/ });
    fireEvent.click(result);
    await screen.findByText('Search result overview');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restoredInput = await screen.findByPlaceholderText('Movies, shows, music, and books');
    expect((restoredInput as HTMLInputElement).value).toBe('search movie');
    const restoredResult = await screen.findByRole('button', { name: /Search Movie/ });
    await waitFor(() => {
      expect(restoredResult.classList.contains('is-focused')).toBe(true);
      expect(document.activeElement).toBe(restoredResult);
    });
    await screen.findByText('Searching…');
    expect(screen.getByRole('button', { name: /Search Movie/ })).toBe(restoredResult);
    expect(document.querySelector('.ptv-search__status')?.contains(screen.getByText('Searching…'))).toBe(true);

    await act(async () => refresh.resolve(searchResponse));
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull());
  });
});

describe('integration: startup and canonical session restore', () => {
  it('validates the production server and shows sign-in without a Guest flash', async () => {
    render(<App />);
    await waitForAuth();
    expect(mockValidateServer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Sign in to PTV' })).toBeTruthy();
    expect(screen.queryByText('Guest')).toBeNull();
  });

  it('restores Home only after the stored current-user endpoint validates', async () => {
    seedSession();
    render(<App />);

    await screen.findByRole('heading', { name: 'PiggieTV' });
    expect(mockValidateSession).toHaveBeenCalledWith('user-1', 8_000, expect.any(AbortSignal));
    expect(mockSetAccessToken).toHaveBeenCalledWith('stored-token');
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it('loads Home rows through a three-request queue without starving library rows', async () => {
    const resume = defer<{ Items: [] }>();
    const nextUp = defer<{ Items: [] }>();
    const movies = defer<{ Items: [] }>();
    const shows = defer<{ Items: [] }>();
    mockGetResume.mockReturnValueOnce(resume.promise);
    mockGetNextUp.mockReturnValueOnce(nextUp.promise);
    mockGetRecentlyAdded
      .mockReturnValueOnce(movies.promise)
      .mockReturnValueOnce(shows.promise);
    seedSession();
    render(<App />);

    await waitFor(() => {
      expect(mockGetResume).toHaveBeenCalledTimes(1);
      expect(mockGetNextUp).toHaveBeenCalledTimes(1);
      expect(mockGetRecentlyAdded).toHaveBeenCalledTimes(1);
    });
    expect(mockGetRecentlyAdded.mock.calls[0]?.[1]).toBe('Movie');

    await act(async () => movies.resolve({ Items: [] }));
    await waitFor(() => expect(mockGetRecentlyAdded).toHaveBeenCalledTimes(2));
    expect(mockGetRecentlyAdded.mock.calls[1]?.[1]).toBe('Series');

    await act(async () => shows.resolve({ Items: [] }));
    await act(async () => {
      resume.resolve({ Items: [] });
      nextUp.resolve({ Items: [] });
    });
  });

  it('redacts sensitive values from a server-supplied Home row error', async () => {
    mockGetResume.mockRejectedValueOnce({
      kind: 'http-server-error',
      message: 'Failure at https://server.example.com/Items/private-item?api_key=home-row-secret'
    });
    mockGetRecentlyAdded.mockImplementation((_userId: string, itemType: string) => Promise.resolve({
      Items: itemType === 'Movie'
        ? [{ Id: 'safe-movie', Name: 'Successful shelf movie', Type: 'Movie' }]
        : []
    }));
    seedSession();
    render(<App />);

    await waitFor(() => expect(document.body.textContent).toContain('***redacted***'));
    const successfulCard = await screen.findByRole('button', { name: 'Successful shelf movie' });
    expect(document.body.textContent).not.toContain('home-row-secret');
    expect(document.body.textContent).not.toContain('/Items/private-item');
    expect(successfulCard.closest('.ptv-card')?.classList.contains('ptv-card--poster')).toBe(true);
    expect(successfulCard.querySelector('.ptv-card-placeholder')).toBeTruthy();
  });

  it('clears a stored token rejected by Jellyfin and returns to sign-in', async () => {
    seedSession();
    mockValidateSession.mockRejectedValue({
      kind: 'authentication-failed',
      message: 'Unauthorized',
      code: 401,
      recoverable: true
    });
    render(<App />);

    await waitForAuth();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(stored.session).toBeNull();
    expect(mockSetAccessToken).toHaveBeenLastCalledWith(undefined);
  });

  it('retains a saved session after a transient restore failure and retries Users/Me', async () => {
    seedSession();
    mockValidateSession
      .mockRejectedValueOnce({
        kind: 'network-error',
        message: 'Temporary network failure',
        recoverable: true
      })
      .mockResolvedValueOnce({ Id: 'user-1', Name: 'Stored User' });
    render(<App />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    const afterFailure = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(afterFailure.session).not.toBeNull();

    fireEvent.click(retry);
    await screen.findByRole('heading', { name: 'PiggieTV' });

    expect(mockValidateSession).toHaveBeenCalledTimes(2);
    const afterRetry = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(afterRetry.session).not.toBeNull();
  });
});

describe('integration: password authentication ownership', () => {
  it('commits one canonical session and navigates to Home', async () => {
    render(<App />);
    await waitForAuth();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' secret with spaces ' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByRole('heading', { name: 'PiggieTV' });
    expect(mockAuthenticateByName).toHaveBeenCalledTimes(1);
    expect(mockAuthenticateByName.mock.calls[0]?.[1]).toBe(' secret with spaces ');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session: Record<string, unknown> };
    expect(stored.session).toEqual(expect.objectContaining({
      serverUrl: 'https://piggietv.com',
      userId: 'user-1',
      userName: 'Local User',
      accessToken: 'new-token'
    }));
    expect(stored.session).not.toHaveProperty('serverId');
  });

  it('still commits a valid response after the StrictMode view cleanup/remount cycle', async () => {
    render(<React.StrictMode><App /></React.StrictMode>);
    await waitForAuth();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByRole('heading', { name: 'PiggieTV' });
    expect(mockAuthenticateByName).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: { userId?: string } };
    expect(stored.session?.userId).toBe('user-1');
  });

  it('enters a retryable terminal error and re-enables Sign in for invalid credentials', async () => {
    mockAuthenticateByName.mockRejectedValue({
      kind: 'authentication-failed',
      message: 'The username or password was not accepted',
      code: 401
    });
    render(<App />);
    await waitForAuth();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'creds' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByText(/not accepted/i);
    expect((screen.getByRole('button', { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(false);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(stored.session).toBeNull();
  });

  it('a superseded response cannot overwrite the newer authentication attempt', async () => {
    const first = defer<Record<string, unknown>>();
    const second = defer<Record<string, unknown>>();
    mockAuthenticateByName.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);
    await waitForAuth();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    first.resolve({ User: { Id: 'old', Name: 'Old' }, AccessToken: 'old-token', ServerId: 'server-demo' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();

    second.resolve({ User: { Id: 'new', Name: 'New' }, AccessToken: 'newest-token', ServerId: 'server-demo' });
    await screen.findByRole('heading', { name: 'PiggieTV' });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: { userId?: string } };
    expect(stored.session?.userId).toBe('new');
  });
});

describe('integration: Quick Connect, navigation, and sign-out', () => {
  it('runs one Quick Connect owner from code to Home', async () => {
    render(<App />);
    await waitForAuth();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /quick connect/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('ABCD12')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(screen.getByRole('heading', { name: 'PiggieTV' })).toBeTruthy();
    expect(mockInitiateQuickConnect).toHaveBeenCalledTimes(1);
    expect(mockGetQuickConnectState).toHaveBeenCalledTimes(1);
    expect(mockAuthenticateWithQuickConnect).toHaveBeenCalledTimes(1);
  });

  it('restores the selected Home card after Details Back', async () => {
    const refresh = defer<{ Items: Array<{ Id: string; Name: string; Type: string }> }>();
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    render(<App />);
    const card = await screen.findByRole('button', { name: 'Featured Movie' });
    fireEvent.click(card);
    await screen.findByText('Overview');
    const detailsPlay = screen.getByRole('button', { name: /^play$/i });
    await waitFor(() => expect(document.activeElement).toBe(detailsPlay));
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
    expect(document.querySelector('.ptv-details__backdrop--fallback')).toBeTruthy();
    mockGetResume.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    const restored = screen.getByRole('button', { name: 'Featured Movie' });
    await waitFor(() => expect(mockGetResume).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(restored));
    await act(async () => refresh.resolve({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] }));
  });

  it('loads only the selected Series season and starts playback with the episode ID', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    mockGetRecentlyAdded.mockImplementation((_userId: string, itemType: string) => Promise.resolve({
      Items: itemType === 'Series'
        ? [{ Id: 'series-1', Name: 'The PTV Show', Type: 'Series' }]
        : []
    }));
    mockGetItem.mockResolvedValue({
      Id: 'series-1',
      Name: 'The PTV Show',
      Type: 'Series',
      Overview: 'A series overview.'
    });
    mockGetSeasons.mockResolvedValue({
      Items: [
        { Id: 'season-1', Name: 'Season 1', Type: 'Season' },
        { Id: 'season-2', Name: 'Season 2', Type: 'Season' }
      ]
    });
    mockGetEpisodes.mockImplementation((_userId: string, _seriesId: string, seasonId: string) => Promise.resolve({
      Items: seasonId === 'season-2'
        ? Array.from({ length: 9 }, (_, index) => ({
            Id: `episode-${index + 2}`,
            Name: index === 0
              ? 'Second Season Premiere'
              : index === 8
                ? 'Second Season Finale'
                : `Second Season Episode ${index + 1}`,
            Type: 'Episode',
            SeriesName: 'The PTV Show',
            ParentIndexNumber: 2,
            IndexNumber: index + 1,
            RunTimeTicks: 2_700_000_000
          }))
        : [{
            Id: 'episode-1',
            Name: 'Pilot',
            Type: 'Episode',
            SeriesName: 'The PTV Show',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            RunTimeTicks: 2_700_000_000
          }]
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'The PTV Show' }));
    await screen.findByRole('button', { name: 'Season 1' });
    await screen.findByRole('button', { name: /^Pilot,/ });

    expect(mockGetPlaybackInfo).not.toHaveBeenCalled();
    expect(mockGetSeasons).toHaveBeenCalledWith('user-1', 'series-1', expect.any(AbortSignal));
    expect(mockGetEpisodes).toHaveBeenCalledWith('user-1', 'series-1', 'season-1', expect.any(AbortSignal));
    expect(mockGetEpisodes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Season 2' }));
    const episode = await screen.findByRole('button', { name: /^Second Season Premiere,/ });
    expect(mockGetEpisodes).toHaveBeenLastCalledWith('user-1', 'series-1', 'season-2', expect.any(AbortSignal));
    expect(mockGetEpisodes).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(episode));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const finale = await screen.findByRole('button', { name: /^Second Season Finale,/ });
    await waitFor(() => expect(document.activeElement).toBe(finale));
    expect(document.querySelectorAll('.ptv-episode-grid .ptv-card-btn')).toHaveLength(1);

    fireEvent.click(finale);
    await waitFor(() => expect(mockGetPlaybackInfo).toHaveBeenCalledTimes(1));
    expect(mockGetPlaybackInfo.mock.calls[0]?.[1]).toBe('episode-10');
    expect(document.querySelectorAll('video')).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'GoBack', keyCode: 461, which: 461 });
    const restoredEpisode = await screen.findByRole('button', { name: /^Second Season Finale,/ });
    expect(screen.getByText('2 / 2')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(restoredEpisode));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('pages Movies in bounded sets of 16 and restores the selected page/card after Details', async () => {
    const firstPage = Array.from({ length: 16 }, (_, index) => ({
      Id: `movie-${index + 1}`,
      Name: `Library Movie ${index + 1}`,
      Type: 'Movie',
      ProductionYear: 2026
    }));
    seedSession();
    mockGetItems
      .mockResolvedValueOnce({ Items: firstPage, TotalRecordCount: 17 })
      .mockResolvedValueOnce({
        Items: [{ Id: 'movie-17', Name: 'Library Movie 17', Type: 'Movie', ProductionYear: 2026 }],
        TotalRecordCount: 17
      });
    mockGetItem.mockResolvedValue({
      Id: 'movie-17',
      Name: 'Library Movie 17',
      Type: 'Movie',
      Overview: 'Last movie on the next page.'
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Movies' }));
    await screen.findByRole('button', { name: 'Library Movie 16, 2026' });
    expect(mockGetItems.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      IncludeItemTypes: 'Movie',
      StartIndex: 0,
      Limit: 16,
      SortBy: 'DateCreated'
    }));
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(16);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const finalCard = await screen.findByRole('button', { name: 'Library Movie 17, 2026' });
    expect(mockGetItems.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ StartIndex: 16, Limit: 16 }));
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(1);

    fireEvent.click(finalCard);
    await screen.findByText('Last movie on the next page.');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    const restoredCard = await screen.findByRole('button', { name: 'Library Movie 17, 2026' });
    expect(screen.getByText('Page 2')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(restoredCard));
    expect(mockGetItems).toHaveBeenCalledTimes(2);
  });

  it('does not cache a Home response that resolves after the route unmounts', async () => {
    const lateResume = defer<{ Items: Array<{ Id: string; Name: string; Type: string }> }>();
    mockGetResume.mockReturnValueOnce(lateResume.promise);
    seedSession();
    render(<App />);

    await screen.findByRole('heading', { name: 'PiggieTV' });
    await openDiagnostics();
    await act(async () => lateResume.resolve({
      Items: [{ Id: 'late-item', Name: 'Late private item', Type: 'Movie' }]
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await screen.findByRole('heading', { name: 'PiggieTV' });
    expect(screen.queryByRole('button', { name: 'Late private item' })).toBeNull();
  });

  it('uses one persistent video pipeline and restores Details focus after playback Back', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Featured Movie' }));
    await screen.findByText('Overview');
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(mockGetPlaybackInfo).toHaveBeenCalledTimes(1);

    Object.defineProperties(video as HTMLVideoElement, {
      readyState: { configurable: true, value: 3 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 12 }
    });
    fireEvent.loadedData(video as HTMLVideoElement);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    fireEvent.timeUpdate(video as HTMLVideoElement);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('video')).toBe(video);

    fireEvent.keyDown(window, { key: 'GoBack', keyCode: 461, which: 461 });
    const detailsPlay = await screen.findByRole('button', { name: /^play$/i });
    await waitFor(() => expect(document.activeElement).toBe(detailsPlay));
    expect(load).toHaveBeenCalledTimes(2);
    expect(mockReportStopped).toHaveBeenCalledTimes(1);
  });

  it('stops active playback and clears the media source on pagehide', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Featured Movie' }));
    await screen.findByText('Overview');
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    const video = document.querySelector('video') as HTMLVideoElement;
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 3 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 12 }
    });
    fireEvent.loadedData(video);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockReportPlaying).toHaveBeenCalledTimes(1));
    expect(video.hasAttribute('src')).toBe(true);

    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: false });
    window.dispatchEvent(pagehide);

    await waitFor(() => expect(mockReportStopped).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(2);
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('shows live safe session state and actual lifecycle listener ownership after sign-out', async () => {
    seedSession();
    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    await openDiagnostics();
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    await waitFor(() => {
      const output = document.querySelector('.ptv-diagnostics__output')?.textContent ?? '';
      expect(output).toContain('"sessionPresent": true');
      expect(output).toContain('"inMemorySessionPresent": true');
      expect(output).toContain('"tokenPresent": true');
      expect(output).not.toContain('stored-token');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Lifecycle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    await waitFor(() => {
      const output = document.querySelector('.ptv-diagnostics__output')?.textContent ?? '';
      expect(output).toContain('"listenerOwnerCount": 1');
      expect(output).toContain('"duplicateListenerOwnership": false');
      expect(output).not.toContain('"duplicateListenerOwnership": true');
    });

    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    await screen.findByRole('heading', { name: 'Settings' });
    await signOutFromSettings();
    await waitForAuth();
    await openDiagnostics();
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    await waitFor(() => {
      const output = document.querySelector('.ptv-diagnostics__output')?.textContent ?? '';
      expect(output).toContain('"sessionPresent": false');
      expect(output).toContain('"inMemorySessionPresent": false');
      expect(output).toContain('"tokenPresent": false');
    });
  });

  it('never renders a token-bearing raw playback rejection', async () => {
    const secret = 'ui-play-secret';
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new Error(`Play denied at https://server.example.com/Videos/item/stream?api_key=${secret}`)
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Featured Movie' }));
    await screen.findByText('Overview');
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 3 },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 0 }
    });
    fireEvent.loadedData(video);

    await screen.findByText(/\*\*\*redacted\*\*\*/i);
    expect(document.body.textContent).not.toContain(secret);
  });

  it('sign-out clears memory, API authorization, persistence, and route history', async () => {
    seedSession();
    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    writeHomeCacheSection('sign-out-sentinel', 'movies', [{
      id: 'private-item',
      name: 'Private item',
      type: 'Movie'
    }]);
    await signOutFromSettings();

    await waitForAuth();
    await waitFor(() => expect(readHomeCacheSection('sign-out-sentinel', 'movies')).toBeUndefined());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(stored.session).toBeNull();
    expect(mockSetAccessToken).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('normalizes a changed private server before configuring the shared client', async () => {
    render(<App />);
    await waitForAuth();
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }));
    const input = await screen.findByPlaceholderText('https://PiggieTV.com');
    fireEvent.change(input, { target: { value: '10.16.0.50:8096' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitForAuth();
    expect(serverHistory).toContain('http://10.16.0.50:8096');
  });
});
