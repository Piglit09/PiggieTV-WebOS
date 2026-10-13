import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute, playbackRouteFromIntent, toRouteString } from '../../navigation/router';
import { canNavigateToDetails, isAudioTrackItem, mapPtvItem, mapPtvItems } from '../../api/jellyfin/mappers';
import type { PtvItem, PtvPlaybackIntent } from '../../types/ptv';
import { FocusableButton } from '../../components/FocusableButton';
import { CardTile } from '../../components/CardTile';
import { toHms } from '../../utils/format';
import { artworkUrlForItem } from '../../utils/artwork';
import { redactSensitiveText } from '../../core/redaction';
import {
  pickDefaultAudioTrackIndex,
  pickDefaultSubtitleTrackIndex,
  type PlaybackTrackOption
} from '../../playback/tracks';
import { cycleSubtitleIndex, cycleTrackIndex, presentDetailMedia } from './detailsMedia';
import { rankMusicMixTracks, rankRelatedCandidates } from '../../recommendations/ranker';
import { MUSIC_RECOMMENDATION_POLICY_VERSION } from '../../recommendations/policy';
import {
  createMediaCacheSessionKey,
  readMediaMetadata,
  readSelectedSeriesSeason,
  readSeriesEpisodes,
  readSeriesSeasons,
  writeMediaMetadata,
  writeSelectedSeriesSeason,
  writeSeriesEpisodes,
  writeSeriesSeasons
} from '../../state/mediaCache';

const DETAIL_FIELDS = [
  'Overview',
  'ImageTags',
  'BackdropImageTags',
  'RunTimeTicks',
  'ProductionYear',
  'PremiereDate',
  'EndDate',
  'Status',
  'MediaType',
  'OfficialRating',
  'CommunityRating',
  'Genres',
  'ChildCount',
  'RecursiveItemCount',
  'UserData',
  'SeriesName',
  'SeriesId',
  'SeasonName',
  'SeasonId',
  'ParentId',
  'IndexNumber',
  'ParentIndexNumber',
  'Artists',
  'Album',
  'AlbumArtist',
  'AlbumId',
  'TrackCount',
  'Container',
  'Codec',
  'MediaSources'
];
const EPISODE_PAGE_SIZE = 8;
const RELATED_VISIBLE_CARDS = 8;
const RELATED_CARD_STEP = 206;
const GENERIC_RELATED_VISIBLE_CARDS = 4;
const GENERIC_RELATED_CARD_STEP = 428;
const EPISODE_DETAIL_VISIBLE_CARDS = 5;
const EPISODE_DETAIL_CARD_STEP = 322;
const RELATED_CANDIDATE_LIMIT = 48;
const RELATED_RESULT_LIMIT = 16;
const MUSIC_MIX_CANDIDATE_LIMIT = 64;
const MUSIC_MIX_LIMIT = 24;
const MILLIS_PER_DAY = 86_400_000;
const DETAILS_FOCUS_TOP_GUTTER = 48;
const DETAILS_FOCUS_BOTTOM_GUTTER = 96;
const RELATED_FIELDS = [
  'ImageTags',
  'BackdropImageTags',
  'ProductionYear',
  'RunTimeTicks',
  'OfficialRating',
  'CommunityRating',
  'Genres',
  'ChildCount',
  'RecursiveItemCount',
  'UserData',
  'MediaType',
  'SeriesName',
  'SeriesId',
  'ParentId',
  'IndexNumber',
  'ParentIndexNumber',
  'Artists',
  'Album',
  'AlbumArtist',
  'AlbumId'
];
const MUSIC_CHILD_FILTER_FIELDS = [
  'ImageTags',
  'BackdropImageTags',
  'RunTimeTicks',
  'ProductionYear',
  'Overview',
  'IndexNumber',
  'ParentIndexNumber',
  'Artists',
  'Album',
  'AlbumArtist',
  'AlbumId',
  'TrackCount',
  'UserData',
  'MediaType',
  'Genres',
  'MediaSources',
  'Container',
  'Codec'
];

function cleanOverview(value?: string) {
  return value?.replace(/<br\s*\/?\s*>/gi, ' ').replace(/\s+/g, ' ').trim() ?? '';
}

function episodeLabel(item: PtvItem) {
  if (item.parentIndexNumber && item.indexNumber) return `S${item.parentIndexNumber} E${item.indexNumber}`;
  if (item.indexNumber) return `Episode ${item.indexNumber}`;
  return item.seasonName ?? null;
}

function itemProgress(item: PtvItem) {
  if (!item.playbackPositionTicks || !item.runTimeTicks || item.runTimeTicks <= 0) return null;
  return Math.max(0, Math.min(100, (item.playbackPositionTicks / item.runTimeTicks) * 100));
}

function mediaTypeLabel(item: PtvItem) {
  if (item.type === 'Episode') return 'Episode';
  if (item.type === 'Series') return 'Series';
  if (item.type === 'Movie') return 'Movie';
  if (item.type === 'Unknown' && item.mediaType?.toLowerCase() === 'audio') return 'Song';
  if (item.type === 'Audio') return 'Song';
  if (item.type === 'MusicAlbum') return 'Music Album';
  if (item.type === 'MusicArtist') return 'Artist';
  if (item.type === 'MusicVideo') return 'Music Video';
  if (item.type === 'Playlist') return 'Playlist';
  if (item.type === 'Book') return 'Book';
  if (item.type === 'Season') return 'Season';
  return item.type;
}

function isPlayable(item: PtvItem) {
  return item.type === 'Movie'
    || item.type === 'Episode'
    || item.type === 'Audio'
    || item.type === 'MusicVideo'
    || item.type === 'Book';
}

function playbackKind(item: PtvItem): PtvPlaybackIntent['kind'] {
  if (item.type === 'Episode') return 'episode';
  if (item.type === 'Audio' || item.type === 'MusicVideo') return 'audio';
  if (item.type === 'Book') return 'book';
  return 'movie';
}

function buildAudioQueueTracks(item: PtvItem | null, tracks: PtvItem[]) {
  if (!tracks.length) return [];
  const source = item?.type === 'MusicAlbum' ? item : null;
  return tracks.map(track => ({
    itemId: track.id,
    title: track.name,
    startPositionTicks: track.playbackPositionTicks,
    context: track.trackNumber ? `Track ${track.trackNumber}` : undefined,
    artist: track.artists?.[0] ?? track.albumArtist ?? source?.artists?.[0],
    album: source?.type === 'MusicAlbum' ? source.name : track.album,
    albumId: source?.type === 'MusicAlbum' ? source.id : track.albumId,
    artworkUrl: undefined
  }));
}

function indexFromTrack(itemId: string, tracks: PtvItem[]) {
  const found = tracks.findIndex(track => track.id === itemId);
  return found >= 0 ? found : 0;
}

function buildEpisodeQueue(series: PtvItem | null, episodes: PtvItem[]) {
  return episodes.map(episode => ({
    itemId: episode.id,
    title: episode.name,
    seriesId: episode.seriesId ?? (series?.type === 'Series' ? series.id : undefined),
    startPositionTicks: episode.playbackPositionTicks,
    context: [episode.seriesName ?? series?.name, episodeLabel(episode)].filter(Boolean).join(' · ')
  }));
}

function shuffledItems<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index] as T;
    shuffled[index] = shuffled[swapIndex] as T;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function episodeSeasonName(item: PtvItem) {
  if (item.seasonName?.trim()) return item.seasonName.trim();
  if (item.parentIndexNumber) return `Season ${item.parentIndexNumber}`;
  return 'this season';
}

