export type PtvFocusDirection = 'up' | 'down' | 'left' | 'right';
export type PtvItemKind =
  | 'Movie'
  | 'Series'
  | 'Episode'
  | 'Season'
  | 'Person'
  | 'MusicArtist'
  | 'MusicAlbum'
  | 'Audio'
  | 'Book'
  | 'Playlist'
  | 'Game'
  | 'PhotoAlbum'
  | 'Folder'
  | 'Collection'
  | 'Channel'
  | 'Unknown';

export type PtvHomeSectionStyle = 'poster' | 'portrait' | 'landscape';

export interface PtvItem {
  id: string;
  name: string;
  type: PtvItemKind;
  mediaType?: string;

  seriesId?: string;
  seriesName?: string;

  seasonId?: string;
  seasonName?: string;

  parentId?: string;
  indexNumber?: number;
  parentIndexNumber?: number;

  productionYear?: number;
  overview?: string;
  runTimeTicks?: number;

  imageTags?: Record<string, string>;
  backdropImageTags?: string[];

  playbackPositionTicks?: number;
  played?: boolean;
  favorite?: boolean;
}

export interface PtvLibrary {
  id: string;
  name: string;
  collectionType?: string | null;
  mediaTypes?: string[];
}

export interface PtvHomeSection {
  id: string;
  title: string;
  items: PtvItem[];
  loading: boolean;
  error?: string;
  style: PtvHomeSectionStyle;
  supportsMore?: boolean;
}

export interface PtvNavigationIntent {
  kind: 'home' | 'movies' | 'shows' | 'search' | 'details' | 'settings' | 'playback';
  targetId?: string | null;
  metadata?: {
    itemType?: PtvItemKind | null;
    serverId?: string | null;
    rowId?: string | null;
  };
}

export interface PtvPlaybackIntent {
  kind: 'movie' | 'series' | 'audio' | 'book';
  itemId: string;
  serverId: string;
  userId: string;
  startPositionTicks?: number;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}

export interface PtvServerSession {
  serverId: string;
  baseUrl: string;
  serverName?: string;
  serverVersion?: string;
  connectedAt: number;
  lastValidatedAt?: number;
}

export interface PtvUserSession {
  userId: string;
  userName: string;
  accessToken: string;
  serverId: string;
  serverUrl: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PtvServerCapabilities {
  version: string;
  features: PtvCapability[];
  plugin?: {
    version?: string | null;
    endpointAvailable: boolean;
    lastDiscoveredAt: number;
  };
}

export interface PtvCapability {
  id: string;
  label: string;
  enabled: boolean;
  details?: Record<string, unknown>;
}

export type PtvErrorKind =
  | 'network-unavailable'
  | 'server-unreachable'
  | 'authentication-failed'
  | 'session-expired'
  | 'request-timeout'
  | 'server-error'
  | 'malformed-json'
  | 'cancelled-request'
  | 'stale-response'
  | 'invalid-server-response'
  | 'unsupported-media'
  | 'playback-failed'
  | 'transcode-failed'
  | 'image-failed'
  | 'plugin-unavailable'
  | 'permission-denied'
  | 'unknown';

export interface PtvError {
  kind: PtvErrorKind;
  message: string;
  code?: number;
  requestId?: string;
  recoverable: boolean;
}

export interface PtvDiagnosticsSnapshot {
  appVersion: string;
  buildTimestamp: string;
  commitHash?: string | null;
  mode: 'development' | 'production';
  webosVersion?: string | null;
  tvModel?: string | null;
  viewport: string;
  dpr: number;
  serverVersion?: string | null;
  serverUrl: string;
  userId: string;
  pluginVersion?: string | null;
  pluginApiVersion?: string | null;
  capabilities: string[];
  currentRoute: string;
  currentFocusId: string | null;
  previousFocusId: string | null;
  activeRequests: number;
  peakConcurrentRequests?: number;
  activeFailures: string[];
  averageRequestDuration?: number;
  failedRequestCount?: number;
  cancelledRequestCount?: number;
  timeoutRequestCount?: number;
  duplicateRequestCount?: number;
  slowestRequestMs?: number;
  requestDurations: number[];
  recentFailures: string[];
  recentCompletions?: Array<{
    id: string;
    url: string;
    method: string;
    status?: number;
    durationMs?: number;
    error?: string;
    timedOut?: boolean;
    cancelled?: boolean;
    category?: string;
    route?: string;
    contentType?: string;
    parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network';
  }>;
  memoryEstimate?: number | null;
  playbackState: string;
  playbackDecision?: string | null;
  mediaCodecs?: string;
  currentPositionTicks?: number | null;
  lastLifecycleEvent?: string | null;
  lastPlaybackError?: string | null;
  lastUiError?: string | null;
  authentication?: Record<string, unknown> | null;
  playbackDetails?: Record<string, unknown> | null;
  recentFocusTransitions?: Array<Record<string, unknown>>;
}

export interface PtvRoute {
  screen:
    | 'startup'
    | 'server'
    | 'auth'
    | 'quick-connect'
    | 'home'
    | 'movies'
    | 'shows'
    | 'search'
    | 'details'
    | 'settings'
    | 'diagnostics'
    | 'playback';
  itemId?: string | null;
  sectionId?: string | null;
}
