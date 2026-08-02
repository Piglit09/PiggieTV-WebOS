import type { PtvItemKind } from '../../types/ptv';

export interface PtvSystemInfo {
  LocalAddress?: string;
  ServerName: string;
  ServerId: string;
  Version: string;
  WebSocketPort?: number;
}

export interface PtvAuthenticateResponse {
  ServerId: string;
  AccessToken: string;
  User: {
    Id: string;
    Name: string;
    PrimaryImageTag?: string | null;
  };
}

export interface PtvServerIdentity {
  serverId: string;
  serverName: string;
  serverVersion: string;
  baseUrl: string;
}

export interface PtvAuthSession {
  serverId: string;
  serverUrl: string;
  userId: string;
  userName: string;
  accessToken: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PtvPlaybackSourceStream {
  Index?: number;
  Type: 'Audio' | 'Video' | 'Subtitle';
  DisplayTitle?: string | null;
  Codec?: string | null;
  Language?: string | null;
  DeliveryMethod?: string | null;
  IsDefault?: boolean;
}

export interface PtvPlaybackMediaSource {
  Id: string;
  Container?: string | null;
  SupportsDirectPlay: boolean;
  SupportsDirectStream: boolean;
  SupportsTranscoding: boolean;
  IsRemote?: boolean;
  MediaStreams?: PtvPlaybackSourceStream[];
  DirectStreamUrl?: string | null;
  TranscodingUrl?: string | null;
  Bitrate?: number;
  Width?: number | null;
  Height?: number | null;
  VideoCodec?: string | null;
  AudioCodec?: string | null;
}

export interface PtvPlaybackInfoResponse {
  PlaySessionId?: string;
  MediaSources?: PtvPlaybackMediaSource[];
}

export interface PtvImageQuery {
  maxWidth?: number;
  quality?: number;
  tag?: string;
}

export interface PtvItemFields {
  Id: string;
  Name: string;
  Type: PtvItemKind;
  ParentId?: string;
  ServerId?: string;
}

export interface PtvPlaybackReport {
  ItemId: string;
  PlaySessionId: string;
  PositionTicks: number;
  IsPaused?: boolean;
  MediaSourceId?: string;
  MediaSourceId2?: string;
}

export interface PtvItemListResponse<T> {
  Items: T[];
  TotalRecordCount?: number;
}
