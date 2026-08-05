import type { PtvError, PtvItem, PtvItemKind, PtvLibrary, PtvMediaSource, PtvMediaStreamInfo } from '../../types/ptv';
import { toPtvError } from '../../core/errors';

const KNOWN_TYPES: readonly string[] = [
  'Movie',
  'Series',
  'Episode',
  'Season',
  'Person',
  'MusicArtist',
  'MusicAlbum',
  'Audio',
  'MusicVideo',
  'Book',
  'Playlist',
  'Game',
  'PhotoAlbum',
  'Folder',
  'Collection',
  'Channel'
];
const DETAIL_NAVIGABLE_TYPES: readonly PtvItemKind[] = [
  'Movie',
  'Series',
  'Episode',
  'Season',
  'MusicAlbum',
  'MusicArtist',
  'Audio',
  'MusicVideo',
  'Book'
] as const;

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeImageTags(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw)) {
    const normalized = typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    if (normalized) entries.push([key, normalized]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeImageTagArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = raw
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(value => value !== '');
  return tags.length ? tags : undefined;
}

function normalizeStringArray(raw: unknown, maximum = 8): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map(value => toOptionalString(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, maximum);
  return values.length ? values : undefined;
}

function normalizeTrackArtists(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const artists = raw
    .map(item => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return (
        toOptionalString(record.Name) ??
        toOptionalString(record.name) ??
        toOptionalString((record as { artist?: unknown }).artist)
      )?.trim();
    })
    .filter((value): value is string => Boolean(value));
  return artists.length ? artists : undefined;
}

function normalizeMediaStreams(raw: unknown): PtvMediaStreamInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const streams: Array<PtvMediaStreamInfo | undefined> = raw.map(item => {
    if (!item || typeof item !== 'object') return undefined;
    const source = item as Record<string, unknown>;
    const id = toOptionalString(source.Id) ?? toOptionalString(source.StreamId);
    const index = toOptionalNumber(source.Index);
    const codec = toOptionalString(source.Codec);
    const container = toOptionalString(source.Container);
    const language = toOptionalString(source.Language);
    const title = toOptionalString(source.Title);
    const channelCount = typeof source.ChannelLayout === 'string'
      ? Number(source.ChannelLayout)
      : typeof source.Channels === 'number'
        ? source.Channels
        : typeof source.ChannelCount === 'number'
          ? source.ChannelCount
          : undefined;
    const isDefault = source.IsDefault === true;
    const isForced = source.IsForced === true;
    const isExternal = source.IsExternal === true;
    const isVideoStream = source.Type === 'Video';
    const isAudioStream = source.Type === 'Audio';

    return {
      id,
      index,
      container,
      codec,
      language,
      title,
      channelCount: Number.isFinite(channelCount as number) ? Number(channelCount) : undefined,
      isDefault,
      isForced,
      isExternal,
      isVideoStream,
      isAudioStream
    };
  });
  const resolvedStreams = streams
    .filter((stream): stream is PtvMediaStreamInfo => Boolean(stream))
    .filter((stream): stream is PtvMediaStreamInfo => (
      Boolean(stream.id) || Boolean(stream.index) || Boolean(stream.codec)
    ));

  return resolvedStreams.length ? resolvedStreams : undefined;
}

function normalizeMediaSources(raw: unknown): PtvMediaSource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sources: Array<PtvMediaSource | undefined> = raw.map(item => {
    if (!item || typeof item !== 'object') return undefined;
    const source = item as Record<string, unknown>;
    return {
      id: toOptionalString(source.Id),
      container: toOptionalString(source.Container),
      codec: toOptionalString(source.Codec),
      isRemote: source.IsRemote === true,
      bitrate: toOptionalNumber(source.Bitrate),
      width: toOptionalNumber(source.Width),
      height: toOptionalNumber(source.Height),
      directStreamUrl: toOptionalString(source.DirectStreamUrl),
      transcodingUrl: toOptionalString(source.TranscodingUrl),
      streams: normalizeMediaStreams(source.MediaStreams)
    };
  });
  const resolvedSources = sources.filter((source): source is PtvMediaSource => Boolean(source?.id));
  return resolvedSources.length ? resolvedSources : undefined;
}