function compactRuntime(ticks?: number) {
  if (!ticks || ticks <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(ticks / 600_000_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function supportsPremiumMix(item: PtvItem | null): item is PtvItem & {
  type: 'Audio' | 'MusicAlbum' | 'MusicArtist';
} {
  return item?.type === 'Audio' || item?.type === 'MusicAlbum' || item?.type === 'MusicArtist';
}

function dailyMixSeed(serverId: string, userId: string, itemId: string, now = Date.now()) {
  return `${serverId}:${userId}:${itemId}:${Math.floor(now / MILLIS_PER_DAY)}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.25v13.5L18.5 12 8 5.25Z" fill="currentColor" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5.35 8.7A7.75 7.75 0 1 1 4.6 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M4.75 4.75V9.3H9.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SeriesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M7.25 8.25h9.5M7.25 12h9.5M7.25 15.75h6.25" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function RatingStarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m12 2.8 2.72 5.51 6.08.88-4.4 4.29 1.04 6.06L12 16.68l-5.44 2.86 1.04-6.06-4.4-4.29 6.08-.88L12 2.8Z" fill="currentColor" />
    </svg>
  );
}

function AudioPresetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z" fill="currentColor" />
    </svg>
  );
}

function SubtitlePresetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 5.5h16A2.5 2.5 0 0 1 22.5 8v8A2.5 2.5 0 0 1 20 18.5H4A2.5 2.5 0 0 1 1.5 16V8A2.5 2.5 0 0 1 4 5.5Zm1.5 5v1.8h5v-1.8h-5Zm0 3.2v1.8h7v-1.8h-7Zm9-3.2v1.8h4v-1.8h-4Zm0 3.2v1.8h4v-1.8h-4Z" fill="currentColor" />
    </svg>
  );
}

function selectedTrack(options: PlaybackTrackOption[], index: number | null) {
  return options.find(option => option.index === index) ?? null;
}

function revealFocusedDetailsControl(viewport: HTMLDivElement | null, target: HTMLElement) {
  if (!viewport || !viewport.contains(target)) return;

  const viewportBounds = viewport.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const safeTop = viewportBounds.top + DETAILS_FOCUS_TOP_GUTTER;
  const safeBottom = viewportBounds.bottom - DETAILS_FOCUS_BOTTOM_GUTTER;
  let nextScrollTop = viewport.scrollTop;

  if (targetBounds.top < safeTop) {
    nextScrollTop -= safeTop - targetBounds.top;
  } else if (targetBounds.bottom > safeBottom) {
    nextScrollTop += targetBounds.bottom - safeBottom;
  }

  viewport.scrollTop = Math.max(0, Math.min(maximumScrollTop, nextScrollTop));
}

export function DetailsScreen() {
  const { state, dispatch, services } = useApp();
  const itemId = state.route.itemId;
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const cachedItem = itemId ? readMediaMetadata(cacheKey, itemId) : undefined;
  const [item, setItem] = useState<PtvItem | null>(cachedItem ?? null);
  const [loading, setLoading] = useState(!cachedItem);
  const [error, setError] = useState<string | null>(null);
  const [detailsRetryNonce, setDetailsRetryNonce] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [seasons, setSeasons] = useState<PtvItem[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);
  const [seasonsRetryNonce, setSeasonsRetryNonce] = useState(0);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<PtvItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [episodesRetryNonce, setEpisodesRetryNonce] = useState(0);
  const [episodeStart, setEpisodeStart] = useState(0);
  const [episodePage, setEpisodePage] = useState(0);
  const [seriesQueueLoading, setSeriesQueueLoading] = useState(false);
  const [seriesQueueError, setSeriesQueueError] = useState<string | null>(null);
  const [episodeSeries, setEpisodeSeries] = useState<PtvItem | null>(null);
  const [sameSeasonEpisodes, setSameSeasonEpisodes] = useState<PtvItem[]>([]);
  const [sameSeasonLoading, setSameSeasonLoading] = useState(false);
  const [sameSeasonError, setSameSeasonError] = useState<string | null>(null);
  const [sameSeasonRetryNonce, setSameSeasonRetryNonce] = useState(0);
  const [sameSeasonStart, setSameSeasonStart] = useState(0);
  const [albumTracks, setAlbumTracks] = useState<PtvItem[]>([]);
  const [albumTracksLoading, setAlbumTracksLoading] = useState(false);
  const [albumTracksError, setAlbumTracksError] = useState<string | null>(null);
  const [relatedItems, setRelatedItems] = useState<PtvItem[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [relatedRetryNonce, setRelatedRetryNonce] = useState(0);
  const [relatedStart, setRelatedStart] = useState(0);
  const [relatedActive, setRelatedActive] = useState(false);
  const [mixLoading, setMixLoading] = useState(false);
  const [mixError, setMixError] = useState<string | null>(null);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | null>(null);
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] = useState<number | null>(null);
  const detailsContentRef = useRef<HTMLDivElement>(null);
  const seasonSelectorRef = useRef<HTMLDivElement>(null);
  const pendingEpisodeFocus = useRef(false);
  const mixRequestRef = useRef<AbortController | null>(null);
  const seriesQueueRequestRef = useRef<AbortController | null>(null);
  const preservedRelatedItemsByRoute = useRef<Map<string, PtvItem[]>>(new Map());
  const pendingRelatedFocusByRoute = useRef<Map<string, string>>(new Map());
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);
  const detailMedia = useMemo(() => presentDetailMedia(item), [item]);
  const activeEpisode = item?.type === 'Episode' && item.id === itemId ? item : null;
  const activeEpisodeId = activeEpisode?.id ?? null;
  const activeEpisodeSeriesId = activeEpisode?.seriesId ?? null;
  const activeEpisodeSeasonId = activeEpisode?.seasonId ?? activeEpisode?.parentId ?? null;

  useEffect(() => () => {
    seriesQueueRequestRef.current?.abort('series-details-unmounted');
    seriesQueueRequestRef.current = null;
  }, []);

  useEffect(() => {
    if (!itemId || !client || !userSession || !cacheKey) return;
    const controller = new AbortController();
    const cached = readMediaMetadata(cacheKey, itemId);
    setItem(cached ?? null);
    setLoading(!cached);
    setError(null);
    setAlbumTracks([]);
    setAlbumTracksLoading(false);
    setAlbumTracksError(null);
    setRelatedActive(false);
    setRelatedStart(0);
    seriesQueueRequestRef.current?.abort('series-route-changed');
    seriesQueueRequestRef.current = null;
    setSeriesQueueLoading(false);
    setSeriesQueueError(null);
    setEpisodeSeries(null);
    setSameSeasonEpisodes([]);
    setSameSeasonLoading(false);
    setSameSeasonError(null);
    setSameSeasonRetryNonce(0);
    setSameSeasonStart(0);
    setPosterFailed(false);
    setBackdropFailed(false);
    setLogoFailed(false);
    if (detailsContentRef.current) detailsContentRef.current.scrollTop = 0;
    if (seasonSelectorRef.current) seasonSelectorRef.current.scrollLeft = 0;

    void client.getItem(userSession.userId, itemId, DETAIL_FIELDS, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItem(response);
        setItem(mapped);
        writeMediaMetadata(cacheKey, mapped);
        setLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(redactSensitiveText(cause instanceof Error ? cause.message : 'Details are unavailable.'));
      });

    return () => controller.abort('details-route-hidden');
  }, [cacheKey, client, detailsRetryNonce, itemId, userSession]);

  useEffect(() => {
    if (!activeEpisodeId || !activeEpisodeSeriesId || !client || !userSession || !cacheKey) {
      setEpisodeSeries(null);
      return undefined;
    }

    const cachedSeries = readMediaMetadata(cacheKey, activeEpisodeSeriesId);
    setEpisodeSeries(cachedSeries?.type === 'Series' ? cachedSeries : null);
    if (cachedSeries?.type === 'Series') return undefined;

    const controller = new AbortController();
    void client.getItem(userSession.userId, activeEpisodeSeriesId, DETAIL_FIELDS, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItem(response);
        if (mapped.type !== 'Series') return;
        setEpisodeSeries(mapped);
        writeMediaMetadata(cacheKey, mapped);
      })
      .catch(() => {
        // The episode remains fully usable when optional series artwork is unavailable.
      });

    return () => controller.abort('episode-series-hidden');
  }, [activeEpisodeId, activeEpisodeSeriesId, cacheKey, client, userSession]);

  useEffect(() => {
    if (!activeEpisodeId || !activeEpisodeSeriesId || !activeEpisodeSeasonId || !client || !userSession || !cacheKey) {
      setSameSeasonEpisodes([]);
      setSameSeasonLoading(false);
      setSameSeasonError(null);
      return undefined;
    }

    const cached = readSeriesEpisodes(cacheKey, activeEpisodeSeriesId);
    if (cached?.seasonId === activeEpisodeSeasonId && sameSeasonRetryNonce === 0) {
      setSameSeasonEpisodes(cached.items);
      setSameSeasonLoading(false);
      setSameSeasonError(null);
      return undefined;
    }

    const controller = new AbortController();
    setSameSeasonEpisodes([]);
    setSameSeasonStart(0);
    setSameSeasonLoading(true);
    setSameSeasonError(null);
    void client.getEpisodes(userSession.userId, activeEpisodeSeriesId, activeEpisodeSeasonId, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response).filter(episode => episode.type === 'Episode');
        setSameSeasonEpisodes(mapped);
        if (mapped.length > 0) {
          writeSeriesEpisodes(cacheKey, activeEpisodeSeriesId, activeEpisodeSeasonId, mapped);
        }
        setSameSeasonLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setSameSeasonLoading(false);
        setSameSeasonError(redactSensitiveText(cause instanceof Error ? cause.message : 'Episodes from this season could not be loaded.'));
      });

    return () => controller.abort('episode-season-hidden');
  }, [
    activeEpisodeId,
    activeEpisodeSeasonId,
    activeEpisodeSeriesId,
    cacheKey,
    client,
    sameSeasonRetryNonce,
    userSession
  ]);

  useEffect(() => {
    setSelectedAudioStreamIndex(pickDefaultAudioTrackIndex(detailMedia.audioTracks, undefined));
    setSelectedSubtitleStreamIndex(pickDefaultSubtitleTrackIndex(
      detailMedia.subtitleTracks,
      undefined,
      state.settings.subtitleDefaultOff
    ));
  }, [detailMedia.audioTracks, detailMedia.subtitleTracks, state.settings.subtitleDefaultOff]);

  useEffect(() => {
    mixRequestRef.current?.abort('music-mix-seed-changed');
    mixRequestRef.current = null;
    setMixLoading(false);
    setMixError(null);
    return () => {
      mixRequestRef.current?.abort('music-mix-route-hidden');
      mixRequestRef.current = null;
    };
  }, [itemId]);

  useEffect(() => {
    if (item && itemId && item.id !== itemId) return undefined;
    if (!item || !client || !userSession || !canNavigateToDetails(item)) {
      setRelatedItems([]);
      setRelatedLoading(false);
      setRelatedError(null);
      return undefined;
    }

    const routeId = toRouteString(state.route);
    const preservedItems = preservedRelatedItemsByRoute.current.get(routeId);
    if (preservedItems) {
      setRelatedItems(preservedItems);
      setRelatedLoading(false);
      setRelatedError(null);
      return undefined;
    }

    const controller = new AbortController();
    const recommendationStartedAt = Date.now();
    setRelatedItems([]);
    setRelatedLoading(true);
    setRelatedError(null);
    void client.getSimilarItems(userSession.userId, item.id, {
      limit: RELATED_CANDIDATE_LIMIT,
      fields: RELATED_FIELDS
    }, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response, { excludeEmptyVideoContainers: true }).filter(canNavigateToDetails);
        const ranked = rankRelatedCandidates(item, mapped, {
          limit: RELATED_RESULT_LIMIT,
          maxConsecutiveAlbum: 2,
          maxConsecutiveArtist: 2,
          maxItemsPerAlbum: 2,
          maxItemsPerArtist: 3,
          sessionSeed: `${userSession.serverId}:${userSession.userId}:${item.id}`
        });
        setRelatedItems(ranked);
        services.diagnostics.recordLifecycleEvent({
          type: 'recommendation-generated',
          surface: 'related',
          policyVersion: MUSIC_RECOMMENDATION_POLICY_VERSION,
          candidateCount: mapped.length,
          itemCount: ranked.length,
          generationLatencyMs: Math.max(0, Date.now() - recommendationStartedAt)
        });
        setRelatedLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        services.diagnostics.recordLifecycleEvent({
          type: 'recommendation-fallback',
          surface: 'related',
          policyVersion: MUSIC_RECOMMENDATION_POLICY_VERSION,
          fallbackReason: 'candidate-request-failed',
          generationLatencyMs: Math.max(0, Date.now() - recommendationStartedAt)
        });
        setRelatedItems([]);
        setRelatedLoading(false);
        setRelatedError(redactSensitiveText(cause instanceof Error ? cause.message : 'Related titles could not be loaded.'));
      });

    return () => controller.abort('related-items-hidden');
  }, [client, item, itemId, relatedRetryNonce, services.diagnostics, state.route, userSession]);

  useEffect(() => {
    if (!item || item.type !== 'MusicAlbum' || !client || !userSession || !cacheKey) {
      setAlbumTracks([]);
      setAlbumTracksLoading(false);
      setAlbumTracksError(null);
      return;
    }

    const controller = new AbortController();
    setAlbumTracksLoading(true);
    setAlbumTracksError(null);
    void client.getItems(userSession.userId, {
      IncludeItemTypes: 'Audio',
      ParentId: item.id,
      Recursive: true,
      SortBy: 'IndexNumber',
      SortOrder: 'Ascending',
      Fields: MUSIC_CHILD_FILTER_FIELDS.join(','),
      EnableUserData: true
    }, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response).filter(isAudioTrackItem);
        setAlbumTracks(mapped);
        setAlbumTracksLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setAlbumTracksLoading(false);
        setAlbumTracksError(redactSensitiveText(cause instanceof Error ? cause.message : 'Tracks could not be loaded.'));
      });

    return () => controller.abort('music-album-tracks-hidden');
  }, [cacheKey, client, item, userSession]);

  useEffect(() => {
    if (!item || item.type !== 'Series' || !client || !userSession || !cacheKey) {
      setSeasons([]);
      setSelectedSeasonId(null);
      setEpisodes([]);
      return;
    }

    const cachedSeasons = readSeriesSeasons(cacheKey, item.id);
    const rememberedSeason = readSelectedSeriesSeason(cacheKey, item.id);
    if (cachedSeasons && seasonsRetryNonce === 0) {
      setSeasons(cachedSeasons);
      const selected = rememberedSeason && cachedSeasons.some(season => season.id === rememberedSeason)
        ? rememberedSeason
        : cachedSeasons[0]?.id ?? null;
      setSelectedSeasonId(selected);
      setSeasonsLoading(false);
      setSeasonsError(null);
      return;
    }

    const controller = new AbortController();
    setSeasonsLoading(true);
    setSeasonsError(null);
    void client.getSeasons(userSession.userId, item.id, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response, { excludeEmptyVideoContainers: true })
          .filter(season => season.type === 'Season');
        setSeasons(mapped);
        if (mapped.length > 0) writeSeriesSeasons(cacheKey, item.id, mapped);
        const selected = rememberedSeason && mapped.some(season => season.id === rememberedSeason)
          ? rememberedSeason
          : mapped[0]?.id ?? null;
        setSelectedSeasonId(selected);
        if (selected) writeSelectedSeriesSeason(cacheKey, item.id, selected);
        setSeasonsLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setSeasonsLoading(false);
        setSeasonsError(redactSensitiveText(cause instanceof Error ? cause.message : 'Seasons could not be loaded.'));
      });
    return () => controller.abort('series-seasons-hidden');
  }, [cacheKey, client, item, seasonsRetryNonce, userSession]);

  useEffect(() => {
    if (!item || item.type !== 'Series' || !selectedSeasonId || !client || !userSession || !cacheKey) {
      if (!selectedSeasonId) setEpisodes([]);
      return;
    }

    const cached = readSeriesEpisodes(cacheKey, item.id);
    if (cached?.seasonId === selectedSeasonId && episodesRetryNonce === 0) {
      setEpisodes(cached.items);
      setEpisodesLoading(false);
      setEpisodesError(null);
      return;
    }

    const controller = new AbortController();
    setEpisodes([]);
    setEpisodeStart(0);
    setEpisodePage(0);
    setEpisodesLoading(true);
    setEpisodesError(null);
    void client.getEpisodes(userSession.userId, item.id, selectedSeasonId, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response).filter(episode => episode.type === 'Episode');
        setEpisodes(mapped);
        if (mapped.length > 0) writeSeriesEpisodes(cacheKey, item.id, selectedSeasonId, mapped);
        setEpisodesLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setEpisodesLoading(false);
        setEpisodesError(redactSensitiveText(cause instanceof Error ? cause.message : 'Episodes could not be loaded.'));
      });
    return () => controller.abort('series-episodes-hidden');
  }, [cacheKey, client, episodesRetryNonce, item, selectedSeasonId, userSession]);

  useEffect(() => {
    if (!episodes.length) return;
    const routeId = toRouteString(state.route);
    if (pendingEpisodeFocus.current) {
      pendingEpisodeFocus.current = false;
      const firstOnPage = episodes[episodePage * EPISODE_PAGE_SIZE];
      if (!firstOnPage) return;
      window.requestAnimationFrame(() => {
        services.focusManager.focus(`details-episode-${firstOnPage.id}`, {
          routeId,
          reason: 'direct'
        });
      });
      return;
    }

    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered?.startsWith('details-episode-')) return;
    const rememberedId = remembered.slice('details-episode-'.length);
    const rememberedIndex = episodes.findIndex(episode => episode.id === rememberedId);
    if (rememberedIndex < 0) return;
    const rememberedPage = Math.floor(rememberedIndex / EPISODE_PAGE_SIZE);
    if (rememberedPage !== episodePage) {
      setEpisodePage(rememberedPage);
      setEpisodeStart(Math.max(0, (rememberedIndex % EPISODE_PAGE_SIZE) - 3));
      return;
    }
    services.focusManager.restoreRouteFocus(routeId);
  }, [episodePage, episodes, services.focusManager, state.route]);

  useEffect(() => {
    if (item?.type !== 'Series' || seasons.length === 0) return undefined;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered?.startsWith('details-') || remembered.startsWith('details-episode-')) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const currentRemembered = services.focusManager.getRememberedRouteFocus(routeId);
      if (!currentRemembered?.startsWith('details-') || currentRemembered.startsWith('details-episode-')) return;
      services.focusManager.restoreRouteFocus(routeId, 'details-primary');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item, seasons, services.focusManager, state.route]);

  useEffect(() => {
    if (!item || item.id !== state.route.itemId || !canNavigateToDetails(item) || relatedItems.length === 0) return undefined;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    const pendingFocusId = pendingRelatedFocusByRoute.current.get(routeId);
    const focusId = pendingFocusId ?? remembered;
    if (!focusId?.startsWith('details-related-')) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const restored = pendingFocusId
        ? services.focusManager.focus(focusId, { routeId, reason: 'route-restore' })
        : services.focusManager.restoreRouteFocus(routeId, 'details-primary');
      if (!restored.current?.startsWith('details-related-')) return;
      pendingRelatedFocusByRoute.current.delete(routeId);
      setRelatedActive(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item, relatedItems, services.focusManager, state.route]);

  useEffect(() => {
    if (item?.type !== 'Series' && item?.type !== 'Episode') return undefined;
    const frame = window.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) return;
      revealFocusedDetailsControl(detailsContentRef.current, focused);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [episodePage, episodes.length, item?.id, item?.type, relatedItems.length, sameSeasonEpisodes.length, seasons.length]);

  const startPlayback = (
    playable: PtvItem,
    restart = false,
    queueTracks: PtvItem[] = [],
    queueSource: PtvItem | null = item
  ) => {
    if (!isPlayable(playable) || !state.userSession || !state.serverSession) return;
    const kind = playbackKind(playable);
    const hasAudioQueue = kind === 'audio' && queueTracks.length > 0;
    const hasEpisodeQueue = kind === 'episode' && queueTracks.length > 0;
    const hasQueue = hasAudioQueue || hasEpisodeQueue;
    const useSelectedStreams = item?.id === playable.id && item.type === 'Movie';
    const queueItems = hasAudioQueue
      ? buildAudioQueueTracks(queueSource, queueTracks)
      : hasEpisodeQueue
        ? buildEpisodeQueue(queueSource, queueTracks)
        : [];
    const queueIndex = hasQueue ? indexFromTrack(playable.id, queueTracks) : 0;
    const intent: PtvPlaybackIntent = {
      kind,
      itemId: playable.id,
      seriesId: playable.type === 'Episode'
        ? playable.seriesId ?? (item?.type === 'Series' ? item.id : undefined)
        : undefined,
      serverId: state.userSession.serverId,
      userId: state.userSession.userId,
      title: playable.name,
      context: playable.type === 'Episode'
        ? [playable.seriesName, episodeLabel(playable)].filter(Boolean).join(' · ')
        : undefined,
      artist: playable.artists?.[0] ?? playable.albumArtist ?? item?.artists?.[0],
      album: playable.album ?? (item?.type === 'MusicAlbum' ? item.name : undefined),
      albumId: playable.albumId ?? (item?.type === 'MusicAlbum' ? item.id : undefined),
      logoUrl: client
        ? (
          playable.type === 'Episode' && item?.type === 'Series'
            ? artworkUrlForItem(client, item, 'logo')
            : artworkUrlForItem(client, playable, 'logo')
        ) ?? undefined
        : undefined,
      artworkUrl: client
        ? (
          playable.type === 'Episode' && item?.type === 'Series'
            ? artworkUrlForItem(client, item, 'landscape')
            : artworkUrlForItem(client, playable, 'landscape')
        ) ?? undefined
        : undefined,
      startPositionTicks: restart ? 0 : playable.playbackPositionTicks,
      audioStreamIndex: useSelectedStreams ? selectedAudioStreamIndex : undefined,
      subtitleStreamIndex: useSelectedStreams ? selectedSubtitleStreamIndex : undefined,
      queue: hasQueue
        ? {
          items: queueItems.map((queueItem, queueIndexFromTrack) => ({
            ...queueItem,
            artworkUrl:
              queueTracks[queueIndexFromTrack] && client
                ? artworkUrlForItem(client, queueTracks[queueIndexFromTrack], 'landscape') ?? undefined
                : undefined
          })),
          index: queueIndex
        }
        : undefined
    };
    dispatch({ type: 'set_playback_intent', playbackIntent: intent });
    if (intent.kind !== 'audio') {
      dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent) });
    }
  };
  const startAlbumPlayback = () => {
    if (!item || item.type !== 'MusicAlbum' || !state.userSession || !state.serverSession) return;
    if (albumTracksLoading) return;
    const firstTrack = albumTracks[0];
    if (!firstTrack) return;
    startPlayback(firstTrack, false, albumTracks);
  };

  const startSeriesPlayback = (shuffle: boolean) => {
    if (!item || item.type !== 'Series' || !client || !userSession || seriesQueueLoading) return;
    seriesQueueRequestRef.current?.abort('series-queue-replaced');
    const controller = new AbortController();
    seriesQueueRequestRef.current = controller;
    setSeriesQueueLoading(true);
    setSeriesQueueError(null);

    void client.getSeriesEpisodes(userSession.userId, item.id, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const availableEpisodes = mapPtvItems(response).filter(episode => episode.type === 'Episode');
        const queue = shuffle ? shuffledItems(availableEpisodes) : availableEpisodes;
        const firstEpisode = queue[0];
        if (!firstEpisode) {
          setSeriesQueueError('No playable episodes are available for this series.');
          return;
        }
        startPlayback(firstEpisode, false, queue, item);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setSeriesQueueError(redactSensitiveText(
          cause instanceof Error ? cause.message : 'Series episodes could not be loaded.'
        ));
      })
      .finally(() => {
        if (seriesQueueRequestRef.current === controller) {
          seriesQueueRequestRef.current = null;
        }
        if (!controller.signal.aborted) setSeriesQueueLoading(false);
      });
  };

  const startPremiumMix = () => {
    if (!supportsPremiumMix(item) || !client || !userSession || !state.serverSession) return;
    const mixSeed = item;
    const controller = new AbortController();
    const recommendationStartedAt = Date.now();
    mixRequestRef.current?.abort('music-mix-replaced');
    mixRequestRef.current = controller;
    setMixLoading(true);
    setMixError(null);

    void client.getInstantMix(userSession.userId, mixSeed.id, {
      limit: MUSIC_MIX_CANDIDATE_LIMIT,
      fields: MUSIC_CHILD_FILTER_FIELDS
    }, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const ranked = rankMusicMixTracks(
          mixSeed,
          mapPtvItems(response).filter(isAudioTrackItem),
          {
            limit: MUSIC_MIX_LIMIT,
            sessionSeed: dailyMixSeed(
              userSession.serverId,
              userSession.userId,
              mixSeed.id
            ),
            excludePlayed: false,
            includeSeedFirst: mixSeed.type === 'Audio',
            maxTracksPerArtist: 3,
            maxTracksPerAlbum: 2,
            surface: 'radio'
          }
        );
        if (ranked.length === 0 || (mixSeed.type === 'Audio' && ranked.length === 1)) {
          services.diagnostics.recordLifecycleEvent({
            type: 'recommendation-fallback',
            surface: 'radio',
            policyVersion: MUSIC_RECOMMENDATION_POLICY_VERSION,
            candidateCount: response.Items.length,
            itemCount: ranked.length,
            fallbackReason: 'insufficient-seed-affinity',
            generationLatencyMs: Math.max(0, Date.now() - recommendationStartedAt)
          });
          setMixError('No closely related tracks are available for this mix yet.');
          return;
        }
        const queueTracks = ranked.slice(0, MUSIC_MIX_LIMIT);
        const firstTrack = queueTracks[0];
        if (!firstTrack) return;
        services.diagnostics.recordLifecycleEvent({
          type: 'recommendation-generated',
          surface: 'radio',
          policyVersion: MUSIC_RECOMMENDATION_POLICY_VERSION,
          candidateCount: response.Items.length,
          itemCount: queueTracks.length,
          generationLatencyMs: Math.max(0, Date.now() - recommendationStartedAt)
        });
        startPlayback(firstTrack, false, queueTracks, null);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        services.diagnostics.recordLifecycleEvent({
          type: 'recommendation-fallback',
          surface: 'radio',
          policyVersion: MUSIC_RECOMMENDATION_POLICY_VERSION,
          fallbackReason: 'candidate-request-failed',
          generationLatencyMs: Math.max(0, Date.now() - recommendationStartedAt)
        });
        setMixError(redactSensitiveText(cause instanceof Error ? cause.message : 'This mix could not be created.'));
      })
      .finally(() => {
        if (mixRequestRef.current !== controller) return;
        mixRequestRef.current = null;
        setMixLoading(false);
      });
  };

  const returnToHero = () => setRelatedActive(false);

  const cycleAudioPreset = () => {
    setSelectedAudioStreamIndex(current => cycleTrackIndex(detailMedia.audioTracks, current));
  };

  const cycleSubtitlePreset = () => {
    setSelectedSubtitleStreamIndex(current => cycleSubtitleIndex(detailMedia.subtitleTracks, current));
  };

  const revealRelated = (index: number) => {
    setRelatedActive(true);
    const visibleCards = item?.type === 'Movie'
      ? RELATED_VISIBLE_CARDS
      : item?.type === 'Episode'
        ? EPISODE_DETAIL_VISIBLE_CARDS
        : GENERIC_RELATED_VISIBLE_CARDS;
    setRelatedStart(current => {
      if (index < current) return index;
      if (index >= current + visibleCards) return index - visibleCards + 1;
      return current;
    });
  };

  const openRelated = (related: PtvItem) => {
    const routeId = toRouteString(state.route);
    preservedRelatedItemsByRoute.current.set(routeId, relatedItems);
    pendingRelatedFocusByRoute.current.set(routeId, `details-related-${related.id}`);
    if (cacheKey) writeMediaMetadata(cacheKey, related);
    dispatch({ type: 'set_route', route: buildRoute('details', related.id) });
  };

  const openSeriesDetails = () => {
    if (item?.type !== 'Episode' || !item.seriesId) return;
    if (cacheKey && episodeSeries) writeMediaMetadata(cacheKey, episodeSeries);
    dispatch({ type: 'set_route', route: buildRoute('details', item.seriesId) });
  };

  const selectSeason = (season: PtvItem) => {
    if (!item || item.type !== 'Series' || !cacheKey || season.id === selectedSeasonId) return;
    writeSelectedSeriesSeason(cacheKey, item.id, season.id);
    setSelectedSeasonId(season.id);
    setEpisodeStart(0);
    setEpisodePage(0);
    setEpisodesRetryNonce(0);
    pendingEpisodeFocus.current = true;
  };

  const revealSeason = (button: HTMLButtonElement) => {
    const selector = seasonSelectorRef.current;
    if (!selector) return;
    const safeGutter = 12;
    const buttonLeft = button.offsetLeft;
    const buttonRight = buttonLeft + button.offsetWidth;
    const visibleLeft = selector.scrollLeft;
    const visibleRight = visibleLeft + selector.clientWidth;
    if (buttonLeft < visibleLeft + safeGutter) {
      selector.scrollLeft = Math.max(0, buttonLeft - safeGutter);
    } else if (buttonRight > visibleRight - safeGutter) {
      selector.scrollLeft = Math.max(0, buttonRight - selector.clientWidth + safeGutter);
    }
  };

  const revealEpisode = (index: number) => {
    setEpisodeStart(current => {
      if (index < current) return index;
      if (index >= current + 4) return index - 3;
      return current;
    });
  };

  const revealSameSeasonEpisode = (index: number) => {
    setSameSeasonStart(current => {
      if (index < current) return index;
      if (index >= current + EPISODE_DETAIL_VISIBLE_CARDS) {
        return index - EPISODE_DETAIL_VISIBLE_CARDS + 1;
      }
      return current;
    });
  };

  const changeEpisodePage = (nextPage: number) => {
    const pageCount = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
    if (nextPage < 0 || nextPage >= pageCount || nextPage === episodePage) return;
    pendingEpisodeFocus.current = true;
    setEpisodeStart(0);
    setEpisodePage(nextPage);
  };

  const isMovie = item?.type === 'Movie';
  const isEpisode = item?.type === 'Episode';
  const detailImageUrl = artworkUrlForItem(client, item, isEpisode ? 'landscape' : 'poster');
  const backdropUrl = artworkUrlForItem(client, item, 'hero')
    ?? (isEpisode ? artworkUrlForItem(client, episodeSeries, 'hero') : null);
  const logoUrl = isEpisode
    ? artworkUrlForItem(client, episodeSeries, 'logo')
    : artworkUrlForItem(client, item, 'logo');
  const previousScreen = state.routeHistory[state.routeHistory.length - 1]?.screen;
  const useMovieLayout = isMovie || (!item && previousScreen === 'movies');
  const useCinematicActions = isMovie || isEpisode;
  const playbackProgress = isMovie && item ? itemProgress(item) : null;
  const selectedAudioTrack = selectedTrack(detailMedia.audioTracks, selectedAudioStreamIndex);
  const selectedSubtitleTrack = selectedTrack(detailMedia.subtitleTracks, selectedSubtitleStreamIndex);
  const showPlaybackPresets = isMovie && (detailMedia.audioTracks.length > 0 || detailMedia.subtitleTracks.length > 0);
  const meta = item ? [
    item.productionYear,
    item.runTimeTicks ? toHms(item.runTimeTicks) : null,
    item.officialRating,
    item.communityRating ? `★ ${item.communityRating.toFixed(1)}` : null
  ].filter(Boolean) : [];
  const episodePageCount = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
  const visibleEpisodes = episodes.slice(
    episodePage * EPISODE_PAGE_SIZE,
    (episodePage + 1) * EPISODE_PAGE_SIZE
  );
  const visibleSameSeasonEpisodes = sameSeasonEpisodes.filter(episode => episode.id !== item?.id);
  const sameSeasonHeading = item?.type === 'Episode'
    ? `More Episodes from ${episodeSeasonName(item)}`
    : 'More Episodes';
  const relatedCardStep = isEpisode ? EPISODE_DETAIL_CARD_STEP : GENERIC_RELATED_CARD_STEP;

  return (
    <LayoutShell title={item ? `${mediaTypeLabel(item)} details` : 'Details'} onBack={() => dispatch({ type: 'go_back' })}>
      <section className={`ptv-details ${useMovieLayout ? 'ptv-details--movie' : ''} ${isEpisode ? 'ptv-details--episode' : ''} ${item?.type === 'Series' ? 'ptv-details--series' : ''}`.trim()}>
        {backdropUrl && !backdropFailed ? (
          <img
            src={backdropUrl}
            alt=""
            className="ptv-details__backdrop"
            onError={() => setBackdropFailed(true)}
          />
        ) : <div className="ptv-details__backdrop ptv-details__backdrop--fallback" aria-hidden="true" />}
        <div className="ptv-details__scrim" aria-hidden="true" />

        <div
          ref={detailsContentRef}
          className={`ptv-details__content ${relatedActive ? 'is-related-active' : ''}`.trim()}
          onFocusCapture={event => {
            if (item?.type !== 'Series' && item?.type !== 'Episode') return;
            revealFocusedDetailsControl(detailsContentRef.current, event.target as HTMLElement);
          }}
        >
          <div className="ptv-details__summary">
            <div className="ptv-details__poster-wrap">
              {detailImageUrl && !posterFailed ? (
                <img src={detailImageUrl} alt="" className="ptv-details-image" onError={() => setPosterFailed(true)} />
              ) : (
                <div className="ptv-details-image ptv-image-placeholder" aria-hidden="true">
                  <span>PTV</span>
                </div>
              )}
              {isEpisode ? (
                <span className="ptv-details__episode-marker" aria-hidden="true">
                  <PlayIcon />
                </span>
              ) : null}
            </div>
            <div className="ptv-details__copy">
              {isEpisode ? (
                <>
                  {logoUrl && !logoFailed ? (
                    <img
                      src={logoUrl}
                      alt=""
                      className="ptv-details__logo"
                      onError={() => setLogoFailed(true)}
                    />
                  ) : item?.seriesName ? (
                    <span className="ptv-details__series-name">{item.seriesName}</span>
                  ) : null}
                  <span className="ptv-eyebrow ptv-details__episode-label">
                    {[item ? episodeLabel(item) : null, 'Episode'].filter(Boolean).join(' · ')}
                  </span>
                  <h2>{item?.name ?? (loading ? 'Loading…' : 'Unavailable')}</h2>
                </>
              ) : (
                <>
                  {!isMovie ? <span className="ptv-eyebrow">{item ? mediaTypeLabel(item) : 'Media'}</span> : null}
                  {isMovie && logoUrl && !logoFailed ? (
                    <>
                      <img
                        src={logoUrl}
                        alt=""
                        className="ptv-details__logo"
                        onError={() => setLogoFailed(true)}
                      />
                      <h2 className="ptv-visually-hidden">{item?.name}</h2>
                    </>
                  ) : <h2>{item?.name ?? (loading ? 'Loading…' : 'Unavailable')}</h2>}
                </>
              )}
              {error ? <p className="ptv-error">{error}</p> : null}
              {error && !item ? (
                <FocusableButton
                  focusId="details-primary"
                  preferredRow="details-actions"
                  className="ptv-secondary-action"
                  onClick={() => setDetailsRetryNonce(value => value + 1)}
                >
                  Retry details
                </FocusableButton>
              ) : null}
              {item ? (
                isMovie ? (
                  <div className="ptv-details__meta ptv-details__meta--movie">
                    {item.productionYear ? <span>{item.productionYear}</span> : null}
                    {item.runTimeTicks ? <span>{toHms(item.runTimeTicks)}</span> : null}
                    {item.officialRating ? <span>{item.officialRating}</span> : null}
                    {item.communityRating ? (
                      <span className="ptv-details__rating">
                        <RatingStarIcon />
                        <span>{item.communityRating.toFixed(1)}</span>
                      </span>
                    ) : null}
                    {detailMedia.qualityTags.length ? (
                      <ul className="ptv-details__quality" aria-label="Media quality">
                        {detailMedia.qualityTags.map((tag, index) => (
                          <li key={tag} className={index === 0 ? 'is-primary' : ''}>{tag}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : isEpisode ? (
                  <div className="ptv-details__meta ptv-details__meta--episode">
                    {item.productionYear ? <span>{item.productionYear}</span> : null}
                    {compactRuntime(item.runTimeTicks) ? <span>{compactRuntime(item.runTimeTicks)}</span> : null}
                    {item.officialRating ? <span>{item.officialRating}</span> : null}
                    {item.communityRating ? (
                      <span className="ptv-details__rating">
                        <RatingStarIcon />
                        <span>{item.communityRating.toFixed(1)}</span>
                      </span>
                    ) : null}
                  </div>
                ) : <p className="ptv-details__meta">{meta.join(' · ')}</p>
              ) : null}
              {item?.genres?.length ? (
                isMovie ? (
                  <ul className="ptv-details__genres ptv-details__genres--movie" aria-label="Genres">
                    {item.genres.slice(0, 4).map(genre => <li key={genre}>{genre}</li>)}
                  </ul>
                ) : <p className={`ptv-details__genres ${isEpisode ? 'ptv-details__genres--episode' : ''}`.trim()}>{item.genres.slice(0, 4).join('  /  ')}</p>
              ) : null}
              <p className="ptv-details__overview">
                {cleanOverview(item?.overview) || (item ? 'No overview available.' : '')}
              </p>

              {showPlaybackPresets ? (
                <div className="ptv-details__presets" role="group" aria-label="Playback presets">
                  {detailMedia.audioTracks.length ? (
                    <FocusableButton
                      focusId="details-audio-preset"
                      preferredRow="details-presets"
                      className="ptv-details__preset"
                      onFocus={returnToHero}
                      onClick={cycleAudioPreset}
                      disabled={detailMedia.audioTracks.length < 2}
                      aria-label={`Audio: ${selectedAudioTrack?.label ?? 'Automatic'}${detailMedia.audioTracks.length > 1 ? '. Press OK to choose the next audio track.' : ''}`}
                    >
                      <AudioPresetIcon />
                      <span className="ptv-details__preset-copy">
                        <span className="ptv-details__preset-label">Audio</span>
                        <span className="ptv-details__preset-value">{selectedAudioTrack?.label ?? 'Automatic'}</span>
                      </span>
                      {detailMedia.audioTracks.length > 1 ? (
                        <span className="ptv-details__preset-count">
                          {Math.max(1, detailMedia.audioTracks.findIndex(track => track.index === selectedAudioStreamIndex) + 1)} / {detailMedia.audioTracks.length}
                        </span>
                      ) : null}
                    </FocusableButton>
                  ) : null}
                  {detailMedia.subtitleTracks.length ? (
                    <FocusableButton
                      focusId="details-subtitle-preset"
                      preferredRow="details-presets"
                      className="ptv-details__preset"
                      onFocus={returnToHero}
                      onClick={cycleSubtitlePreset}
                      aria-label={`Subtitles: ${selectedSubtitleTrack?.label ?? 'Off'}. Press OK to choose the next subtitle option.`}
                    >
                      <SubtitlePresetIcon />
                      <span className="ptv-details__preset-copy">
                        <span className="ptv-details__preset-label">Subtitles</span>
                        <span className="ptv-details__preset-value">{selectedSubtitleTrack?.label ?? 'Off'}</span>
                      </span>
                      <span className="ptv-details__preset-count">
                        {selectedSubtitleTrack
                          ? detailMedia.subtitleTracks.findIndex(track => track.index === selectedSubtitleStreamIndex) + 2
                          : 1} / {detailMedia.subtitleTracks.length + 1}
                      </span>
                    </FocusableButton>
                  ) : null}
                </div>
              ) : null}

              {item && item.type === 'MusicAlbum' ? (
                <div className="ptv-details__actions">
                  <FocusableButton
                    focusId="details-primary"
                    preferredRow="details-actions"
                    className="ptv-primary-action"
                    onClick={startAlbumPlayback}
                    disabled={albumTracksLoading || albumTracks.length === 0}
                  >
                    {albumTracksLoading ? 'Loading tracks…' : 'Play'}
                  </FocusableButton>
                  <FocusableButton
                    focusId="details-mix"
                    preferredRow="details-actions"
                    className="ptv-secondary-action"
                    onClick={startPremiumMix}
                    disabled={mixLoading}
                  >
                    {mixLoading ? 'Building mix…' : 'Start Mix'}
                  </FocusableButton>
                  {albumTracksError ? <p className="ptv-error">{albumTracksError}</p> : null}
                </div>
              ) : null}
              {item?.type === 'Series' ? (
                <div className="ptv-details__actions">
                  <FocusableButton
                    focusId="details-series-play-all"
                    preferredRow="details-actions"
                    className="ptv-primary-action"
                    onFocus={returnToHero}
                    onClick={() => startSeriesPlayback(false)}
                    disabled={seriesQueueLoading}
                  >
                    <PlayIcon />
                    <span>{seriesQueueLoading ? 'Loading episodes…' : 'Play All'}</span>
                  </FocusableButton>
                  <FocusableButton
                    focusId="details-series-shuffle-all"
                    preferredRow="details-actions"
                    className="ptv-secondary-action"
                    onFocus={returnToHero}
                    onClick={() => startSeriesPlayback(true)}
                    disabled={seriesQueueLoading}
                  >
                    <span>Shuffle All</span>
                  </FocusableButton>
                  {seriesQueueError ? <p className="ptv-error" role="alert">{seriesQueueError}</p> : null}
                </div>
              ) : null}
              {item && item.type !== 'Series' && item.type !== 'MusicAlbum' && isPlayable(item) ? (
                <div className="ptv-details__actions">
                  <FocusableButton
                    focusId="details-primary"
                    preferredRow="details-actions"
                    className={`ptv-primary-action ${useCinematicActions ? 'ptv-details__action' : ''}`}
                    onFocus={returnToHero}
                    onClick={() => startPlayback(item)}
                  >
                    {useCinematicActions ? <PlayIcon /> : null}
                    <span>{item.playbackPositionTicks ? 'Resume' : 'Play'}</span>
                  </FocusableButton>
                  {item.playbackPositionTicks ? (
                    <FocusableButton
                      focusId="details-restart"
                      preferredRow="details-actions"
                      className={`ptv-secondary-action ${useCinematicActions ? 'ptv-details__action' : ''}`}
                      onFocus={returnToHero}
                      onClick={() => startPlayback(item, true)}
                    >
                      {useCinematicActions ? <RestartIcon /> : null}
                      <span>Restart</span>
                    </FocusableButton>
                  ) : null}
                  {item.type === 'Episode' && item.seriesId ? (
                    <FocusableButton
                      focusId="details-series"
                      preferredRow="details-actions"
                      className="ptv-secondary-action ptv-details__action ptv-details__action--series"
                      onFocus={returnToHero}
                      onClick={openSeriesDetails}
                    >
                      <SeriesIcon />
                      <span>Series Details</span>
                    </FocusableButton>
                  ) : null}
                  {item.type === 'Audio' ? (
                    <FocusableButton
                      focusId="details-mix"
                      preferredRow="details-actions"
                      className="ptv-secondary-action"
                      onFocus={returnToHero}
                      onClick={startPremiumMix}
                      disabled={mixLoading}
                    >
                      {mixLoading ? 'Building mix…' : 'Start Mix'}
                    </FocusableButton>
                  ) : null}
                </div>
              ) : null}
              {item?.type === 'MusicArtist' ? (
                <div className="ptv-details__actions">
                  <FocusableButton
                    focusId="details-primary"
                    preferredRow="details-actions"
                    className="ptv-primary-action"
                    onFocus={returnToHero}
                    onClick={startPremiumMix}
                    disabled={mixLoading}
                  >
                    {mixLoading ? 'Building mix…' : 'Start Mix'}
                  </FocusableButton>
                </div>
              ) : null}
              {supportsPremiumMix(item) && mixError ? <p className="ptv-error" role="alert">{mixError}</p> : null}
              {playbackProgress !== null ? (
                <div
                  className="ptv-details__progress"
                  role="progressbar"
                  aria-label="Playback progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(playbackProgress)}
                >
                  <span style={{ width: `${playbackProgress}%` }} />
                </div>
              ) : null}
            </div>
          </div>

          {isMovie ? (
            <section className="ptv-details__related" aria-labelledby="ptv-related-heading">
              <div className="ptv-details__related-heading">
                <div>
                  <span className="ptv-eyebrow">Discover</span>
                  <h3 id="ptv-related-heading">More Like This</h3>
                </div>
                {relatedItems.length ? <span>{relatedItems.length} related titles</span> : null}
              </div>

              {relatedLoading && relatedItems.length === 0 ? (
                <div className="ptv-details__related-skeleton" aria-label="Loading related titles">
                  {Array.from({ length: 8 }, (_, index) => <span key={index} />)}
                </div>
              ) : null}

              {relatedError && relatedItems.length === 0 ? (
                <div className="ptv-details__related-empty">
                  <span>{relatedError}</span>
                  <FocusableButton
                    focusId="details-related-retry"
                    preferredRow="details-related"
                    onFocus={() => setRelatedActive(true)}
                    onClick={() => setRelatedRetryNonce(value => value + 1)}
                  >
                    Retry
                  </FocusableButton>
                </div>
              ) : null}

              {!relatedLoading && !relatedError && relatedItems.length === 0 ? (
                <p className="ptv-muted">No related titles are available.</p>
              ) : null}

              {relatedItems.length ? (
                <div className="ptv-details__related-viewport">
                  <ul
                    className="ptv-row-grid"
                    style={{ transform: `translate3d(${-relatedStart * RELATED_CARD_STEP}px, 0, 0)` }}
                  >
                    {relatedItems.map((related, index) => (
                      <CardTile
                        key={related.id}
                        focusId={`details-related-${related.id}`}
                        preferredRow="details-related"
                        item={related}
                        variant="poster"
                        posterUrl={artworkUrlForItem(client, related, 'poster')}
                        meta={related.productionYear ? String(related.productionYear) : null}
                        progressPercent={itemProgress(related)}
                        watched={Boolean(related.played)}
                        onFocus={() => revealRelated(index)}
                        onOpen={() => openRelated(related)}
                        lazy
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {item?.type === 'Series' ? (
            <div className="ptv-series-browser">
              <div className="ptv-season-line">
                <h3>Seasons</h3>
                <div ref={seasonSelectorRef} className="ptv-season-selector" role="list" aria-label="Seasons">
                  {seasons.map((season, index) => (
                    <FocusableButton
                      key={season.id}
                      focusId={index === 0 ? 'details-primary' : `details-season-${season.id}`}
                      preferredRow="details-seasons"
                      className={season.id === selectedSeasonId ? 'is-selected' : ''}
                      aria-current={season.id === selectedSeasonId ? 'true' : undefined}
                      onFocus={event => revealSeason(event.currentTarget)}
                      onClick={() => selectSeason(season)}
                    >
                      {season.name}
                    </FocusableButton>
                  ))}
                  {!seasonsLoading && seasons.length === 0 ? (
                    <FocusableButton focusId="details-primary" preferredRow="details-seasons" onClick={() => setSeasonsRetryNonce(value => value + 1)}>
                      Retry seasons
                    </FocusableButton>
                  ) : null}
                </div>
                {seasonsLoading ? <span className="ptv-muted">Loading seasons…</span> : null}
                {seasonsError ? <span className="ptv-error">{seasonsError}</span> : null}
              </div>

              <div className="ptv-episode-line">
                <div className="ptv-episode-line__heading">
                  <h3>Episodes</h3>
                  {episodesLoading ? <span className="ptv-muted">Loading selected season…</span> : null}
                  {episodesError ? <span className="ptv-error">{episodesError}</span> : null}
                  {episodesError ? (
                    <FocusableButton focusId="details-episodes-retry" preferredRow="details-episodes" onClick={() => setEpisodesRetryNonce(value => value + 1)}>
                      Retry
                    </FocusableButton>
                  ) : null}
                  {episodes.length > EPISODE_PAGE_SIZE ? (
                    <div className="ptv-episode-paging" aria-label="Episode pages">
                      <FocusableButton
                        focusId="details-episodes-previous"
                        preferredRow="details-episode-paging"
                        onClick={() => changeEpisodePage(episodePage - 1)}
                        disabled={episodePage === 0}
                      >
                        Previous
                      </FocusableButton>
                      <span>{episodePage + 1} / {episodePageCount}</span>
                      <FocusableButton
                        focusId="details-episodes-next"
                        preferredRow="details-episode-paging"
                        onClick={() => changeEpisodePage(episodePage + 1)}
                        disabled={episodePage + 1 >= episodePageCount}
                      >
                        Next
                      </FocusableButton>
                    </div>
                  ) : null}
                </div>
                <div className="ptv-episode-viewport">
                  <ul className="ptv-episode-grid" style={{ transform: `translate3d(${-episodeStart * 428}px, 0, 0)` }}>
                    {visibleEpisodes.map((episode, index) => (
                      <CardTile
                        key={episode.id}
                        focusId={`details-episode-${episode.id}`}
                        preferredRow="details-episodes"
                        item={episode}
                        variant="episode"
                        posterUrl={artworkUrlForItem(client, episode, 'landscape')}
                        context={episodeLabel(episode)}
                        meta={episode.runTimeTicks ? toHms(episode.runTimeTicks) : null}
                        progressPercent={itemProgress(episode)}
                        watched={Boolean(episode.played)}
                        onFocus={() => revealEpisode(index)}
                        onOpen={() => startPlayback(episode)}
                        lazy
                      />
                    ))}
                  </ul>
                </div>
                {!episodesLoading && !episodesError && selectedSeasonId && episodes.length === 0 ? (
                  <div className="ptv-episode-line__heading">
                    <p className="ptv-muted">No indexed episodes are available for this season.</p>
                    <FocusableButton
                      focusId="details-episodes-recheck"
                      preferredRow="details-episodes"
                      onClick={() => setEpisodesRetryNonce(value => value + 1)}
                    >
                      Check again
                    </FocusableButton>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {item?.type === 'Episode' ? (
            <section className="ptv-series-browser ptv-details__episode-shelf" aria-labelledby="ptv-more-episodes-heading">
              <div className="ptv-episode-line">
                <div className="ptv-episode-line__heading">
                  <h3 id="ptv-more-episodes-heading">{sameSeasonHeading}</h3>
                  {sameSeasonLoading ? <span className="ptv-muted">Loading episodes…</span> : null}
                  {sameSeasonError ? <span className="ptv-error">{sameSeasonError}</span> : null}
                  {sameSeasonError ? (
                    <FocusableButton
                      focusId="details-season-episodes-retry"
                      preferredRow="details-season-episodes"
                      className="ptv-secondary-action"
                      onClick={() => setSameSeasonRetryNonce(value => value + 1)}
                    >
                      Retry
                    </FocusableButton>
                  ) : null}
                </div>

                {visibleSameSeasonEpisodes.length ? (
                  <div className="ptv-episode-viewport">
                    <ul
                      className="ptv-episode-grid"
                      style={{ transform: `translate3d(${-sameSeasonStart * EPISODE_DETAIL_CARD_STEP}px, 0, 0)` }}
                    >
                      {visibleSameSeasonEpisodes.map((episode, index) => (
                        <CardTile
                          key={episode.id}
                          focusId={`details-season-episode-${episode.id}`}
                          preferredRow="details-season-episodes"
                          item={episode}
                          variant="episode"
                          posterUrl={artworkUrlForItem(client, episode, 'landscape')}
                          context={episodeLabel(episode)}
                          meta={compactRuntime(episode.runTimeTicks)}
                          progressPercent={itemProgress(episode)}
                          watched={Boolean(episode.played)}
                          onFocus={() => revealSameSeasonEpisode(index)}
                          onOpen={() => startPlayback(episode)}
                          lazy
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}

                {!sameSeasonLoading && !sameSeasonError && visibleSameSeasonEpisodes.length === 0 ? (
                  <p className="ptv-muted">No other episodes are available from this season.</p>
                ) : null}
              </div>
            </section>
          ) : null}

          {item && !isMovie && canNavigateToDetails(item) ? (
            <section className={`ptv-series-browser ${isEpisode ? 'ptv-details__episode-shelf' : ''}`.trim()} aria-labelledby="ptv-related-heading">
              <div className="ptv-episode-line">
                <div className="ptv-episode-line__heading">
                  <h3 id="ptv-related-heading">More Like This</h3>
                  {relatedItems.length ? <span className="ptv-muted">{relatedItems.length} related picks</span> : null}
                </div>

                {relatedLoading && relatedItems.length === 0 ? (
                  <p className="ptv-muted">Loading related picks…</p>
                ) : null}

                {relatedError && relatedItems.length === 0 ? (
                  <div className="ptv-episode-line__heading">
                    <span className="ptv-error">{relatedError}</span>
                    <FocusableButton
                      focusId="details-related-retry"
                      preferredRow="details-related"
                      className="ptv-secondary-action"
                      onClick={() => setRelatedRetryNonce(value => value + 1)}
                    >
                      Retry
                    </FocusableButton>
                  </div>
                ) : null}

                {!relatedLoading && !relatedError && relatedItems.length === 0 ? (
                  <p className="ptv-muted">No related picks are available.</p>
                ) : null}

                {relatedItems.length ? (
                  <div className="ptv-episode-viewport">
                    <ul
                      className="ptv-episode-grid"
                      style={{ transform: `translate3d(${-relatedStart * relatedCardStep}px, 0, 0)` }}
                    >
                      {relatedItems.map((related, index) => (
                        <CardTile
                          key={related.id}
                          focusId={`details-related-${related.id}`}
                          preferredRow="details-related"
                          item={related}
                          variant="episode"
                          posterUrl={artworkUrlForItem(client, related, 'landscape')}
                          context={mediaTypeLabel(related)}
                          meta={related.productionYear
                            ? String(related.productionYear)
                            : related.runTimeTicks
                              ? toHms(related.runTimeTicks)
                              : null}
                          progressPercent={itemProgress(related)}
                          watched={Boolean(related.played)}
                          onFocus={() => revealRelated(index)}
                          onOpen={() => openRelated(related)}
                          lazy
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {item?.type === 'MusicAlbum' ? (
            <div className="ptv-series-browser">
              <div className="ptv-episode-line">
                <h3>Tracks</h3>
                {albumTracksLoading ? <span className="ptv-muted">Loading tracks…</span> : null}
                {albumTracksError ? <span className="ptv-error">{albumTracksError}</span> : null}
                {!albumTracksLoading && !albumTracksError && albumTracks.length === 0 ? (
                  <p className="ptv-muted">No tracks are available for this album.</p>
                ) : null}
                {albumTracks.length ? (
                  <div className="ptv-episode-viewport">
                    <ul className="ptv-episode-grid">
                      {albumTracks.map(track => (
                        <CardTile
                          key={track.id}
                          focusId={`details-track-${track.id}`}
                          preferredRow="details-episodes"
                          item={track}
                          variant="episode"
                          posterUrl={artworkUrlForItem(client, track, 'landscape')}
                          context={track.trackNumber ? `Track ${track.trackNumber}` : null}
                          meta={track.runTimeTicks ? toHms(track.runTimeTicks) : null}
                          progressPercent={itemProgress(track)}
                          watched={Boolean(track.played)}
                        onOpen={() => startPlayback(track, false, albumTracks)}
                          onFocus={() => setEpisodeStart(0)}
                          lazy
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </LayoutShell>
  );
}


