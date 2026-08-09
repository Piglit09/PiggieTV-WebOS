import { requestJson, type JellyfinAuthorizationContext, type RequestConfig } from '../http/http';
import type {
  PtvAuthenticateResponse,
  PtvPlaybackInfoResponse,
  PtvPlaybackReport,
  PtvServerIdentity,
  PtvSystemInfo
} from './types';
import { normalizeServerUrl } from './normalizeUrl';
import type { PtvCapability, PtvSearchCategoryKind } from '../../types/ptv';
import { mapStatusToErrorKind, toPtvError } from '../../core/errors';
import type { RequestTracker } from '../../core/requestTracker';
import {
  PTV_APPLICATION_NAME,
  PTV_APPLICATION_VERSION,
  PTV_DEVICE_NAME
} from '../../config/app';
import { createPtvWebOsDeviceProfile } from '../../playback/deviceProfile';

export interface JellyfinTransportConfig {
  baseUrl: string;
  accessToken?: string;
  deviceId: string;
  requestTracker?: RequestTracker;
}

export interface PtvLibraryListResponse {
  Items: { Id: string; Name: string; CollectionType?: string | null; }[];
}

export interface PtvTypedResponse {
  Id?: string;
  Name?: string;
}

export interface PtvQuickConnectStateResponse {
  Authenticated: boolean;
  Secret: string;
  Code: string;
  DateAdded: string;
  DeviceId: string;
  DeviceName: string;
  AppName: string;
  AppVersion: string;
}

type RequestExtras = Omit<Partial<RequestConfig>, 'method' | 'body' | 'timeoutMs' | 'signal'>;

const EPISODE_FIELDS = 'ImageTags,Overview,RunTimeTicks,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,UserData,SeriesId,SeasonId,ParentId';
const SEARCH_TAXONOMY_TIMEOUT_MS = 2_500;
const SEARCH_TAXONOMY_EXACT_TIMEOUT_MS = 6_000;
const SEARCH_CATEGORY_TIMEOUT_MS = 8_000;
const SEARCH_RESPONSE_CACHE_TTL_MS = 60_000;
const SEARCH_TIMEOUT_CACHE_TTL_MS = 15_000;
const SEARCH_RESPONSE_CACHE_LIMIT = 64;
const PLAYBACK_REPORT_TIMEOUT_MS = 8_000;

type PlaybackReportPath =
  | 'Sessions/Playing'
  | 'Sessions/Playing/Progress'
  | 'Sessions/Playing/Stopped';
type PlaybackReportPayload = Omit<PtvPlaybackReport, 'ItemId'>;
type PlaybackStoppedReportPayload = Pick<
  PlaybackReportPayload,
  'PlaySessionId' | 'PositionTicks' | 'MediaSourceId'
>;

type PtvItemsResponse = { Items: Array<Record<string, unknown>>; TotalRecordCount?: number };

interface SearchResponseCacheEntry {
  expiresAt: number;
  value: PtvItemsResponse;
}

function getRequestErrorDetails(cause: unknown) {
  if (!cause || typeof cause !== 'object') return { kind: '', code: null };
  const candidate = cause as { kind?: unknown; code?: unknown; status?: unknown };
  const code = typeof candidate.code === 'number'
    ? candidate.code
    : typeof candidate.status === 'number' ? candidate.status : null;
  return {
    kind: typeof candidate.kind === 'string' ? candidate.kind : '',
    code
  };
}

