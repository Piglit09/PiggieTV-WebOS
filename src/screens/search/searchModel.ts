import type { PtvItem, PtvSearchCategoryKind } from '../../types/ptv';

export type { PtvSearchCategoryKind } from '../../types/ptv';

export type PtvSearchFilterId =
  | 'all'
  | 'movies'
  | 'shows'
  | 'episodes'
  | 'music'
  | 'people'
  | 'collections'
  | 'reading'
  | 'genres'
  | 'studios';

export interface PtvSearchFilterConfig {
  id: PtvSearchFilterId;
  label: string;
  includeItemTypes: string;
  categoryKinds?: readonly PtvSearchCategoryKind[];
}

export interface PtvSearchCategoryRoute {
  id: string;
  kind: PtvSearchCategoryKind;
  name: string;
}

export const PTV_SEARCH_RESULT_LIMIT = 16;
export const PTV_ALL_SEARCH_ITEM_TYPES = 'Movie,Series,Episode,MusicAlbum,Audio,MusicVideo,MusicArtist,Playlist,Person,BoxSet,Book';

export const PTV_SEARCH_FILTERS: readonly PtvSearchFilterConfig[] = [
  { id: 'all', label: 'All', includeItemTypes: PTV_ALL_SEARCH_ITEM_TYPES, categoryKinds: ['Genre', 'MusicGenre', 'Studio'] },
  { id: 'movies', label: 'Movies', includeItemTypes: 'Movie' },
  { id: 'shows', label: 'Shows', includeItemTypes: 'Series' },
  { id: 'episodes', label: 'Episodes', includeItemTypes: 'Episode' },
  { id: 'music', label: 'Music', includeItemTypes: 'MusicAlbum,Audio,MusicVideo,MusicArtist,Playlist' },
  { id: 'people', label: 'People', includeItemTypes: 'Person' },
  { id: 'collections', label: 'Collections', includeItemTypes: 'BoxSet' },
  { id: 'reading', label: 'Reading', includeItemTypes: 'Book' },
  { id: 'genres', label: 'Genres', includeItemTypes: '', categoryKinds: ['Genre', 'MusicGenre'] },
  { id: 'studios', label: 'Studios', includeItemTypes: '', categoryKinds: ['Studio'] }
];

const SEARCH_FILTER_IDS = new Set<PtvSearchFilterId>(PTV_SEARCH_FILTERS.map(filter => filter.id));
const SEARCH_CATEGORY_ROUTE_PREFIX = 'category:';

export function normalizePtvSearchFilter(value: unknown): PtvSearchFilterId {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SEARCH_FILTER_IDS.has(normalized as PtvSearchFilterId)
    ? normalized as PtvSearchFilterId
    : 'all';
}

export function getPtvSearchFilterConfig(filter: PtvSearchFilterId) {
  return PTV_SEARCH_FILTERS.find(candidate => candidate.id === filter) ?? PTV_SEARCH_FILTERS[0]!;
}

export function isPtvSearchCategoryItem(item: Pick<PtvItem, 'type'>): item is PtvItem & { type: PtvSearchCategoryKind } {
  return item.type === 'Genre' || item.type === 'MusicGenre' || item.type === 'Studio';
}

export function getPtvSearchItemTypeLabel(item: Pick<PtvItem, 'type'>) {
  if (item.type === 'MusicGenre') return 'Music genre';
  if (item.type === 'Genre') return 'Genre';
  if (item.type === 'Studio') return 'Studio';
  if (item.type === 'Collection') return 'Collection';
  return item.type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function normalizeSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function getSearchRank(item: PtvItem, query: string) {
  const normalizedName = normalizeSearchText(item.name);
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  return 3;
}

function rankAndDedupe(items: readonly PtvItem[], query: string) {
  const seen = new Set<string>();
  return items
    .filter(item => {
      const key = `${item.type}:${item.id}`;
      if (!item.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item, index) => ({ index, item }))
    .sort((left, right) => (
      getSearchRank(left.item, query) - getSearchRank(right.item, query)
      || left.index - right.index
    ))
    .map(entry => entry.item);
}

export function mergePtvSearchResults(
  sources: readonly (readonly PtvItem[])[],
  query: string,
  filter: PtvSearchFilterId,
  limit = PTV_SEARCH_RESULT_LIMIT
) {
  const safeLimit = Math.max(0, Math.floor(limit));
  const combined = sources.reduce<PtvItem[]>((results, source) => {
    results.push(...source);
    return results;
  }, []);
  const ranked = rankAndDedupe(combined, query);
  if (filter !== 'all') return ranked.slice(0, safeLimit);

  const taxonomy = ranked.filter(isPtvSearchCategoryItem).slice(0, Math.min(4, safeLimit));
  const content = ranked.filter(item => !isPtvSearchCategoryItem(item));
  return rankAndDedupe([
    ...taxonomy,
    ...content.slice(0, Math.max(0, safeLimit - taxonomy.length))
  ], query).slice(0, safeLimit);
}

export function buildPtvSearchCategorySection(kind: PtvSearchCategoryKind, name: string) {
  return `${SEARCH_CATEGORY_ROUTE_PREFIX}${kind}:${encodeURIComponent(name.trim())}`;
}

export function parsePtvSearchCategoryRoute(
  itemId: string | null | undefined,
  sectionId: string | null | undefined
): PtvSearchCategoryRoute | null {
  const id = itemId?.trim() ?? '';
  const value = sectionId?.trim() ?? '';
  const match = /^category:(Genre|MusicGenre|Studio):(.*)$/.exec(value);
  if (!id || !match?.[1]) return null;

  try {
    const name = decodeURIComponent(match[2] ?? '').trim();
    if (!name) return null;
    return { id, kind: match[1] as PtvSearchCategoryKind, name };
  } catch {
    return null;
  }
}
