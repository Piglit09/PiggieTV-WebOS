import type { PtvItem, PtvUserSession } from '../types/ptv';

export type HomeSectionId = 'continue' | 'nextup' | 'movies' | 'shows';

interface CachedHomeSection {
  expiresAt: number;
  items: PtvItem[];
}

interface HomeCacheEntry {
  sessionKey: string;
  sections: Partial<Record<HomeSectionId, CachedHomeSection>>;
}

export const HOME_CACHE_TTL_MS = 120_000;
let homeCache: HomeCacheEntry | null = null;

export function createHomeCacheSessionKey(serverUrl: string | null, session: PtvUserSession | null) {
  if (!serverUrl || !session) return null;
  return `${serverUrl}\u0000${session.userId}\u0000${session.updatedAt}`;
}

export function synchronizeHomeCacheSession(sessionKey: string | null) {
  if (!sessionKey || (homeCache && homeCache.sessionKey !== sessionKey)) {
    homeCache = null;
  }
}

export function readHomeCacheSection(
  sessionKey: string | null,
  sectionId: HomeSectionId,
  now = Date.now()
) {
  if (!sessionKey || !homeCache) return undefined;
  if (homeCache.sessionKey !== sessionKey) {
    homeCache = null;
    return undefined;
  }
  const cached = homeCache.sections[sectionId];
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    const sections = { ...homeCache.sections };
    delete sections[sectionId];
    homeCache = { ...homeCache, sections };
    return undefined;
  }
  return [...cached.items];
}

export function writeHomeCacheSection(
  sessionKey: string,
  sectionId: HomeSectionId,
  items: PtvItem[],
  now = Date.now()
) {
  const sections = homeCache?.sessionKey === sessionKey ? { ...homeCache.sections } : {};
  for (const cachedSectionId of Object.keys(sections) as HomeSectionId[]) {
    if ((sections[cachedSectionId]?.expiresAt ?? 0) <= now) delete sections[cachedSectionId];
  }
  homeCache = {
    sessionKey,
    sections: {
      ...sections,
      [sectionId]: {
        expiresAt: now + HOME_CACHE_TTL_MS,
        items: [...items]
      }
    }
  };
}

export function clearHomeCache() {
  homeCache = null;
}