function normalizeEpisodeRelationships(
  response: { Items: Array<Record<string, unknown>>; TotalRecordCount?: number },
  seriesId: string,
  seasonId: string
) {
  const items = Array.isArray(response.Items) ? response.Items : [];
  return {
    ...response,
    Items: items.map(item => {
      const itemType = typeof item.Type === 'string' ? item.Type.trim().toLowerCase() : '';
      if (itemType !== 'episode') return item;
      const parentId = typeof item.ParentId === 'string' && item.ParentId.trim()
        ? item.ParentId.trim()
        : seasonId;
      const normalizedSeriesId = typeof item.SeriesId === 'string' && item.SeriesId.trim()
        ? item.SeriesId.trim()
        : seriesId;
      const normalizedSeasonId = typeof item.SeasonId === 'string' && item.SeasonId.trim()
        ? item.SeasonId.trim()
        : parentId;
      return {
        ...item,
        ParentId: parentId,
        SeriesId: normalizedSeriesId,
        SeasonId: normalizedSeasonId
      };
    })
  };
}

function normalizeSearchCategoryResponse(
  response: { Items: Array<Record<string, unknown>>; TotalRecordCount?: number },
  kind: PtvSearchCategoryKind,
  query: string
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return {
    ...response,
    Items: (Array.isArray(response.Items) ? response.Items : [])
      .map((item): Record<string, unknown> => ({
        ...item,
        Type: typeof item.Type === 'string' && item.Type.trim() ? item.Type : kind
      }))
      .filter(item => {
        const name = typeof item.Name === 'string' ? item.Name.trim().toLocaleLowerCase() : '';
        return Boolean(name) && (!normalizedQuery || name.includes(normalizedQuery));
      })
      .slice(0, 16)
  };
}

export class JellyfinApiClient {
  private baseUrl: string;
  private accessToken?: string;
  private readonly deviceId: string;
  private headers: Record<string, string>;
  private readonly requestTracker?: RequestTracker;
  private readonly requestCategory = 'jellyfin';
  private readonly searchResponseCache = new Map<string, SearchResponseCacheEntry>();

  constructor(config: JellyfinTransportConfig) {
    this.baseUrl = normalizeServerUrl(config.baseUrl);
    this.accessToken = config.accessToken;
    this.deviceId = config.deviceId;
    this.requestTracker = config.requestTracker;
    this.headers = {
      'X-Application-Name': PTV_APPLICATION_NAME,
      'X-Application-Version': PTV_APPLICATION_VERSION,
      'User-Agent': `PTV-webOS/${PTV_APPLICATION_VERSION}`
    };
  }

  public setAccessToken(token: string | undefined) {
    if (this.accessToken !== token) this.searchResponseCache.clear();
    this.accessToken = token;
  }

  public setServer(baseUrl: string) {
    const normalized = normalizeServerUrl(baseUrl);
    if (this.baseUrl !== normalized) this.searchResponseCache.clear();
    this.baseUrl = normalized;
  }

  public getServerUrl() {
    return this.baseUrl;
  }

  public getDeviceId() {
    return this.deviceId;
  }

  private getAuthorizationContext(): JellyfinAuthorizationContext {
    return {
      accessToken: this.accessToken,
      clientName: PTV_APPLICATION_NAME,
      deviceName: PTV_DEVICE_NAME,
      deviceId: this.deviceId,
      applicationVersion: PTV_APPLICATION_VERSION
    };
  }

  private withPath(path: string) {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private readSearchResponseCache(key: string) {
    const cached = this.searchResponseCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.searchResponseCache.delete(key);
      return null;
    }
    this.searchResponseCache.delete(key);
    this.searchResponseCache.set(key, cached);
    return cached.value;
  }

