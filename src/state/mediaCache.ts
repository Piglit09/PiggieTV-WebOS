import type { PtvItem, PtvUserSession } from '../types/ptv';

export type MediaBrowseScreen = 'movies' | 'shows' | 'music' | 'reading';
export type MediaBrowseFilter = 'recent' | 'az' | 'favorites';

export interface CachedSeriesEpisodes {
  seasonId: string;
  items: PtvItem[];
}

export interface CachedBrowsePage {
  screen: MediaBrowseScreen;
  filter: MediaBrowseFilter;
  page: number;
  items: PtvItem[];
  totalRecordCount?: number;
}

export interface RememberedBrowseLocation {
  filter: MediaBrowseFilter;
  page: number;
}

export interface CachedSearchSnapshot {
  query: string;
  items: PtvItem[];
}

interface TimedValue<T> {
  expiresAt: number;
  value: T;
}

interface SeriesCacheEntry {
  seasons?: TimedValue<PtvItem[]>;
  selectedSeason?: string | null;
  episodes?: TimedValue<CachedSeriesEpisodes>;
}

interface MediaCacheEntry {
  sessionKey: string;
  metadata: Map<string, TimedValue<PtvItem>>;
  series: Map<string, SeriesCacheEntry>;
  browsePages: Map<string, TimedValue<CachedBrowsePage>>;
  browseLocations: Map<MediaBrowseScreen, RememberedBrowseLocation>;
  search?: CachedSearchSnapshot;
}

type MediaCacheSessionIdentity = Pick<PtvUserSession, 'serverId' | 'userId' | 'updatedAt'>;

export const MEDIA_CACHE_TTL_MS = 120_000;

let activeSessionKey: string | null = null;
let mediaCache: MediaCacheEntry | null = null;

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(entry => cloneValue(entry)) as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneValue(entry);
    }
    return result as T;
  }
  return value;
}

function createEntry(sessionKey: string): MediaCacheEntry {
  return {
    sessionKey,
    metadata: new Map(),
    series: new Map(),
    browsePages: new Map(),
    browseLocations: new Map()
  };
}

function getEntry(sessionKey: string | null, create = false) {
  if (!sessionKey || activeSessionKey !== sessionKey) return null;
  if (!mediaCache || mediaCache.sessionKey !== sessionKey) {
    if (!create) return null;
    mediaCache = createEntry(sessionKey);
  }
  return mediaCache;
}

function readTimedValue<T>(
  value: TimedValue<T> | undefined,
  now: number,
  removeExpired: () => void
) {
  if (!value) return undefined;
  if (value.expiresAt <= now) {
    removeExpired();
    return undefined;
  }
  return cloneValue(value.value);
}

function isValidPage(page: number) {
  return Number.isInteger(page) && page >= 0;
}

function browsePageKey(screen: MediaBrowseScreen, filter: MediaBrowseFilter, page: number) {
  return `${screen}\u0000${filter}\u0000${page}`;
}

export function createMediaCacheSessionKey(
  serverUrl: string | null,
  session: MediaCacheSessionIdentity | null
) {
  const normalizedUrl = serverUrl?.trim();
  const serverId = session?.serverId.trim();
  const userId = session?.userId.trim();
  if (!normalizedUrl || !serverId || !userId || !Number.isFinite(session?.updatedAt)) return null;
  return `${normalizedUrl}\u0000${serverId}\u0000${userId}\u0000${session?.updatedAt}`;
}

export function synchronizeMediaCacheSession(sessionKey: string | null) {
  if (activeSessionKey === sessionKey) return;
  activeSessionKey = sessionKey;
  mediaCache = sessionKey ? createEntry(sessionKey) : null;
}

export function clearMediaCache() {
  activeSessionKey = null;
  mediaCache = null;
}

export function writeMediaMetadata(sessionKey: string, item: PtvItem, now = Date.now()) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !item.id.trim()) return false;
  entry.metadata.set(item.id, {
    expiresAt: now + MEDIA_CACHE_TTL_MS,
    value: cloneValue(item)
  });
  return true;
}

export function readMediaMetadata(sessionKey: string | null, itemId: string, now = Date.now()) {
  const entry = getEntry(sessionKey);
  if (!entry) return undefined;
  return readTimedValue(entry.metadata.get(itemId), now, () => entry.metadata.delete(itemId));
}

