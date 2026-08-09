import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import {
  clearHomeCache,
  readHomeCacheSection,
  writeHomeCacheSection
} from '../../src/state/homeCache';
import { clearMediaCache } from '../../src/state/mediaCache';
import { defaultStorageState, STORAGE_KEY } from '../../src/storage/sessionStore';
import { DiagnosticsService } from '../../src/core/diagnostics';

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
const mockGetNextUpForSeries = vi.fn();
const mockGetRecentlyAdded = vi.fn();
const mockGetItems = vi.fn();
const mockGetItem = vi.fn();
const mockGetSimilarItems = vi.fn();
const mockGetSeasons = vi.fn();
const mockGetEpisodes = vi.fn();
const mockGetSearch = vi.fn();
const mockGetSearchGenres = vi.fn();
const mockGetSearchMusicGenres = vi.fn();
const mockGetSearchStudios = vi.fn();
const mockGetSearchCategoryItems = vi.fn();
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
      getNextUpForSeries: (...args: unknown[]) => mockGetNextUpForSeries(...args),
      getRecentlyAdded: (...args: unknown[]) => mockGetRecentlyAdded(...args),
      getItems: (...args: unknown[]) => mockGetItems(...args),
      getItem: (...args: unknown[]) => mockGetItem(...args),
      getSimilarItems: (...args: unknown[]) => mockGetSimilarItems(...args),
      getSeasons: (...args: unknown[]) => mockGetSeasons(...args),
      getEpisodes: (...args: unknown[]) => mockGetEpisodes(...args),
      getSearch: (...args: unknown[]) => mockGetSearch(...args),
      getSearchGenres: (...args: unknown[]) => mockGetSearchGenres(...args),
      getSearchMusicGenres: (...args: unknown[]) => mockGetSearchMusicGenres(...args),
      getSearchStudios: (...args: unknown[]) => mockGetSearchStudios(...args),
      getSearchCategoryItems: (...args: unknown[]) => mockGetSearchCategoryItems(...args),
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
    mockGetNextUpForSeries,
    mockGetRecentlyAdded,
    mockGetItems,
    mockGetItem,
    mockGetSimilarItems,
    mockGetSeasons,
    mockGetEpisodes,
    mockGetSearch,
    mockGetSearchGenres,
    mockGetSearchMusicGenres,
    mockGetSearchStudios,
    mockGetSearchCategoryItems,
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
  mockGetNextUpForSeries.mockResolvedValue({ Items: [] });
  mockGetRecentlyAdded.mockResolvedValue({ Items: [] });
  mockGetItems.mockResolvedValue({ Items: [] });
  mockGetItem.mockResolvedValue({ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie', Overview: 'Overview' });
  mockGetSimilarItems.mockResolvedValue({ Items: [] });
  mockGetSeasons.mockResolvedValue({ Items: [] });
  mockGetEpisodes.mockResolvedValue({ Items: [] });
  mockGetSearch.mockResolvedValue({ Items: [] });
  mockGetSearchGenres.mockResolvedValue({ Items: [] });
  mockGetSearchMusicGenres.mockResolvedValue({ Items: [] });
  mockGetSearchStudios.mockResolvedValue({ Items: [] });
  mockGetSearchCategoryItems.mockResolvedValue({ Items: [], TotalRecordCount: 0 });
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
    const input = await screen.findByPlaceholderText('Titles, people, music, genres, and studios');
    fireEvent.change(input, { target: { value: 'search movie' } });
    const result = await screen.findByRole('button', { name: /Search Movie/ });
    fireEvent.click(result);
    await screen.findByText('Search result overview');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restoredInput = await screen.findByPlaceholderText('Titles, people, music, genres, and studios');
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

  it('renders the first useful All result while related branches continue with two-request fan-out', async () => {
    seedSession();
    const content = defer<{ Items: Array<Record<string, unknown>> }>();
    const musicGenre = defer<{ Items: Array<Record<string, unknown>> }>();
    const genre = defer<{ Items: Array<Record<string, unknown>> }>();
    const studio = defer<{ Items: Array<Record<string, unknown>> }>();
    mockGetSearch.mockReturnValue(content.promise);
    mockGetSearchMusicGenres.mockReturnValue(musicGenre.promise);
    mockGetSearchGenres.mockReturnValue(genre.promise);
    mockGetSearchStudios.mockReturnValue(studio.promise);

    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByPlaceholderText('Titles, people, music, genres, and studios'), {
      target: { value: 'rock' }
    });

    await waitFor(() => {
      expect(mockGetSearch).toHaveBeenCalledTimes(1);
      expect(mockGetSearchMusicGenres).toHaveBeenCalledTimes(1);
    });
    expect(mockGetSearchGenres).not.toHaveBeenCalled();
    expect(mockGetSearchStudios).not.toHaveBeenCalled();

    await act(async () => content.resolve({
      Items: [{ Id: 'movie-rock', Name: 'Rock Movie', Type: 'Movie', ProductionYear: 2026 }]
    }));
    expect(await screen.findByRole('button', { name: 'Rock Movie, 2026' })).toBeTruthy();
    expect(screen.getByText('Adding related matches…')).toBeTruthy();
    await waitFor(() => expect(mockGetSearchGenres).toHaveBeenCalledTimes(1));
    expect(mockGetSearchStudios).not.toHaveBeenCalled();

    await act(async () => {
      musicGenre.resolve({ Items: [{ Id: 'music-rock', Name: 'Rock', Type: 'MusicGenre' }] });
      genre.resolve({ Items: [] });
    });
    await waitFor(() => expect(mockGetSearchStudios).toHaveBeenCalledTimes(1));
    await act(async () => studio.resolve({ Items: [] }));

    expect(await screen.findByRole('button', { name: 'Rock, Music genre' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Adding related matches…')).toBeNull());
  });

  it('keeps category return focus stable until every progressive refresh branch settles', async () => {
    seedSession();
    const refreshedGenre = defer<{ Items: Array<Record<string, unknown>> }>();
    const refreshedMusicGenre = defer<{ Items: Array<Record<string, unknown>> }>();
    mockGetSearchGenres
      .mockResolvedValueOnce({ Items: [] })
      .mockReturnValueOnce(refreshedGenre.promise);
    mockGetSearchMusicGenres
      .mockResolvedValueOnce({ Items: [{ Id: 'music-genre-rock', Name: 'Rock', Type: 'MusicGenre' }] })
      .mockReturnValueOnce(refreshedMusicGenre.promise);
    mockGetSearchCategoryItems.mockResolvedValue({
      Items: [{ Id: 'album-rock-solid', Name: 'Rock Solid', Type: 'MusicAlbum', ProductionYear: 2026 }],
      TotalRecordCount: 1
    });

    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const toolbar = await screen.findByRole('toolbar', { name: 'Search filters' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Genres' }));
    fireEvent.change(screen.getByPlaceholderText('Titles, people, music, genres, and studios'), {
      target: { value: 'rock' }
    });

    const musicGenre = await screen.findByRole('button', { name: 'Rock, Music genre' });
    await waitFor(() => expect(screen.queryByText('Adding related matches…')).toBeNull());
    fireEvent.click(musicGenre);
    await screen.findByRole('heading', { name: 'Rock' });
    const album = await screen.findByRole('button', { name: 'Rock Solid, 2026' });
    await waitFor(() => expect(document.activeElement).toBe(album));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restoredMusicGenre = await screen.findByRole('button', { name: 'Rock, Music genre' });
    await waitFor(() => expect(document.activeElement).toBe(restoredMusicGenre));
    await waitFor(() => {
      expect(mockGetSearchGenres).toHaveBeenCalledTimes(2);
      expect(mockGetSearchMusicGenres).toHaveBeenCalledTimes(2);
    });

    await act(async () => refreshedGenre.resolve({
      Items: [{ Id: 'genre-rock', Name: 'Rock', Type: 'Genre' }]
    }));
    expect(await screen.findByRole('button', { name: 'Rock, Genre' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rock, Music genre' })).toBe(restoredMusicGenre);
    expect(document.activeElement).toBe(restoredMusicGenre);

    await act(async () => refreshedMusicGenre.resolve({
      Items: [{ Id: 'music-genre-rock', Name: 'Rock', Type: 'MusicGenre' }]
    }));
    await waitFor(() => expect(screen.queryByText('Adding related matches…')).toBeNull());
    await waitFor(() => {
      expect(restoredMusicGenre.classList.contains('is-focused')).toBe(true);
      expect(document.activeElement).toBe(restoredMusicGenre);
    });
  });

  it('searches typed genres and studios and opens each as a native focused catalog', async () => {
    seedSession();
    mockGetSearchGenres.mockResolvedValue({ Items: [{ Id: 'genre-drama', Name: 'Drama', Type: 'Genre' }] });
    mockGetSearchMusicGenres.mockResolvedValue({
      Items: [{ Id: 'music-genre-dream-pop', Name: 'Dream Pop', Type: 'MusicGenre' }]
    });
    mockGetSearchStudios.mockResolvedValue({
      Items: [{ Id: 'studio-pixar', Name: 'Pixar', Type: 'Studio' }]
    });
    mockGetSearchCategoryItems.mockImplementation((_userId, _categoryId, kind) => Promise.resolve(kind === 'MusicGenre'
      ? {
          Items: [{ Id: 'album-night-drive', Name: 'Night Drive', Type: 'MusicAlbum', ProductionYear: 2026 }],
          TotalRecordCount: 1
        }
      : {
          Items: [{ Id: 'movie-luxo', Name: 'Luxo Jr.', Type: 'Movie', ProductionYear: 1986 }],
          TotalRecordCount: 1
        }));
    mockGetItem.mockImplementation((_userId, itemId) => Promise.resolve(itemId === 'album-night-drive'
      ? { Id: itemId, Name: 'Night Drive', Type: 'MusicAlbum', Overview: 'A premium album catalog result.' }
      : { Id: itemId, Name: 'Luxo Jr.', Type: 'Movie', Overview: 'A studio catalog result.' }));

    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const toolbar = await screen.findByRole('toolbar', { name: 'Search filters' });
    expect(within(toolbar).getAllByRole('button').map(button => button.textContent)).toEqual([
      'All', 'Movies', 'Shows', 'Episodes', 'Music', 'People', 'Collections', 'Reading', 'Genres', 'Studios'
    ]);
    expect(within(toolbar).getByRole('button', { name: 'Genres' }).getAttribute('data-focus-id')).toBe('search-filter-genres');
    expect(within(toolbar).getByRole('button', { name: 'Studios' }).getAttribute('data-focus-id')).toBe('search-filter-studios');

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Genres' }));
    const input = screen.getByPlaceholderText('Titles, people, music, genres, and studios');
    fireEvent.change(input, { target: { value: 'dream' } });
    const musicGenre = await screen.findByRole('button', { name: 'Dream Pop, Music genre' });
    expect(mockGetSearchGenres).toHaveBeenCalledWith('user-1', 'dream', expect.any(AbortSignal));
    expect(mockGetSearchMusicGenres).toHaveBeenCalledWith('user-1', 'dream', expect.any(AbortSignal));
    expect(mockGetSearch).not.toHaveBeenCalled();
    fireEvent.click(musicGenre);

    await screen.findByRole('heading', { name: 'Dream Pop' });
    expect(mockGetSearchCategoryItems).toHaveBeenCalledWith(
      'user-1',
      'music-genre-dream-pop',
      'MusicGenre',
      0,
      16,
      expect.any(AbortSignal),
      'Dream Pop'
    );
    const album = await screen.findByRole('button', { name: 'Night Drive, 2026' });
    await waitFor(() => {
      expect(album.classList.contains('is-focused')).toBe(true);
      expect(document.activeElement).toBe(album);
    });
    fireEvent.click(album);
    await screen.findByText('A premium album catalog result.');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Dream Pop' });
    const restoredAlbum = await screen.findByRole('button', { name: 'Night Drive, 2026' });
    await waitFor(() => expect(document.activeElement).toBe(restoredAlbum));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restoredToolbar = await screen.findByRole('toolbar', { name: 'Search filters' });
    expect(within(restoredToolbar).getByRole('button', { name: 'Genres' }).getAttribute('aria-pressed')).toBe('true');
    const restoredMusicGenre = await screen.findByRole('button', { name: 'Dream Pop, Music genre' });
    await waitFor(() => {
      expect(restoredMusicGenre.classList.contains('is-focused')).toBe(true);
      expect(document.activeElement).toBe(restoredMusicGenre);
    });
    fireEvent.click(within(restoredToolbar).getByRole('button', { name: 'Studios' }));
    fireEvent.change(screen.getByPlaceholderText('Titles, people, music, genres, and studios'), {
      target: { value: 'pixar' }
    });
    const studio = await screen.findByRole('button', { name: 'Pixar, Studio' });
    fireEvent.click(studio);
    await screen.findByRole('heading', { name: 'Pixar' });
    expect(mockGetSearchCategoryItems).toHaveBeenLastCalledWith(
      'user-1',
      'studio-pixar',
      'Studio',
      0,
      16,
      expect.any(AbortSignal),
      'Pixar'
    );
    expect(await screen.findByRole('button', { name: 'Luxo Jr., 1986' })).toBeTruthy();
  });

  it('clears the category loading state when the Jellyfin catalog request rejects', async () => {
    seedSession();
    mockGetSearchMusicGenres.mockResolvedValue({
      Items: [{ Id: 'music-genre-rock', Name: 'Rock', Type: 'MusicGenre' }]
    });
    mockGetSearchCategoryItems.mockRejectedValue(new Error('Category unavailable'));

    render(<App />);
    await screen.findByRole('heading', { name: 'PiggieTV' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const toolbar = await screen.findByRole('toolbar', { name: 'Search filters' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Genres' }));
    fireEvent.change(screen.getByPlaceholderText('Titles, people, music, genres, and studios'), {
      target: { value: 'rock' }
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Rock, Music genre' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Category unavailable');
    expect(screen.queryByText('Loading category')).toBeNull();
    expect(screen.queryByLabelText('Loading Rock')).toBeNull();
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

  it('uses one StrictMode restore flight and one new generation for an explicit retry', async () => {
    seedSession();
    const recordRestore = vi.spyOn(DiagnosticsService.prototype, 'recordSessionRestore');
    mockValidateSession
      .mockRejectedValueOnce({
        kind: 'network-error',
        message: 'Temporary network failure',
        recoverable: true
      })
      .mockResolvedValueOnce({ Id: 'user-1', Name: 'Stored User' });
    render(<React.StrictMode><App /></React.StrictMode>);

    const retry = await screen.findByRole('button', { name: /retry/i });
    const afterFailure = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session?: unknown };
    expect(afterFailure.session).not.toBeNull();
    expect(mockValidateServer).toHaveBeenCalledTimes(1);
    expect(mockValidateSession).toHaveBeenCalledTimes(1);
    expect(new Set(recordRestore.mock.calls.map(([event]) => (event as { attemptId?: string }).attemptId))).toEqual(
      new Set(['restore-1'])
    );

    fireEvent.click(retry);
    await screen.findByRole('heading', { name: 'PiggieTV' });

    expect(mockValidateServer).toHaveBeenCalledTimes(2);
    expect(mockValidateSession).toHaveBeenCalledTimes(2);
    expect(new Set(recordRestore.mock.calls.map(([event]) => (event as { attemptId?: string }).attemptId))).toEqual(
      new Set(['restore-1', 'restore-2'])
    );
    expect(recordRestore.mock.calls.filter(([event]) => (
      event as { attemptId?: string; stage?: string }
    ).attemptId === 'restore-1' && (event as { stage?: string }).stage === 'USERS_ME_FAILED')).toHaveLength(1);
    expect(recordRestore.mock.calls.filter(([event]) => (
      event as { attemptId?: string; stage?: string }
    ).attemptId === 'restore-2' && (event as { stage?: string }).stage === 'COMPLETE')).toHaveLength(1);
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

  it('shows movie quality and track presets, restores a related shelf, and starts with the selected streams', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    const refreshedMovie = defer<Record<string, unknown>>();
    let movieLoadCount = 0;
    const movieDetails = {
      Id: 'movie-1',
      Name: 'Featured Movie',
      Type: 'Movie',
      Overview: 'Overview',
      MediaSources: [{
        Id: 'source-1',
        Container: 'mkv',
        VideoCodec: 'hevc',
        AudioCodec: 'eac3',
        MediaStreams: [
          { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, VideoRangeType: 'HDR10' },
          { Index: 2, Type: 'Audio', DisplayTitle: 'English - Dolby Digital+ - 5.1', Codec: 'eac3', Channels: 6, IsDefault: true },
          { Index: 4, Type: 'Subtitle', DisplayTitle: 'English - SUBRIP', Codec: 'subrip', IsDefault: true }
        ]
      }]
    };
    mockGetItem.mockImplementation((_userId: string, itemId: string) => {
      if (itemId === 'related-1') {
        return Promise.resolve({
          Id: 'related-1',
          Name: 'Related Movie',
          Type: 'Movie',
          Overview: 'A related movie overview.'
        });
      }
      movieLoadCount += 1;
      return movieLoadCount === 1 ? Promise.resolve(movieDetails) : refreshedMovie.promise;
    });
    mockGetSimilarItems.mockImplementation((_userId: string, itemId: string) => Promise.resolve({
      Items: itemId === 'movie-1'
        ? [{ Id: 'related-1', Name: 'Related Movie', Type: 'Movie', ProductionYear: 2025 }]
        : []
    }));
    mockGetPlaybackInfo.mockResolvedValue({
      PlaySessionId: 'play-session-1',
      MediaSources: [{
        Id: 'source-1',
        Container: 'mkv',
        VideoCodec: 'hevc',
        AudioCodec: 'eac3',
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        MediaStreams: [
          { Index: 0, Type: 'Video', Codec: 'hevc' },
          { Index: 2, Type: 'Audio', DisplayTitle: 'English - Dolby Digital+ - 5.1', Codec: 'eac3', Channels: 6, IsDefault: true },
          { Index: 4, Type: 'Subtitle', DisplayTitle: 'English - SUBRIP', Codec: 'subrip', IsDefault: true }
        ]
      }]
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Featured Movie' }));
    await screen.findByText('Overview');
    const quality = screen.getByRole('list', { name: 'Media quality' });
    expect(within(quality).getByText('4K UHD')).toBeTruthy();
    expect(within(quality).getByText('HDR10')).toBeTruthy();
    expect(within(quality).getByText('HEVC')).toBeTruthy();
    expect(within(quality).getByText('5.1')).toBeTruthy();
    expect((await screen.findByRole('button', { name: /^Audio: English - Dolby Digital\+ - 5\.1/ }) as HTMLButtonElement).disabled).toBe(true);

    const subtitlePreset = await screen.findByRole('button', { name: /^Subtitles: English - SUBRIP/ });
    fireEvent.click(subtitlePreset);
    expect(screen.getByRole('button', { name: /^Subtitles: Off\./ })).toBeTruthy();

    const related = await screen.findByRole('button', { name: 'Related Movie, 2025' });
    fireEvent.focus(related);
    expect(document.querySelector('.ptv-details__content')?.classList.contains('is-related-active')).toBe(true);
    fireEvent.click(related);
    await screen.findByText('A related movie overview.');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    const restoredRelated = await screen.findByRole('button', { name: 'Related Movie, 2025' });
    await waitFor(() => {
      expect(document.activeElement).toBe(restoredRelated);
      expect(restoredRelated.classList.contains('is-focused')).toBe(true);
      expect(document.querySelector('.ptv-details__content')?.classList.contains('is-related-active')).toBe(true);
    });
    expect(mockGetSimilarItems.mock.calls.filter(call => call[1] === 'movie-1')).toHaveLength(1);

    const playButton = screen.getByRole('button', { name: /^play$/i });
    fireEvent.focus(playButton);
    await act(async () => refreshedMovie.resolve(movieDetails));
    await waitFor(() => {
      expect(document.activeElement).toBe(playButton);
      expect(document.querySelector('.ptv-details__content')?.classList.contains('is-related-active')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Subtitles: English - SUBRIP/ }));
    expect(screen.getByRole('button', { name: /^Subtitles: Off\./ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));
    await waitFor(() => expect(mockGetPlaybackInfo).toHaveBeenCalled());
    expect(mockGetPlaybackInfo.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      audioStreamIndex: 2,
      subtitleStreamIndex: null
    }));
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
        { Id: 'season-empty', Name: 'Season 0', Type: 'Season', RecursiveItemCount: 0 },
        { Id: 'season-1', Name: 'Season 1', Type: 'Season', RecursiveItemCount: 1 },
        { Id: 'season-2', Name: 'Season 2', Type: 'Season', RecursiveItemCount: 9 }
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
    const firstSeason = await screen.findByRole('button', { name: 'Season 1' });
    expect(screen.queryByRole('button', { name: 'Season 0' })).toBeNull();
    await screen.findByRole('button', { name: /^Pilot,/ });
    await waitFor(() => expect(document.activeElement).toBe(firstSeason));

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

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 270 },
      currentTime: { configurable: true, writable: true, value: 270 },
      ended: { configurable: true, value: true }
    });
    fireEvent.loadedData(video);
    await waitFor(() => expect(mockReportPlaying).toHaveBeenCalledTimes(1));
    fireEvent.ended(video);
    await waitFor(() => expect(mockGetNextUpForSeries).toHaveBeenCalledTimes(1));
    expect(mockGetNextUpForSeries).toHaveBeenCalledWith(
      'user-1',
      'series-1',
      2,
      expect.any(AbortSignal)
    );

    fireEvent.keyDown(window, { key: 'GoBack', keyCode: 461, which: 461 });
    const restoredEpisode = await screen.findByRole('button', { name: /^Second Season Finale,/ });
    expect(screen.getByText('2 / 2')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(restoredEpisode));
    expect(load).toHaveBeenCalledTimes(2);

    const previousPage = screen.getByRole('button', { name: 'Previous' });
    fireEvent.focus(previousPage);
    expect(document.activeElement).toBe(previousPage);
    fireEvent.keyDown(window, { key: 'GoBack', keyCode: 461, which: 461 });
    fireEvent.click(await screen.findByRole('button', { name: 'The PTV Show' }));

    const fallbackSeason = await screen.findByRole('button', { name: 'Season 1' });
    await waitFor(() => expect(document.activeElement).toBe(fallbackSeason));
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('orders Seasons and Episodes before recommendations and preserves vertical remote navigation', async () => {
    seedSession();
    mockGetRecentlyAdded.mockImplementation((_userId: string, itemType: string) => Promise.resolve({
      Items: itemType === 'Series'
        ? [{ Id: 'series-scroll', Name: 'Scrollable Series', Type: 'Series' }]
        : []
    }));
    mockGetItem.mockResolvedValue({
      Id: 'series-scroll',
      Name: 'Scrollable Series',
      Type: 'Series',
      Overview: 'A series with enough detail rows to require vertical navigation.'
    });
    mockGetSimilarItems.mockResolvedValue({
      Items: [{
        Id: 'related-series',
        Name: 'Related Series',
        Type: 'Series',
        ProductionYear: 1994
      }]
    });
    mockGetSeasons.mockResolvedValue({
      Items: [{ Id: 'season-1', Name: 'Season 1', Type: 'Season', RecursiveItemCount: 1 }]
    });
    mockGetEpisodes.mockResolvedValue({
      Items: [{
        Id: 'episode-1',
        Name: 'Pilot',
        Type: 'Episode',
        SeriesName: 'Scrollable Series',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        RunTimeTicks: 2_700_000_000
      }]
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Scrollable Series' }));
    const related = await screen.findByRole('button', { name: 'Related Series, Series, 1994' });
    const season = await screen.findByRole('button', { name: 'Season 1' });
    const episode = await screen.findByRole('button', { name: /^Pilot,/ });
    const viewport = document.querySelector('.ptv-details__content') as HTMLDivElement;
    expect(viewport).toBeTruthy();
    expect(within(viewport).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Seasons',
      'Episodes',
      'More Like This'
    ]);
    expect(season.compareDocumentPosition(episode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(episode.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const rect = (top: number, bottom: number, left = 100, right = 500) => ({
      x: left,
      y: top,
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({})
    } as DOMRect);
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 700 },
      scrollHeight: { configurable: true, value: 1_400 }
    });
    viewport.scrollTop = 0;
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => rect(100, 800, 0, 1_200));
    vi.spyOn(season, 'getBoundingClientRect').mockImplementation(() => (
      rect(250 - viewport.scrollTop, 306 - viewport.scrollTop)
    ));
    vi.spyOn(episode, 'getBoundingClientRect').mockImplementation(() => (
      rect(420 - viewport.scrollTop, 666 - viewport.scrollTop)
    ));
    vi.spyOn(related, 'getBoundingClientRect').mockImplementation(() => (
      rect(900 - viewport.scrollTop, 1_146 - viewport.scrollTop)
    ));

    fireEvent.focus(season);
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await waitFor(() => expect(document.activeElement).toBe(episode));
    const scrollAtEpisode = viewport.scrollTop;

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });

    await waitFor(() => expect(document.activeElement).toBe(related));
    const scrollAtRelated = viewport.scrollTop;
    expect(scrollAtRelated).toBeGreaterThan(scrollAtEpisode);
    expect(related.getBoundingClientRect().bottom).toBeLessThanOrEqual(704);

    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 });
    await waitFor(() => expect(document.activeElement).toBe(episode));
    const scrollAfterEpisodeReturn = viewport.scrollTop;
    expect(scrollAfterEpisodeReturn).toBeLessThan(scrollAtRelated);

    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 });
    await waitFor(() => expect(document.activeElement).toBe(season));
    expect(viewport.scrollTop).toBeLessThan(scrollAfterEpisodeReturn);
    expect(season.getBoundingClientRect().top).toBeGreaterThanOrEqual(148);
  });

  it('rechecks an empty episode response instead of trapping it in the media cache', async () => {
    seedSession();
    mockGetRecentlyAdded.mockImplementation((_userId: string, itemType: string) => Promise.resolve({
      Items: itemType === 'Series'
        ? [{ Id: 'series-retry', Name: 'Retry Show', Type: 'Series', RecursiveItemCount: 1 }]
        : []
    }));
    mockGetItem.mockResolvedValue({
      Id: 'series-retry',
      Name: 'Retry Show',
      Type: 'Series',
      RecursiveItemCount: 1
    });
    mockGetSeasons.mockResolvedValue({
      Items: [{ Id: 'season-retry', Name: 'Season 1', Type: 'Season', RecursiveItemCount: 1 }]
    });
    mockGetEpisodes
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [{
          Id: 'episode-recovered',
          Name: 'Recovered Episode',
          Type: 'Episode',
          SeriesName: 'Retry Show',
          ParentIndexNumber: 1,
          IndexNumber: 1
        }]
      });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry Show' }));
    const recheck = await screen.findByRole('button', { name: 'Check again' });
    expect(screen.getByText('No indexed episodes are available for this season.')).toBeTruthy();
    expect(mockGetEpisodes).toHaveBeenCalledTimes(1);

    fireEvent.click(recheck);
    await screen.findByRole('button', { name: /^Recovered Episode,/ });
    expect(mockGetEpisodes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
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

  it('keeps Song details visible while audio starts in the mini player', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedSession();
    const track = {
      Id: 'audio-visible-player',
      Name: 'Visible Player Track',
      Type: 'Audio',
      Album: 'Regression Album',
      AlbumArtist: 'Regression Artist',
      Artists: ['Regression Artist'],
      RunTimeTicks: 2_330_000_000,
      ProductionYear: 2026
    };
    mockGetItems.mockResolvedValue({ Items: [track], TotalRecordCount: 1 });
    mockGetItem.mockResolvedValue(track);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Music' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Visible Player Track, 2026' }));
    const details = await screen.findByRole('main', { name: 'Song details' });
    fireEvent.click(within(details).getByRole('button', { name: /^play$/i }));

    await waitFor(() => expect(mockGetPlaybackInfo).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('main', { name: 'Song details' })).toBeTruthy();
    expect(document.querySelector('.ptv-playback-route--mini')).toBeTruthy();
    expect(document.querySelector('.ptv-playback-mini')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Now Playing' }));
    await waitFor(() => expect(document.querySelector('.ptv-playback__now-playing')).toBeTruthy());
    expect(screen.queryByRole('main', { name: 'Song details' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('main', { name: 'Song details' });
    expect(document.querySelector('.ptv-playback-mini')).toBeTruthy();
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

  it('records the initial Home load in diagnostics before any route return', async () => {
    seedSession();
    mockGetResume.mockResolvedValue({ Items: [{ Id: 'movie-1', Name: 'Featured Movie', Type: 'Movie' }] });
    render(<App />);

    await screen.findByRole('button', { name: 'Featured Movie' });
    await waitFor(() => {
      expect(mockGetResume).toHaveBeenCalledTimes(1);
      expect(mockGetNextUp).toHaveBeenCalledTimes(1);
      expect(mockGetRecentlyAdded).toHaveBeenCalledTimes(2);
    });

    await openDiagnostics();
    const diagnosticTabs = screen.getByRole('navigation', { name: 'Diagnostic categories' });
    fireEvent.click(within(diagnosticTabs).getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));

    await waitFor(() => {
      const output = document.querySelector('.ptv-diagnostics__output')?.textContent ?? '';
      expect(output).toContain('"latestAttempt": {');
      expect(output).toContain('"maxActiveRequests": 3');
      expect(output).toContain('"status": "route-hidden"');
      expect(output.match(/"outcome": "success"/g)).toHaveLength(8);
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