  private writeSearchResponseCache(
    key: string,
    value: PtvItemsResponse,
    ttlMs = SEARCH_RESPONSE_CACHE_TTL_MS
  ) {
    this.searchResponseCache.delete(key);
    this.searchResponseCache.set(key, { expiresAt: Date.now() + ttlMs, value });
    while (this.searchResponseCache.size > SEARCH_RESPONSE_CACHE_LIMIT) {
      const oldest = this.searchResponseCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.searchResponseCache.delete(oldest);
    }
    return value;
  }

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    timeoutMs?: number,
    signal?: AbortSignal,
    requestConfig: RequestExtras = {}
  ) {
    return requestJson<T>(this.withPath(path), {
      ...requestConfig,
      method: 'GET',
      headers: this.headers,
      query,
      timeoutMs,
      signal,
      requestTracker: requestConfig.requestTracker ?? this.requestTracker,
      requestCategory: requestConfig.requestCategory ?? this.requestCategory,
      requestRoute: requestConfig.requestRoute ?? `GET ${path}`
    }, this.getAuthorizationContext());
  }

  private async post<T>(
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    requestCategory?: string,
    requestConfig: RequestExtras = {}
  ) {
    return requestJson<T>(this.withPath(path), {
      ...requestConfig,
      method: 'POST',
      headers: this.headers,
      body,
      timeoutMs,
      signal,
      requestTracker: requestConfig.requestTracker ?? this.requestTracker,
      requestCategory: requestConfig.requestCategory ?? requestCategory ?? this.requestCategory,
      requestRoute: requestConfig.requestRoute ?? `POST ${path}`
    }, this.getAuthorizationContext());
  }

  private async sendReport<T>(path: PlaybackReportPath, body: unknown) {
    return this.post<T>(
      path,
      body,
      PLAYBACK_REPORT_TIMEOUT_MS,
      undefined,
      'playback',
      {
        retries: 0,
        requestRoute: `POST ${path}`
      }
    );
  }

  public async validateServer(timeoutMs = 10000, requestConfig: RequestExtras = {}, signal?: AbortSignal): Promise<PtvSystemInfo> {
    const system = await this.get<PtvSystemInfo>('System/Info/Public', undefined, timeoutMs, signal, requestConfig);
    const serverId = typeof system?.ServerId === 'string' && system.ServerId.trim()
      ? system.ServerId.trim()
      : typeof system?.Id === 'string'
        ? system.Id.trim()
        : '';
    if (
      !system ||
      !serverId ||
      typeof system.Version !== 'string' || !system.Version.trim()
    ) {
      throw toPtvError('Server identity response is incomplete', 'invalid-server-response');
    }
    return { ...system, ServerId: serverId };
  }

  public getSystemInfo(timeoutMs = 10000, requestConfig: RequestExtras = {}, signal?: AbortSignal): Promise<PtvSystemInfo> {
    return this.validateServer(timeoutMs, requestConfig, signal);
  }

  public async discoverCapabilities(timeoutMs = 10000, signal?: AbortSignal): Promise<PtvCapability[]> {
    void timeoutMs;
    if (signal?.aborted) {
      throw toPtvError('Request cancelled', 'cancelled-request');
    }
    return [
      { id: 'quick-connect', label: 'Quick Connect', enabled: true, details: { path: `${this.baseUrl}/QuickConnect` } },
      { id: 'playback-direct-play', label: 'Direct play', enabled: true },
      { id: 'playback-direct-stream', label: 'Direct stream', enabled: true },
      { id: 'playback-transcode', label: 'Transcode', enabled: true },
      { id: 'jellyfin-server', label: 'Jellyfin', enabled: true }
    ];
  }

  public authenticateByName(
    username: string,
    password: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
    requestCategory = 'authentication',
    requestConfig: RequestExtras = {}
  ): Promise<PtvAuthenticateResponse> {
    const payload = {
      Username: username,
      Pw: password
    };
    return this.post<PtvAuthenticateResponse>(
      'Users/AuthenticateByName',
      payload,
      timeoutMs,
      signal,
      requestCategory,
      { ...requestConfig, retries: 0 }
    );
  }

  public authenticateWithQuickConnect(
    secret: string,
    timeoutMs = 15000,
    signal?: AbortSignal,
    requestConfig: RequestExtras = {}
  ): Promise<PtvAuthenticateResponse> {
    return this.post<PtvAuthenticateResponse>(
      'Users/AuthenticateWithQuickConnect',
      { Secret: secret },
      timeoutMs,
      signal,
      'authentication',
      { ...requestConfig, retries: 0 }
    );
  }

  public initiateQuickConnect(timeoutMs = 10000, signal?: AbortSignal): Promise<{ Secret: string; Code: string }> {
    return this.post<{ Secret: string; Code: string }>('QuickConnect/Initiate', {}, timeoutMs, signal, 'authentication', { retries: 0 });
  }

  public getQuickConnectState(
    secret: string,
    timeoutMs = 10000,
    signal?: AbortSignal,
    requestConfig: RequestExtras = {}
  ): Promise<PtvQuickConnectStateResponse> {
    return this.get<PtvQuickConnectStateResponse>(
      'QuickConnect/Connect',
      { secret },
      timeoutMs,
      signal,
      { ...requestConfig, requestCategory: 'authentication', retries: 0 }
    );
  }

  public validateSession(_sessionUserId: string, timeoutMs = 10000, signal?: AbortSignal) {
    return this.get<PtvTypedResponse>('Users/Me', undefined, timeoutMs, signal, {
      retries: 0,
      requestCategory: 'authentication',
      requestRoute: 'GET Users/Me'
    });
  }

  public getUserProfile(sessionUserId: string, timeoutMs = 10000, signal?: AbortSignal) {
    return this.get<{
      Id: string;
      Name: string;
      Policy?: { IsAdministrator?: boolean };
      PrimaryImageTag?: string | null;
    }>(`Users/${encodeURIComponent(sessionUserId)}`, undefined, timeoutMs, signal);
  }

  public getItem(sessionUserId: string, itemId: string, fields?: string[], signal?: AbortSignal) {
    const query: Record<string, string | undefined> = {};
    if (fields?.length) query.Fields = fields.join(',');
    return this.get<Record<string, unknown>>(`Users/${encodeURIComponent(sessionUserId)}/Items/${encodeURIComponent(itemId)}`, query, undefined, signal);
  }

  public getLibraries(sessionUserId: string, signal?: AbortSignal) {
    return this.get<PtvLibraryListResponse>(`Users/${encodeURIComponent(sessionUserId)}/Views`, undefined, undefined, signal);
  }

  public getItems(sessionUserId: string, params: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      params,
      undefined,
      signal
    );
  }

  public getSimilarItems(
    sessionUserId: string,
    itemId: string,
    options: { limit?: number; fields?: string[] } = {},
    signal?: AbortSignal
  ) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Items/${encodeURIComponent(itemId)}/Similar`,
      {
        UserId: sessionUserId,
        Limit: Math.max(1, Math.min(64, options.limit ?? 16)),
        Fields: options.fields?.join(','),
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal,
      { requestRoute: 'GET Items/{item}/Similar' }
    );
  }

  public getInstantMix(
    sessionUserId: string,
    itemId: string,
    options: { limit?: number; fields?: string[] } = {},
    signal?: AbortSignal
  ) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Items/${encodeURIComponent(itemId)}/InstantMix`,
      {
        UserId: sessionUserId,
        Limit: Math.max(1, Math.min(64, options.limit ?? 48)),
        Fields: options.fields?.join(','),
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal,
      { requestRoute: 'GET Items/{item}/InstantMix' }
    );
  }

  public getResume(sessionUserId: string, itemTypes: string, limit = 12, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>> }>(`Users/${encodeURIComponent(sessionUserId)}/Items/Resume`, {
      IncludeItemTypes: itemTypes,
      Limit: limit,
      Fields: 'ImageTags,BackdropImageTags,UserData,SeriesName,SeasonName,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres',
      EnableUserData: true,
      EnableTotalRecordCount: false
    }, undefined, signal);
  }

  public getNextUp(sessionUserId: string, limit = 12, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      'Shows/NextUp',
      {
        UserId: sessionUserId,
        Limit: limit,
        Fields: 'ImageTags,BackdropImageTags,UserData,SeriesName,SeasonName,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres',
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal
    );
  }

  public getNextUpForSeries(userId: string, seriesId: string, limit = 2, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      'Shows/NextUp',
      {
        UserId: userId,
        SeriesId: seriesId,
        Limit: limit,
        Fields: 'ImageTags,BackdropImageTags,Overview,RunTimeTicks,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,UserData',
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal,
      { requestRoute: 'GET Shows/NextUp' }
    );
  }

  public getSeasons(sessionUserId: string, seriesId: string, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Shows/${encodeURIComponent(seriesId)}/Seasons`,
      {
        UserId: sessionUserId,
        Fields: 'ImageTags,Overview,ProductionYear,PremiereDate,EndDate,Status,UserData,ChildCount,RecursiveItemCount',
        EnableUserData: true
      },
      undefined,
      signal,
      { requestRoute: 'GET Shows/{series}/Seasons' }
    );
  }

  public async getEpisodes(
    sessionUserId: string,
    seriesId: string,
    seasonId: string,
    signal?: AbortSignal
  ) {
    let primaryResponse: { Items: Array<Record<string, unknown>>; TotalRecordCount?: number } | null = null;
    try {
      primaryResponse = await this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
        `Shows/${encodeURIComponent(seriesId)}/Episodes`,
        {
          UserId: sessionUserId,
          SeasonId: seasonId,
          Fields: EPISODE_FIELDS,
          EnableUserData: true,
          EnableTotalRecordCount: false
        },
        undefined,
        signal,
        { requestRoute: 'GET Shows/{series}/Episodes' }
      );
    } catch (cause) {
      if (signal?.aborted) throw cause;
    }

    if (primaryResponse && Array.isArray(primaryResponse.Items) && primaryResponse.Items.length > 0) {
      return normalizeEpisodeRelationships(primaryResponse, seriesId, seasonId);
    }

    const fallbackResponse = await this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      {
        ParentId: seasonId,
        IncludeItemTypes: 'Episode',
        Recursive: true,
        Fields: EPISODE_FIELDS,
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal,
      { requestRoute: 'GET Users/{user}/Items (season episode fallback)' }
    );
    return normalizeEpisodeRelationships(fallbackResponse, seriesId, seasonId);
  }

  public getRecentlyAdded(sessionUserId: string, includeType: string, limit = 16, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>> }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      {
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        IncludeItemTypes: includeType,
        Limit: limit,
        Fields: 'ImageTags,BackdropImageTags,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres,UserData,ChildCount,RecursiveItemCount',
        Recursive: true,
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal
    );
  }

  public async getSearch(sessionUserId: string, query: string, include = 'Movie,Series,MusicAlbum,Audio,MusicVideo,MusicArtist,Playlist,Book', signal?: AbortSignal) {
    const cacheKey = `content\u0000${sessionUserId}\u0000${include}\u0000${query.trim().toLocaleLowerCase()}`;
    const cached = this.readSearchResponseCache(cacheKey);
    if (cached) return cached;
    const response = await this.get<PtvItemsResponse>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      {
        SearchTerm: query,
        Recursive: true,
        IncludeItemTypes: include,
        Limit: 16,
        Fields: 'ImageTags,ProductionYear,RunTimeTicks,SeriesName,IndexNumber,Overview,Genres,ChildCount,RecursiveItemCount',
        SortBy: 'SortName',
        SortOrder: 'Ascending'
      },
      undefined,
      signal
    );
    return this.writeSearchResponseCache(cacheKey, response);
  }

  private async getSearchCategoryIndex(
    sessionUserId: string,
    query: string,
    kind: PtvSearchCategoryKind,
    signal?: AbortSignal
  ) {
    const endpoint = kind === 'Genre' ? 'Genres' : kind === 'MusicGenre' ? 'MusicGenres' : 'Studios';
    const trimmedQuery = query.trim();
    const cacheKey = `taxonomy\u0000${sessionUserId}\u0000${kind}\u0000${trimmedQuery.toLocaleLowerCase()}`;
    const cached = this.readSearchResponseCache(cacheKey);
    if (cached) return cached;

    if (trimmedQuery) {
      try {
        const exact = await this.get<Record<string, unknown>>(
          `${endpoint}/${encodeURIComponent(trimmedQuery)}`,
          { UserId: sessionUserId },
          SEARCH_TAXONOMY_EXACT_TIMEOUT_MS,
          signal,
          { retries: 0, requestRoute: `GET ${endpoint}/{name} (search taxonomy exact)` }
        );
        const normalizedExact = normalizeSearchCategoryResponse(
          { Items: [exact], TotalRecordCount: 1 },
          kind,
          trimmedQuery
        );
        if (normalizedExact.Items.length) return this.writeSearchResponseCache(cacheKey, normalizedExact);
      } catch (cause) {
        if (signal?.aborted) throw cause;
        const { kind: errorKind, code } = getRequestErrorDetails(cause);
        if (errorKind === 'cancelled-request') throw cause;
        if (errorKind === 'request-timeout') {
          return this.writeSearchResponseCache(
            cacheKey,
            { Items: [], TotalRecordCount: 0 },
            SEARCH_TIMEOUT_CACHE_TTL_MS
          );
        }
        if (code !== 404 && code !== 410) throw cause;
      }
    }

    try {
      const response = await this.get<PtvItemsResponse>(
        endpoint,
        {
          UserId: sessionUserId,
          SearchTerm: trimmedQuery,
          StartIndex: 0,
          Limit: 48,
          EnableImages: true,
          EnableImageTypes: 'Primary,Thumb',
          ImageTypeLimit: 1,
          Fields: 'PrimaryImageAspectRatio,SortName',
          EnableUserData: false,
          EnableTotalRecordCount: false,
          SortBy: 'SortName',
          SortOrder: 'Ascending'
        },
        SEARCH_TAXONOMY_TIMEOUT_MS,
        signal,
        { retries: 0, requestRoute: `GET ${endpoint} (search taxonomy)` }
      );
      return this.writeSearchResponseCache(
        cacheKey,
        normalizeSearchCategoryResponse(response, kind, trimmedQuery)
      );
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const { kind: errorKind } = getRequestErrorDetails(cause);
      if (errorKind === 'request-timeout') {
        return this.writeSearchResponseCache(
          cacheKey,
          { Items: [], TotalRecordCount: 0 },
          SEARCH_TIMEOUT_CACHE_TTL_MS
        );
      }
      throw cause;
    }
  }

  public getSearchGenres(sessionUserId: string, query: string, signal?: AbortSignal) {
    return this.getSearchCategoryIndex(sessionUserId, query, 'Genre', signal);
  }

  public getSearchMusicGenres(sessionUserId: string, query: string, signal?: AbortSignal) {
    return this.getSearchCategoryIndex(sessionUserId, query, 'MusicGenre', signal);
  }

  public getSearchStudios(sessionUserId: string, query: string, signal?: AbortSignal) {
    return this.getSearchCategoryIndex(sessionUserId, query, 'Studio', signal);
  }

  public async getSearchCategoryItems(
    sessionUserId: string,
    categoryId: string,
    kind: PtvSearchCategoryKind,
    startIndex = 0,
    limit = 16,
    signal?: AbortSignal,
    categoryName?: string
  ) {
    const normalizedName = categoryName?.trim();
    const cacheKey = [
      'category',
      sessionUserId,
      kind,
      categoryId,
      normalizedName?.toLocaleLowerCase() ?? '',
      Math.max(0, Math.floor(startIndex)),
      Math.max(1, Math.min(32, Math.floor(limit)))
    ].join('\u0000');
    const cached = this.readSearchResponseCache(cacheKey);
    if (cached) return cached;
    const musicGenre = kind === 'MusicGenre';
    const baseParams: Record<string, string | number | boolean | undefined> = {
      StartIndex: Math.max(0, Math.floor(startIndex)),
      Limit: Math.max(1, Math.min(32, Math.floor(limit))),
      IncludeItemTypes: musicGenre ? 'MusicAlbum' : 'Movie,Series',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: musicGenre
        ? 'ImageTags,ProductionYear'
        : 'ImageTags,ProductionYear,UserData,ChildCount,RecursiveItemCount',
      EnableUserData: true,
      EnableTotalRecordCount: false
    };
    const getItems = (params: Record<string, string | number | boolean | undefined>, requestRoute: string) => this.get<{
      Items: Array<Record<string, unknown>>;
      TotalRecordCount?: number;
    }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      params,
      SEARCH_CATEGORY_TIMEOUT_MS,
      signal,
      { retries: 0, requestRoute }
    );

    if (normalizedName) {
      try {
        const byName = await getItems(
          {
            ...baseParams,
            Genres: kind === 'Studio' ? undefined : normalizedName,
            Studios: kind === 'Studio' ? normalizedName : undefined
          },
          'GET Users/{user}/Items (search category by name)'
        );
        if (Array.isArray(byName.Items) && byName.Items.length) {
          return this.writeSearchResponseCache(cacheKey, { ...byName, TotalRecordCount: undefined });
        }
      } catch (cause) {
        const { kind: errorKind } = getRequestErrorDetails(cause);
        if (errorKind === 'request-timeout' || errorKind === 'cancelled-request') throw cause;
      }
    }

    const byId = await getItems(
      {
        ...baseParams,
        GenreIds: kind === 'Studio' ? undefined : categoryId,
        StudioIds: kind === 'Studio' ? categoryId : undefined
      },
      'GET Users/{user}/Items (search category by id)'
    );
    return this.writeSearchResponseCache(cacheKey, { ...byId, TotalRecordCount: undefined });
  }

  public getPlaybackInfo(
    sessionUserId: string,
    itemId: string,
    options: {
      profile?: Record<string, unknown>;
      audioStreamIndex?: number;
      subtitleStreamIndex?: number | null;
      enableDirectPlay?: boolean;
      enableDirectStream?: boolean;
      enableTranscoding?: boolean;
    } = {},
    signal?: AbortSignal
  ) {
    const payload: Record<string, unknown> = {
      DeviceProfile: options.profile || createPtvWebOsDeviceProfile(),
      UserId: sessionUserId,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      EnableDirectPlay: options.enableDirectPlay ?? true,
      EnableDirectStream: options.enableDirectStream ?? true,
      EnableTranscoding: options.enableTranscoding ?? true
    };

    if (typeof options.audioStreamIndex === 'number') {
      payload.AudioStreamIndex = options.audioStreamIndex;
    }

    if (options.subtitleStreamIndex === null) {
      payload.SubtitleStreamIndex = -1;
    } else if (typeof options.subtitleStreamIndex === 'number') {
      payload.SubtitleStreamIndex = options.subtitleStreamIndex;
    }

    return this.post<PtvPlaybackInfoResponse>(
      `Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      payload,
      20_000,
      signal,
      'playback',
      {
        retries: 0,
        requestRoute: 'POST Items/{item}/PlaybackInfo'
      }
    );
  }

  public reportPlaying(itemId: string, payload: PlaybackReportPayload) {
    return this.sendReport<Record<string, unknown>>('Sessions/Playing', {
      ItemId: itemId,
      ...payload
    });
  }

  public reportProgress(itemId: string, payload: PlaybackReportPayload) {
    return this.sendReport<Record<string, unknown>>('Sessions/Playing/Progress', {
      ItemId: itemId,
      ...payload
    });
  }

  public reportStopped(itemId: string, payload: PlaybackStoppedReportPayload) {
    return this.sendReport<Record<string, unknown>>('Sessions/Playing/Stopped', {
      ItemId: itemId,
      ...payload
    });
  }

  public getImageUrl(
    itemId: string,
    imageType: 'Primary' | 'Backdrop' | 'Logo' | 'Thumb' | 'Poster',
    tag?: string,
    options: { maxWidth?: number; quality?: number } = {}
  ) {
    const params: Record<string, string | number | boolean | undefined> = {
      quality: options.quality ?? 90
    };
    if (this.accessToken) {
      params.api_key = this.accessToken;
    }
    if (tag) params.tag = tag;
    if (imageType === 'Backdrop') params.maxWidth = options.maxWidth ?? 1280;
    if (imageType === 'Thumb' || imageType === 'Poster') params.maxWidth = options.maxWidth ?? 640;
    if (imageType === 'Primary' || imageType === 'Logo') params.maxWidth = options.maxWidth ?? 900;

    return `${this.withPath(`Items/${encodeURIComponent(itemId)}/Images/${imageType}`)}?` +
      new URLSearchParams(
        Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
          if (value === undefined) return acc;
          acc[key] = String(value);
          return acc;
        }, {})
      ).toString();
  }
}