export function writeSeriesSeasons(
  sessionKey: string,
  seriesId: string,
  seasons: PtvItem[],
  now = Date.now()
) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !seriesId.trim()) return false;
  const series = entry.series.get(seriesId) ?? {};
  series.seasons = {
    expiresAt: now + MEDIA_CACHE_TTL_MS,
    value: cloneValue(seasons)
  };
  entry.series.set(seriesId, series);
  return true;
}

export function readSeriesSeasons(sessionKey: string | null, seriesId: string, now = Date.now()) {
  const entry = getEntry(sessionKey);
  const series = entry?.series.get(seriesId);
  if (!entry || !series) return undefined;
  return readTimedValue(series.seasons, now, () => {
    delete series.seasons;
    if (!series.selectedSeason && !series.episodes) entry.series.delete(seriesId);
  });
}

export function writeSelectedSeriesSeason(
  sessionKey: string,
  seriesId: string,
  seasonId: string | null
) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !seriesId.trim() || (seasonId !== null && !seasonId.trim())) return false;
  const series = entry.series.get(seriesId) ?? {};
  series.selectedSeason = seasonId;
  entry.series.set(seriesId, series);
  return true;
}

export function readSelectedSeriesSeason(
  sessionKey: string | null,
  seriesId: string
): string | null | undefined {
  const entry = getEntry(sessionKey);
  const series = entry?.series.get(seriesId);
  if (!entry || !series) return undefined;
  return series.selectedSeason;
}

export function writeSeriesEpisodes(
  sessionKey: string,
  seriesId: string,
  seasonId: string,
  items: PtvItem[],
  now = Date.now()
) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !seriesId.trim() || !seasonId.trim()) return false;
  const series = entry.series.get(seriesId) ?? {};
  series.episodes = {
    expiresAt: now + MEDIA_CACHE_TTL_MS,
    value: {
      seasonId,
      items: cloneValue(items)
    }
  };
  entry.series.set(seriesId, series);
  return true;
}

export function readSeriesEpisodes(
  sessionKey: string | null,
  seriesId: string,
  now = Date.now()
) {
  const entry = getEntry(sessionKey);
  const series = entry?.series.get(seriesId);
  if (!entry || !series) return undefined;
  return readTimedValue(series.episodes, now, () => {
    delete series.episodes;
    if (!series.seasons && !series.selectedSeason) entry.series.delete(seriesId);
  });
}

export function writeBrowsePage(sessionKey: string, page: CachedBrowsePage, now = Date.now()) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !isValidPage(page.page)) return false;
  const key = browsePageKey(page.screen, page.filter, page.page);
  entry.browsePages.set(key, {
    expiresAt: now + MEDIA_CACHE_TTL_MS,
    value: cloneValue(page)
  });
  return true;
}

export function readBrowsePage(
  sessionKey: string | null,
  screen: MediaBrowseScreen,
  filter: MediaBrowseFilter,
  page: number,
  now = Date.now()
) {
  const entry = getEntry(sessionKey);
  if (!entry || !isValidPage(page)) return undefined;
  const key = browsePageKey(screen, filter, page);
  return readTimedValue(entry.browsePages.get(key), now, () => entry.browsePages.delete(key));
}

export function rememberBrowseLocation(
  sessionKey: string,
  screen: MediaBrowseScreen,
  location: RememberedBrowseLocation
) {
  const entry = getEntry(sessionKey, true);
  if (!entry || !isValidPage(location.page)) return false;
  entry.browseLocations.set(screen, cloneValue(location));
  return true;
}

export function readRememberedBrowseLocation(
  sessionKey: string | null,
  screen: MediaBrowseScreen
) {
  const entry = getEntry(sessionKey);
  if (!entry) return undefined;
  const location = entry.browseLocations.get(screen);
  return location ? cloneValue(location) : undefined;
}

export function writeSearchSnapshot(
  sessionKey: string,
  snapshot: CachedSearchSnapshot
) {
  const entry = getEntry(sessionKey, true);
  if (!entry) return false;
  entry.search = {
    query: snapshot.query,
    items: cloneValue(snapshot.items.slice(0, 16))
  };
  return true;
}

export function readSearchSnapshot(sessionKey: string | null) {
  const entry = getEntry(sessionKey);
  if (!entry) return undefined;
  return entry.search ? cloneValue(entry.search) : undefined;
}