function safeDisplayName(nameSource: unknown, fallback = 'Untitled'): string {
  const fallbackCandidates = [
    toOptionalString(nameSource)
  ];

  const name = fallbackCandidates.find(Boolean) as string | undefined;
  return name ?? fallback;
}

function coerceType(raw: unknown): PtvItemKind {
  const type = toOptionalString(raw)?.toLowerCase();
  if (!type) return 'Unknown';
  const exact = KNOWN_TYPES.find(candidate => candidate.toLowerCase() === type);
  return exact ? (exact as PtvItemKind) : 'Unknown';
}

export function mapItemTypeFromServer(raw: unknown): PtvItemKind {
  return coerceType(raw);
}

export function mapLibraryList(raw: unknown): PtvLibrary[] {
  if (!raw || typeof raw !== 'object') return [];
  const items = (raw as { Items?: unknown[] }).Items;
  if (!Array.isArray(items)) return [];

  const result: PtvLibrary[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const candidate = item as { Id?: unknown; Name?: unknown; CollectionType?: unknown; MediaType?: unknown };
    const id = toOptionalString(candidate.Id);
    if (!id) continue;
    const name = safeDisplayName(candidate.Name, id);
    result.push({
      id,
      name,
      collectionType: typeof candidate.CollectionType === 'string' ? candidate.CollectionType : undefined,
      mediaTypes: typeof candidate.MediaType === 'string' ? [candidate.MediaType] : undefined
    });
  }

  return result;
}

export interface MapPtvItemOptions {
  includeUnsupportedTypes?: boolean;
}

export function mapPtvItem(raw: unknown): PtvItem {
  if (!raw || typeof raw !== 'object') {
    throw toPtvError('Invalid item payload', 'invalid-server-response');
  }

  const value = raw as Record<string, unknown>;
  const mappedType = coerceType(value.Type);
  const id = toOptionalString(value.Id);
  if (!id) {
    throw toPtvError('Item id is required', 'invalid-server-response');
  }

  const userData = typeof value.UserData === 'object' && value.UserData !== null
    ? value.UserData as Record<string, unknown>
    : {};
  const imageTags = normalizeImageTags(value.ImageTags);
  const primaryImageTag =
    typeof value.PrimaryImageTag === 'string' && value.PrimaryImageTag.trim() !== '' ? value.PrimaryImageTag.trim() : undefined;
  const fallbackImage = primaryImageTag ? { Primary: primaryImageTag } : undefined;
  const mergedImageTags = imageTags ?? fallbackImage;

  return {
    id,
    name: safeDisplayName(value.Name ?? value.OriginalTitle ?? value.SortName ?? value.Path, 'Untitled'),
    type: mappedType !== 'Unknown'
      ? mappedType
      : (toOptionalString(value.MediaType)?.toLowerCase() === 'audio' ? 'Audio' : 'Unknown'),
    mediaType: toOptionalString(value.MediaType),
    seriesId: toOptionalString(value.SeriesId),
    seriesName: toOptionalString(value.SeriesName),
    seasonId: toOptionalString(value.SeasonId),
    seasonName: toOptionalString(value.SeasonName),
    parentId: toOptionalString(value.ParentId),
    indexNumber: toOptionalNumber(value.IndexNumber),
    parentIndexNumber: toOptionalNumber(value.ParentIndexNumber),
    productionYear: toOptionalNumber(value.ProductionYear),
    premiereDate: toOptionalString(value.PremiereDate),
    endDate: toOptionalString(value.EndDate),
    status: toOptionalString(value.Status),
    overview: toOptionalString(value.Overview),
    runTimeTicks: toOptionalNumber(value.RunTimeTicks),
    officialRating: toOptionalString(value.OfficialRating),
    communityRating: toOptionalNumber(value.CommunityRating),
      genres: normalizeStringArray(value.Genres),
      artists: normalizeTrackArtists(value.Artists),
      albumArtist: toOptionalString(value.AlbumArtist),
      album: toOptionalString(value.Album),
      albumId: toOptionalString(value.AlbumId),
      trackNumber: toOptionalNumber(value.IndexNumber),
      trackCount: toOptionalNumber(value.TrackCount),
      container: toOptionalString(value.Container),
      codec: toOptionalString(value.Codec),
      imageTags: mergedImageTags,
      backdropImageTags: normalizeImageTagArray(value.BackdropImageTags),
      mediaSources: normalizeMediaSources(value.MediaSources),
      playbackPositionTicks: toOptionalNumber(userData.PlaybackPositionTicks),
      played: typeof userData.Played === 'boolean' ? userData.Played : undefined,
      favorite: typeof userData.IsFavorite === 'boolean' ? userData.IsFavorite : undefined
    };
}