export function parseSystemIdentity(baseUrl: string, systemInfo: PtvSystemInfo): PtvServerIdentity {
  return {
    baseUrl,
    serverId: systemInfo.ServerId,
    serverName: systemInfo.ServerName,
    serverVersion: systemInfo.Version
  };
}

export function parseJellyfinError(response: unknown, fallback = 'Request failed') {
  if (response && typeof response === 'object' && 'Message' in response && typeof response.Message === 'string') {
    return response.Message;
  }
  if (typeof response === 'string') return response;
  return fallback;
}

export function classifyApiError(error: unknown) {
  if (error && typeof error === 'object') {
    const err = error as { status?: number; message?: string; code?: number };
    return toPtvError({
      message: parseJellyfinError(error, 'Request failed'),
      status: err.status,
      code: err.code
    }, mapStatusToErrorKind(err.status ?? 0));
  }
  return toPtvError(String(error ?? 'Request failed'), 'unknown');
}

export function createPlaybackStreamUrl(
  baseUrl: string,
  itemId: string,
  sourceId: string,
  accessToken: string,
  directPlay = false,
  container?: string,
  deviceId = 'PTV-WebOS'
) {
  const query = new URLSearchParams({
    api_key: accessToken,
    mediaSourceId: sourceId,
    static: String(directPlay),
    deviceId
  });
  if (container) query.set('container', container);
  return `${baseUrl.replace(/\/+$/, '')}/Videos/${encodeURIComponent(itemId)}/stream?${query.toString()}`;
}

