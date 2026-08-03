import { afterEach, describe, expect, it } from 'vitest';
import {
  MEDIA_CACHE_TTL_MS,
  clearMediaCache,
  createMediaCacheSessionKey,
  readBrowsePage,
  readMediaMetadata,
  readRememberedBrowseLocation,
  readSearchSnapshot,
  readSelectedSeriesSeason,
  readSeriesEpisodes,
  readSeriesSeasons,
  rememberBrowseLocation,
  synchronizeMediaCacheSession,
  writeBrowsePage,
  writeMediaMetadata,
  writeSearchSnapshot,
  writeSelectedSeriesSeason,
  writeSeriesEpisodes,
  writeSeriesSeasons
} from '../src/state/mediaCache';
import type { PtvItem, PtvUserSession } from '../src/types/ptv';

function session(overrides: Partial<PtvUserSession> = {}): PtvUserSession {
  return {
    userId: 'user-1',
    userName: 'User',
    accessToken: 'must-not-enter-media-cache-key',
    serverId: 'server-1',
    serverUrl: 'https://server.example.com',
    deviceId: 'device-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function item(id: string, overrides: Partial<PtvItem> = {}): PtvItem {
  return {
    id,
    name: `Item ${id}`,
    type: 'Movie',
    imageTags: { Primary: `primary-${id}` },
    backdropImageTags: [`backdrop-${id}`],
    ...overrides
  };
}

function keyFor(value = session()) {
  return createMediaCacheSessionKey(value.serverUrl, value) as string;
}

afterEach(() => clearMediaCache());

describe('Phase 2 media cache', () => {
  it('creates a session-generation key without including credentials', () => {
    const first = keyFor();
    const otherUser = keyFor(session({ userId: 'user-2' }));
    const otherServer = keyFor(session({ serverId: 'server-2' }));
    const newerSession = keyFor(session({ updatedAt: 3 }));

    expect(first).not.toContain('must-not-enter-media-cache-key');
    expect(new Set([first, otherUser, otherServer, newerSession]).size).toBe(4);
    expect(createMediaCacheSessionKey(null, session())).toBeNull();
    expect(createMediaCacheSessionKey('https://server.example.com', null)).toBeNull();
  });

  it('isolates sessions, clears on sign-out, and rejects late writes from an old session', () => {
    const firstKey = keyFor();
    const nextKey = keyFor(session({ userId: 'user-2', updatedAt: 3 }));
    synchronizeMediaCacheSession(firstKey);
    expect(writeMediaMetadata(firstKey, item('first'), 0)).toBe(true);

    synchronizeMediaCacheSession(nextKey);
    expect(readMediaMetadata(firstKey, 'first', 1)).toBeUndefined();
    expect(writeMediaMetadata(firstKey, item('late'), 1)).toBe(false);
    expect(readMediaMetadata(nextKey, 'late', 1)).toBeUndefined();

    expect(writeMediaMetadata(nextKey, item('next'), 1)).toBe(true);
    synchronizeMediaCacheSession(null);
    expect(readMediaMetadata(nextKey, 'next', 2)).toBeUndefined();
    expect(writeMediaMetadata(nextKey, item('late-after-sign-out'), 2)).toBe(false);
  });

  it('expires metadata independently and deep-copies values on write and read', () => {
    const key = keyFor();
    synchronizeMediaCacheSession(key);
    const source = item('movie-1');
    writeMediaMetadata(key, source, 0);
    source.name = 'Mutated source';
    if (source.imageTags) source.imageTags.Primary = 'mutated-source-tag';

    const firstRead = readMediaMetadata(key, 'movie-1', 1);
    expect(firstRead).toMatchObject({ name: 'Item movie-1', imageTags: { Primary: 'primary-movie-1' } });
    if (firstRead?.imageTags) firstRead.imageTags.Primary = 'mutated-read-tag';
    firstRead?.backdropImageTags?.pop();

    expect(readMediaMetadata(key, 'movie-1', 1)).toMatchObject({
      imageTags: { Primary: 'primary-movie-1' },
      backdropImageTags: ['backdrop-movie-1']
    });
    expect(readMediaMetadata(key, 'movie-1', MEDIA_CACHE_TTL_MS)).toBeUndefined();
  });

  it('caches Series state while retaining only the latest season episode list', () => {
    const key = keyFor();
    synchronizeMediaCacheSession(key);
    const seasons = [
      item('season-1', { type: 'Season' }),
      item('season-2', { type: 'Season' })
    ];
    writeSeriesSeasons(key, 'series-1', seasons, 0);
    writeSelectedSeriesSeason(key, 'series-1', 'season-1');
    writeSeriesEpisodes(key, 'series-1', 'season-1', [item('episode-1', { type: 'Episode' })], 0);

    const cachedSeasons = readSeriesSeasons(key, 'series-1', 1);
    cachedSeasons?.pop();
    expect(readSeriesSeasons(key, 'series-1', 1)).toHaveLength(2);
    expect(readSelectedSeriesSeason(key, 'series-1')).toBe('season-1');
    expect(readSeriesEpisodes(key, 'series-1', 1)).toMatchObject({
      seasonId: 'season-1',
      items: [{ id: 'episode-1' }]
    });

    writeSelectedSeriesSeason(key, 'series-1', 'season-2');
    writeSeriesEpisodes(key, 'series-1', 'season-2', [item('episode-2', { type: 'Episode' })], 2);
    expect(readSeriesEpisodes(key, 'series-1', 3)).toMatchObject({
      seasonId: 'season-2',
      items: [{ id: 'episode-2' }]
    });
    expect(readSeriesSeasons(key, 'series-1', MEDIA_CACHE_TTL_MS)).toBeUndefined();
    expect(readSeriesEpisodes(key, 'series-1', MEDIA_CACHE_TTL_MS + 3)).toBeUndefined();
    expect(readSelectedSeriesSeason(key, 'series-1')).toBe('season-2');
  });

  it('keys browse pages by screen, filter, and page while remembering location separately', () => {
    const key = keyFor();
    synchronizeMediaCacheSession(key);
    writeBrowsePage(key, {
      screen: 'movies',
      filter: 'az',
      page: 0,
      items: [item('movie-a')],
      totalRecordCount: 2
    }, 0);
    writeBrowsePage(key, {
      screen: 'movies',
      filter: 'az',
      page: 1,
      items: [item('movie-b')],
      totalRecordCount: 2
    }, 1);
    rememberBrowseLocation(key, 'movies', { filter: 'az', page: 1 });

    expect(readBrowsePage(key, 'movies', 'az', 0, 2)?.items[0]?.id).toBe('movie-a');
    const secondPage = readBrowsePage(key, 'movies', 'az', 1, 2);
    expect(secondPage?.items[0]?.id).toBe('movie-b');
    secondPage?.items.pop();
    expect(readBrowsePage(key, 'movies', 'az', 1, 2)?.items).toHaveLength(1);
    expect(readBrowsePage(key, 'shows', 'az', 1, 2)).toBeUndefined();
    expect(readBrowsePage(key, 'movies', 'favorites', 1, 2)).toBeUndefined();

    const location = readRememberedBrowseLocation(key, 'movies');
    expect(location).toEqual({ filter: 'az', page: 1 });
    if (location) location.page = 0;
    expect(readRememberedBrowseLocation(key, 'movies')).toEqual({ filter: 'az', page: 1 });
    expect(readBrowsePage(key, 'movies', 'az', 1, MEDIA_CACHE_TTL_MS + 1)).toBeUndefined();
    expect(readRememberedBrowseLocation(key, 'movies')).toEqual({ filter: 'az', page: 1 });
  });

  it('restores a bounded Search snapshot only within the active session', () => {
    const key = keyFor();
    synchronizeMediaCacheSession(key);
    const items = Array.from({ length: 20 }, (_, index) => item(`search-${index}`));

    expect(writeSearchSnapshot(key, { query: 'space', items })).toBe(true);
    const snapshot = readSearchSnapshot(key);
    expect(snapshot?.query).toBe('space');
    expect(snapshot?.items).toHaveLength(16);
    snapshot?.items.pop();
    expect(readSearchSnapshot(key)?.items).toHaveLength(16);

    synchronizeMediaCacheSession(keyFor(session({ userId: 'user-2', updatedAt: 3 })));
    expect(readSearchSnapshot(key)).toBeUndefined();
  });
});