export function mapPtvItems(raw: unknown, options: MapPtvItemOptions = {}): PtvItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { Items?: unknown[] }).Items;
  if (!Array.isArray(list)) return [];

  const result: PtvItem[] = [];
  for (const item of list) {
    try {
      const mapped = mapPtvItem(item);
      if (!options.includeUnsupportedTypes && mapped.type === 'Unknown') continue;
      result.push(mapped);
    } catch {
      // skip malformed entry and continue with the remaining list items
    }
  }
  return result;
}

export function mapErrorToPtvError(error: unknown): PtvError {
  if (error && typeof error === 'object' && 'kind' in error) {
    return error as PtvError;
  }
  return toPtvError(String(error ?? 'Unknown server response'), 'unknown');
}

export function isMovieItem(item: PtvItem): item is PtvItem & { type: 'Movie' } {
  return item.type === 'Movie';
}

export function isSeriesItem(item: PtvItem): item is PtvItem & { type: 'Series' } {
  return item.type === 'Series';
}

export function isSeasonItem(item: PtvItem): item is PtvItem & { type: 'Season' } {
  return item.type === 'Season';
}

export function isEpisodeItem(item: PtvItem): item is PtvItem & { type: 'Episode' } {
  return item.type === 'Episode';
}

export function isMusicAlbumItem(item: PtvItem): item is PtvItem & { type: 'MusicAlbum' } {
  return item.type === 'MusicAlbum';
}

export function isMusicArtistItem(item: PtvItem): item is PtvItem & { type: 'MusicArtist' } {
  return item.type === 'MusicArtist';
}

export function isAudioTrackItem(item: PtvItem): item is PtvItem & { type: 'Audio' } {
  return item.type === 'Audio';
}

export function isMusicVideoItem(item: PtvItem): item is PtvItem & { type: 'MusicVideo' } {
  return item.type === 'MusicVideo';
}

export function isBookItem(item: PtvItem): item is PtvItem & { type: 'Book' } {
  return item.type === 'Book';
}

export function isPhotoOrUnsupportedItem(item: PtvItem): boolean {
  return item.type === 'PhotoAlbum'
    || item.type === 'Unknown'
    || item.type === 'Person'
    || item.type === 'Playlist'
    || item.type === 'Game'
    || item.type === 'Channel';
}

export function isUnsupportedDetailItem(item: PtvItem): boolean {
  return item.type === 'Unknown' || isPhotoOrUnsupportedItem(item) || isFolderOrCollectionItem(item);
}

export function canNavigateToDetails(item: PtvItem) {
  return DETAIL_NAVIGABLE_TYPES.includes(item.type) && !isPhotoOrUnsupportedItem(item) && !isFolderOrCollectionItem(item);
}

export function isFolderOrCollectionItem(item: PtvItem): boolean {
  return item.type === 'Folder' || item.type === 'Collection';
}

export function shouldShowInDetails(item: PtvItem): boolean {
  return canNavigateToDetails(item);
}