export function resolvePlaybackStreamUrl(
  baseUrl: string,
  itemId: string,
  source: {
    Id: string;
    Container?: string | null;
    DirectStreamUrl?: string | null;
    TranscodingUrl?: string | null;
  },
  mode: 'direct-play' | 'direct-stream' | 'transcode',
  accessToken: string,
  deviceId: string
) {
  const serverRoot = `${baseUrl.replace(/\/+$/, '')}/`;
  const suppliedPath = mode === 'transcode'
    ? source.TranscodingUrl
    : mode === 'direct-stream'
      ? source.DirectStreamUrl
      : null;

  if (mode !== 'direct-play' && (!suppliedPath || !suppliedPath.trim())) {
    throw new Error(`Jellyfin did not provide a usable ${mode} URL`);
  }

  if (!suppliedPath) {
    return createPlaybackStreamUrl(
      baseUrl,
      itemId,
      source.Id,
      accessToken,
      true,
      source.Container ?? undefined,
      deviceId
    );
  }

  const url = new URL(suppliedPath.trim(), serverRoot);
  if (!url.searchParams.has('api_key') && !url.searchParams.has('token')) {
    url.searchParams.set('api_key', accessToken);
  }
  if (!url.searchParams.has('deviceId')) {
    url.searchParams.set('deviceId', deviceId);
  }
  return url.toString();
}
