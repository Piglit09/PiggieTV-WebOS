import { afterEach, describe, expect, it } from 'vitest';
import {
  HOME_CACHE_TTL_MS,
  clearHomeCache,
  createHomeCacheSessionKey,
  readHomeCacheSection,
  synchronizeHomeCacheSession,
  writeHomeCacheSection
} from '../src/state/homeCache';
import type { PtvItem, PtvUserSession } from '../src/types/ptv';

const cachedItem: PtvItem = {
  id: 'item-1',
  name: 'Cached item',
  type: 'Movie'
};

function session(overrides: Partial<PtvUserSession> = {}): PtvUserSession {
  return {
    userId: 'user-1',
    userName: 'User',
    accessToken: 'must-not-enter-cache-key',
    serverId: 'server-1',
    serverUrl: 'https://server.example.com',
    deviceId: 'device-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

afterEach(() => clearHomeCache());

describe('Home cache session and expiry boundaries', () => {
  it('builds a session-specific key without including the access token', () => {
    const first = createHomeCacheSessionKey('https://server.example.com', session());
    const nextUser = createHomeCacheSessionKey('https://server.example.com', session({ userId: 'user-2' }));

    expect(first).toBeTruthy();
    expect(first).not.toContain('must-not-enter-cache-key');
    expect(nextUser).not.toBe(first);
    expect(createHomeCacheSessionKey(null, session())).toBeNull();
    expect(createHomeCacheSessionKey('https://server.example.com', null)).toBeNull();
  });

  it('expires each row independently when another row refreshes', () => {
    const key = createHomeCacheSessionKey('https://server.example.com', session()) as string;
    writeHomeCacheSection(key, 'shows', [cachedItem], 0);
    writeHomeCacheSection(key, 'continue', [], HOME_CACHE_TTL_MS - 1);

    expect(readHomeCacheSection(key, 'shows', HOME_CACHE_TTL_MS + 1)).toBeUndefined();
    expect(readHomeCacheSection(key, 'continue', HOME_CACHE_TTL_MS + 1)).toEqual([]);
  });

  it('clears retained rows on session change or sign-out', () => {
    const firstKey = createHomeCacheSessionKey('https://server.example.com', session()) as string;
    const nextKey = createHomeCacheSessionKey(
      'https://server.example.com',
      session({ userId: 'user-2', updatedAt: 3 })
    ) as string;
    writeHomeCacheSection(firstKey, 'movies', [cachedItem], 0);

    synchronizeHomeCacheSession(nextKey);
    expect(readHomeCacheSection(firstKey, 'movies', 1)).toBeUndefined();
    expect(readHomeCacheSection(nextKey, 'movies', 1)).toBeUndefined();

    writeHomeCacheSection(nextKey, 'movies', [cachedItem], 1);
    synchronizeHomeCacheSession(null);
    expect(readHomeCacheSection(nextKey, 'movies', 2)).toBeUndefined();
  });

  it('returns array copies so consumers cannot mutate cached row membership', () => {
    const key = createHomeCacheSessionKey('https://server.example.com', session()) as string;
    writeHomeCacheSection(key, 'movies', [cachedItem], 0);
    const firstRead = readHomeCacheSection(key, 'movies', 1);
    firstRead?.pop();

    expect(readHomeCacheSection(key, 'movies', 1)).toEqual([cachedItem]);
  });
});
