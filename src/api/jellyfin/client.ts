import { requestJson, type JellyfinAuthorizationContext, type RequestConfig } from '../http/http';
import type { PtvAuthenticateResponse, PtvPlaybackInfoResponse, PtvServerIdentity, PtvSystemInfo } from './types';
import { normalizeServerUrl } from './normalizeUrl';
import type { PtvCapability } from '../../types/ptv';
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

export class JellyfinApiClient {
  private baseUrl: string;
  private accessToken?: string;
  private readonly deviceId: string;
  private headers: Record<string, string>;
  private readonly requestTracker?: RequestTracker;
  private readonly requestCategory = 'jellyfin';

  constructor(config: JellyfinTransportConfig) {
    this.baseUrl = normalizeServerUrl(config.baseUrl);
    this.accessToken = config.accessToken;
    this.deviceId = config.deviceId;
    this.requestTracker = config.requestTracker;
    this.headers = {
      'X-Application-Name': 'PiggieTV',
      'X-Application-Version': '0.1.0',
      'User-Agent': 'PTV-webOS/0.1.0'
    };
  }

  public setAccessToken(token: string | undefined) {
    this.accessToken = token;
  }

  public setServer(baseUrl: string) {
    this.baseUrl = normalizeServerUrl(baseUrl);
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

  private async sendReport<T>(path: string, body: unknown, timeoutMs?: number) {
    return this.post<T>(path, body, timeoutMs);
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
    return this.get<PtvTypedResponse>('Users/Me', undefined, timeoutMs, signal);
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
        Fields: 'ImageTags,Overview,ProductionYear,PremiereDate,EndDate,Status,UserData',
        EnableUserData: true
      },
      undefined,
      signal,
      { requestRoute: 'GET Shows/{series}/Seasons' }
    );
  }

  public getEpisodes(
    sessionUserId: string,
    seriesId: string,
    seasonId: string,
    signal?: AbortSignal
  ) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Shows/${encodeURIComponent(seriesId)}/Episodes`,
      {
        UserId: sessionUserId,
        SeasonId: seasonId,
        Fields: 'ImageTags,Overview,RunTimeTicks,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,UserData',
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal,
      { requestRoute: 'GET Shows/{series}/Episodes' }
    );
  }

  public getRecentlyAdded(sessionUserId: string, includeType: string, limit = 16, signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>> }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      {
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        IncludeItemTypes: includeType,
        Limit: limit,
        Fields: 'ImageTags,BackdropImageTags,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres,UserData',
        Recursive: true,
        EnableUserData: true,
        EnableTotalRecordCount: false
      },
      undefined,
      signal
    );
  }

  public getSearch(sessionUserId: string, query: string, include = 'Movie,Series,MusicAlbum,Audio,Book', signal?: AbortSignal) {
    return this.get<{ Items: Array<Record<string, unknown>>; TotalRecordCount?: number }>(
      `Users/${encodeURIComponent(sessionUserId)}/Items`,
      {
        SearchTerm: query,
        Recursive: true,
        IncludeItemTypes: include,
        Limit: 16,
        Fields: 'ImageTags,ProductionYear,RunTimeTicks,SeriesName,IndexNumber,Overview,Genres',
        SortBy: 'SortName',
        SortOrder: 'Ascending'
      },
      undefined,
      signal
    );
  }

  public getPlaybackInfo(
    sessionUserId: string,
    itemId: string,
    options: {
      profile?: Record<string, unknown>;
      audioStreamIndex?: number;
      subtitleStreamIndex?: number;
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

    if (typeof options.subtitleStreamIndex === 'number') {
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

  public reportPlaying(itemId: string, payload: { PlaySessionId: string; PositionTicks: number }) {
    return this.sendReport<Record<string, unknown>>('Sessions/Playing', {
      ItemId: itemId,
      ...payload
    });
  }

  public reportProgress(itemId: string, payload: { PlaySessionId: string; PositionTicks: number; IsPaused?: boolean }) {
    return this.sendReport<Record<string, unknown>>('Sessions/Playing/Progress', {
      ItemId: itemId,
      ...payload
    });
  }

  public reportStopped(itemId: string, payload: { PlaySessionId: string; PositionTicks: number }) {
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
