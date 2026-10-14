import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { chooseBestPlaybackSource } from '../../playback/decision';
import {
  PlaybackEngine,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackEngineState
} from '../../playback/engine';
import { mapPtvItems } from '../../api/jellyfin/mappers';
import { FocusableButton } from '../../components/FocusableButton';
import { formatMediaDuration, formatMediaTime } from '../../utils/format';
import { buildRoute, playbackRouteFromIntent, toRouteString } from '../../navigation/router';
import { redactSensitiveText } from '../../core/redaction';
import type { PtvPlaybackIntent, PtvPlaybackQueueItem } from '../../types/ptv';
import {
  isTrackIndexAvailable,
  parsePlaybackTrackOptions,
  pickDefaultAudioTrackIndex,
  pickDefaultSubtitleTrackIndex,
  type PlaybackTrackOption
} from '../../playback/tracks';

type PlaybackRuntime = {
  client: ReturnType<ReturnType<typeof useApp>['services']['jellyfin']['getClient']>;
  itemId: string;
  userId: string;
  settings: ReturnType<typeof useApp>['state']['settings'];
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
} | null;

type ActivePlaybackRuntime = Exclude<PlaybackRuntime, null>;
type PlaybackReportingRuntime = Pick<ActivePlaybackRuntime, 'client' | 'itemId'>;

const emptySnapshot: PlaybackDiagnosticsSnapshot = {
  attemptId: null,
  activeAttemptId: null,
  state: 'idle',
  itemIdSuffix: null,
  mediaSourceIdSuffix: null,
  container: null,
  videoCodec: null,
  audioCodec: null,
  sourceContainer: null,
  sourceVideoCodec: null,
  sourceAudioCodec: null,
  requestedOutputProtocol: null,
  requestedOutputContainer: null,
  requestedOutputVideoCodec: null,
  requestedOutputAudioCodec: null,
  selectedOutputProtocol: null,
  selectedOutputContainer: null,
  selectedOutputVideoCodec: null,
  selectedOutputAudioCodec: null,
  selectedOutputEvidence: null,
  decision: null,
  finalUrlOrigin: null,
  finalUrlPathCategory: null,
  readyState: 0,
  networkState: 0,
  currentTime: 0,
  duration: null,
  paused: true,
  ended: false,
  canSeek: false,
  bufferedRanges: { count: 0, ranges: [], totalSeconds: 0, truncated: false },
  seekableRanges: { count: 0, ranges: [], totalSeconds: 0, truncated: false },
  sourcePresent: false,
  progressReportingActive: false,
  lastStopReason: null,
  lastMediaEvent: null,
  mediaEventHistory: [],
  mediaEventHistoryTruncated: false,
  mediaEventCounts: {},
  lastMediaErrorCode: null,
  lastMediaErrorMessage: null,
  lastPlayPromiseResult: null,
  lastPlayPromiseError: null,
  lastPlayerError: null,
  sourceAssignments: 0,
  loadCalls: 0,
  playCalls: 0,
  playingReports: 0,
  progressReports: 0,
  stoppedReports: 0,
  reportEvidence: {
    queued: { playing: 0, progress: 0, stopped: 0 },
    attempted: { playing: 0, progress: 0, stopped: 0 },
    succeeded: { playing: 0, progress: 0, stopped: 0 },
    failed: { playing: 0, progress: 0, stopped: 0 },
    skipped: { playing: 0, progress: 0, stopped: 0 },
    last: null
  }
};

const NETWORK_MEDIA_ERROR_CODE = 2;
const DECODE_MEDIA_ERROR_CODE = 3;
const UNSUPPORTED_SOURCE_MEDIA_ERROR_CODE = 4;
const MAX_NETWORK_PLAYBACK_RETRIES = 2;
const NETWORK_RETRY_DELAYS_MS = [750, 2_000] as const;
const MIN_PLAYBACK_STALL_RECOVERY_MS = 15_000;
const RECENT_PLAYBACK_STALL_WINDOW_MS = 2 * 60 * 1_000;

function episodeContext(item: { seriesName?: string | null; seasonName?: string | null; parentIndexNumber?: number | null; indexNumber?: number | null }) {
  const number = item.parentIndexNumber && item.indexNumber
    ? `S${item.parentIndexNumber} E${item.indexNumber}`
    : item.indexNumber
      ? `Episode ${item.indexNumber}`
      : item.seasonName ?? null;
  return [item.seriesName, number].filter(Boolean).join(' - ') || undefined;
}

function deriveEpisodeLabel(intent: PtvPlaybackIntent) {
  if (!intent.context) return null;
  const match = intent.context.match(/S(\d+)\s*E(\d+)/i);
  if (!match) return null;
  const [, seasonRaw, episodeRaw] = match;
  const season = Number.parseInt(seasonRaw ?? '', 10);
  const episode = Number.parseInt(episodeRaw ?? '', 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}



type PlayerIconProps = {
  size?: number;
};

function PlayIcon({ size = 26 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon({ size = 26 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z" />
    </svg>
  );
}

function RewindIcon({ size = 28 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11 18V6l-8.5 6L11 18zm10 0V6l-8.5 6L21 18z" />
    </svg>
  );
}

function ForwardIcon({ size = 28 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M13 6v12l8.5-6L13 6zM3 6v12l8.5-6L3 6z" />
    </svg>
  );
}

function PreviousIcon({ size = 28 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M6 5h2v14H6zm3 7 9 7V5l-9 7z" />
    </svg>
  );
}

function NextIcon({ size = 28 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M16 5h2v14h-2zm-10 0v14l9-7-9-7z" />
    </svg>
  );
}

function BackIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 18l-6-6 6-6"
      />
    </svg>
  );
}

function ReplayIcon({ size = 28 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 5a7 7 0 1 1-6.32 4H8L4.5 5.5 1 9h2.66A9 9 0 1 0 12 3v2z" />
    </svg>
  );
}

function HeartIcon({ size = 25, filled = false }: PlayerIconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        d="M12 20.5s-8-4.6-8-10.4C4 6.7 6.3 5 8.7 5c1.5 0 2.7.7 3.3 1.8C12.6 5.7 13.8 5 15.3 5 17.7 5 20 6.7 20 10.1c0 5.8-8 10.4-8 10.4z"
      />
    </svg>
  );
}

function AudioIcon({ size = 26 }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8v2.1a7 7 0 0 1 0 11.8V20a9 9 0 0 0 0-16z" />
    </svg>
  );
}

function normalizePlaybackErrorMessage(message: string) {
  return message
    .replace(/DEMUXER_ERROR_COULD_NOT_PARDE/i, 'DEMUXER_ERROR_COULD_NOT_PARSE')
    .replace(/PiplineStatus::/i, 'PipelineStatus::');
}

function isPlaybackFormatError(
  message: string,
  snapshot?: PlaybackDiagnosticsSnapshot | null
) {
  return snapshot?.lastMediaErrorCode === UNSUPPORTED_SOURCE_MEDIA_ERROR_CODE
    || /DEMUXER_ERROR_COULD_NOT_PARSE|MEDIA_ELEMENT_ERROR:\s*Format error|MEDIA_ERR_SRC_NOT_SUPPORTED/i.test(message);
}

function hasRecentPlaybackStall(snapshot?: PlaybackDiagnosticsSnapshot | null) {
  if (!snapshot || snapshot.lastMediaErrorCode !== DECODE_MEDIA_ERROR_CODE) return false;

  const errorEvent = [...snapshot.mediaEventHistory]
    .reverse()
    .find(event => event.event === 'error');
  if (!errorEvent) return false;

  return [...snapshot.mediaEventHistory]
    .reverse()
    .some(event => (
      (event.event === 'waiting' || event.event === 'stalled')
      && errorEvent.timestamp >= event.timestamp
      && errorEvent.timestamp - event.timestamp >= MIN_PLAYBACK_STALL_RECOVERY_MS
      && errorEvent.timestamp - event.timestamp <= RECENT_PLAYBACK_STALL_WINDOW_MS
    ));
}

function isNetworkPlaybackError(
  message: string,
  snapshot?: PlaybackDiagnosticsSnapshot | null
) {
  return snapshot?.lastMediaErrorCode === NETWORK_MEDIA_ERROR_CODE
    || /network|connection|failed to fetch|load failed|request timeout|server.*unreachable/i.test(message)
    || hasRecentPlaybackStall(snapshot);
}

function formatEpisodeHeaderTitle(intent: PtvPlaybackIntent | null, title: string) {
  if (!intent || !intent.context) return title;

  const episodeLabel = deriveEpisodeLabel(intent);
  if (!episodeLabel) return title;

  let cleaned = title.trim();

  const seriesName = intent.context
    ?.split(/\s+-\s+S\d+\s*E\d+/i)[0]
    ?.trim();

  if (
    seriesName &&
    cleaned.toLowerCase().startsWith(seriesName.toLowerCase())
  ) {
    cleaned = cleaned.slice(seriesName.length).trim();
    cleaned = cleaned.replace(/^[\s\-–—:·]+/, '');
  }

  const stripped = cleaned
    .replace(/^S\d{1,3}\s*E\d{1,3}\s*[-–—:·]\s*/i, '')
    .replace(/^.*?\s*[-–—:]\s*S\d{1,3}\s*E\d{1,3}\s*[-–—:]\s*/i, '')
    .replace(/\s+(?:WEB[\s._-]?DL|WEBRIP|BLURAY|BDRIP|HDTV)[\s._-]*(?:2160P|1080P|720P|480P).*$/i, '')
    .replace(/[\s._-]+(?:2160p|1080p|720p|480p)\s*$/i, '')
    .trim();

  if (stripped !== cleaned) {
    return stripped || title;
  }

  return title;
}

function coerceQueueIndex(intent: PtvPlaybackIntent | null, queueLength: number) {
  if (!intent?.queue || queueLength < 1) return -1;
  const currentIndex = intent.queue.index;
  if (typeof currentIndex === 'number' && Number.isFinite(currentIndex) && currentIndex >= 0 && currentIndex < queueLength) {
    return currentIndex;
  }
  const matching = intent.queue.items.findIndex(item => item.itemId === intent.itemId);
  return matching >= 0 ? matching : 0;
}

function playbackIntentAtQueueIndex(
  intent: PtvPlaybackIntent,
  queueItems: PtvPlaybackQueueItem[],
  targetIndex: number
) {
  if (targetIndex < 0 || targetIndex >= queueItems.length) return null;
  const track = queueItems[targetIndex];
  if (!track?.itemId) return null;
  return {
    kind: intent.kind,
    itemId: track.itemId,
    seriesId: track.seriesId ?? intent.seriesId,
    serverId: intent.serverId,
    userId: intent.userId,
    title: track.title || intent.title,
    context: track.context ?? intent.context,
    artist: track.artist ?? intent.artist,
    album: track.album ?? intent.album,
    albumId: track.albumId ?? intent.albumId,
    logoUrl: track.logoUrl ?? intent.logoUrl,
    artworkUrl: track.artworkUrl ?? intent.artworkUrl,
    startPositionTicks: track.startPositionTicks,
    queue: {
      items: queueItems,
      index: targetIndex
    }
  } satisfies PtvPlaybackIntent;
}

export function PlaybackScreen() {
  const { state, dispatch, services } = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const runtimeRef = useRef<PlaybackRuntime>(null);
  const reportingRuntimeByAttemptRef = useRef<Map<string, PlaybackReportingRuntime>>(new Map());
  const engineRef = useRef<PlaybackEngine | null>(null);
  const playerStateRef = useRef<PlaybackEngineState>('idle');
  const autoAdvanceControllerRef = useRef<AbortController | null>(null);
  const autoAdvanceStartedForItemRef = useRef<string | null>(null);
  const formatFallbackByItemRef = useRef<Set<string>>(new Set());
  const formatFallbackItemIdRef = useRef<string | null>(null);
  const networkRetryCountByItemRef = useRef<Map<string, number>>(new Map());
  const networkRetryTimerRef = useRef<number | null>(null);

  const [playerState, setPlayerState] = useState<PlaybackEngineState>('idle');
  const [endedItemId, setEndedItemId] = useState<string | null>(null);
  const [autoAdvancePending, setAutoAdvancePending] = useState(false);
  const [snapshot, setSnapshot] = useState<PlaybackDiagnosticsSnapshot>(emptySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [liked, setLiked] = useState(false);
  const [audioTrackOptions, setAudioTrackOptions] = useState<PlaybackTrackOption[]>([]);
  const [subtitleTrackOptions, setSubtitleTrackOptions] = useState<PlaybackTrackOption[]>([]);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState<number | null>(null);
  const [selectedSubtitleTrackIndex, setSelectedSubtitleTrackIndex] = useState<number | null>(null);
  const [isSubtitleMenuOpen, setIsSubtitleMenuOpen] = useState(false);
  const [isAudioMenuOpen, setIsAudioMenuOpen] = useState(false);

  const intent = state.playbackIntent;
  const userSession = state.userSession;
  const isAudio = intent?.kind === 'audio';
  const isNowPlayingRoute = state.route.screen === 'playback'
    && isAudio
    && state.route.sectionId === 'now-playing';
  const playbackRouteMode = isNowPlayingRoute ? 'now-playing' : 'mini';
  const isMiniPlayer = isAudio && !isNowPlayingRoute;
  const isPlaybackRoute = state.route.screen === 'playback';
  const shouldRenderVideoControls = !isMiniPlayer;
  const advanceAudioPlayback = useCallback((nextIntent: PtvPlaybackIntent) => {
    if (state.route.screen === 'playback') {
      dispatch({
        type: 'advance_playback',
        playbackIntent: nextIntent,
        route: playbackRouteFromIntent(nextIntent, playbackRouteMode)
      });
      return;
    }
    dispatch({ type: 'set_playback_intent', playbackIntent: nextIntent });
  }, [dispatch, playbackRouteMode, state.route.screen]);
  const rawQueueItems = intent?.queue?.items ?? null;
  const queueItemsWithTracks = useMemo(() => (
    (rawQueueItems ?? []).filter((track): track is PtvPlaybackQueueItem => Boolean(track))
  ), [rawQueueItems]);
  const queueLength = queueItemsWithTracks.length;
  const activeQueueIndex = coerceQueueIndex(intent, queueLength);
  const canGoPrevious = activeQueueIndex > 0;
  const canGoNext = activeQueueIndex >= 0 && activeQueueIndex < queueLength - 1;
  const playbackTitle = intent?.title?.trim() || 'Now Playing';
  const playbackContext = intent?.context?.trim();
  const playbackArtist = intent?.artist?.trim();
  const playbackAlbum = intent?.album?.trim();
  const playbackArtwork = intent?.artworkUrl ?? null;
  const playbackLogo = intent?.logoUrl ?? null;
  const isEpisode = intent?.kind === 'episode';
  const headerTitle = useMemo(() => (
    isEpisode ? formatEpisodeHeaderTitle(intent, playbackTitle) : playbackTitle
  ), [isEpisode, intent, playbackTitle]);
  const shouldShowPlaybackContext = Boolean(playbackContext);
  playerStateRef.current = playerState;

  const retryNetworkPlayback = useCallback((itemId: string, positionSeconds: number) => {
    const previousRetryCount = networkRetryCountByItemRef.current.get(itemId) ?? 0;
    if (previousRetryCount >= MAX_NETWORK_PLAYBACK_RETRIES || networkRetryTimerRef.current !== null) {
      return false;
    }

    networkRetryCountByItemRef.current.set(itemId, previousRetryCount + 1);
    setError(`Connection interrupted. Retrying playback (${previousRetryCount + 1}/${MAX_NETWORK_PLAYBACK_RETRIES})…`);
    const delayMs = NETWORK_RETRY_DELAYS_MS[previousRetryCount]
      ?? NETWORK_RETRY_DELAYS_MS[NETWORK_RETRY_DELAYS_MS.length - 1]
      ?? 2_000;
    networkRetryTimerRef.current = window.setTimeout(() => {
      networkRetryTimerRef.current = null;
      const engine = engineRef.current;
      if (!engine || runtimeRef.current?.itemId !== itemId) return;
      void (async () => {
        // Media teardown is synchronous. Do not hold stream recovery behind a
        // stalled telemetry request; the old attempt's reports remain queued.
        void engine.stop('superseded');
        if (runtimeRef.current?.itemId !== itemId) return;
        await engine.start({
          itemId,
          startPositionSeconds: Math.max(0, positionSeconds)
        }).catch(() => {});
      })();
    }, delayMs);
    return true;
  }, []);

  if (intent && userSession && state.serverUrl) {
    runtimeRef.current = {
      client: services.jellyfin.getAuthenticatedClient(),
      itemId: intent.itemId,
      userId: intent.userId,
      settings: state.settings,
      audioStreamIndex: intent.audioStreamIndex,
      subtitleStreamIndex: intent.subtitleStreamIndex
    };
  } else {
    runtimeRef.current = null;
  }

  useEffect(() => {
    if (!intent) return;
    setSelectedAudioTrackIndex(
      typeof intent.audioStreamIndex === 'number' ? intent.audioStreamIndex : null
    );
    setSelectedSubtitleTrackIndex(
      typeof intent.subtitleStreamIndex === 'number' ? intent.subtitleStreamIndex : null
    );
    setIsAudioMenuOpen(false);
    setIsSubtitleMenuOpen(false);
  }, [intent]);

  if (!engineRef.current) {
    engineRef.current = new PlaybackEngine(
      services.diagnostics,
      {
        onPlayState: next => {
          if (next !== 'stopped') {
            if (next !== 'ended') {
              autoAdvanceControllerRef.current?.abort('playback-state-changed');
              autoAdvanceControllerRef.current = null;
            }
            setPlayerState(next);
            setEndedItemId(next === 'ended' ? runtimeRef.current?.itemId ?? null : null);
            if (next === 'playing') setError(null);
          }
        },
        onError: message => {
          const normalizedMessage = normalizePlaybackErrorMessage(message);
          const currentItemId = runtimeRef.current?.itemId;
          const engineSnapshot = engineRef.current?.getDiagnosticsSnapshot();

          if (
            currentItemId
            && isNetworkPlaybackError(normalizedMessage, engineSnapshot)
            && retryNetworkPlayback(currentItemId, engineSnapshot?.currentTime ?? 0)
          ) {
            return;
          }

          if (
            currentItemId
            && isPlaybackFormatError(normalizedMessage, engineSnapshot)
            && !formatFallbackByItemRef.current.has(currentItemId)
          ) {
            formatFallbackByItemRef.current.add(currentItemId);
            setError(redactSensitiveText('Playback format is not supported directly. Retrying with a compatible stream...'));

            const engine = engineRef.current;
            const positionSeconds = Math.max(0, engineSnapshot?.currentTime ?? 0);
            // Media teardown is synchronous. Keep compatibility recovery out
            // of the playback-report queue so slow telemetry cannot stall it.
            void engine?.stop('superseded');
            if (engine && runtimeRef.current?.itemId === currentItemId) {
              void engine.start({
                itemId: currentItemId,
                startPositionSeconds: positionSeconds
              }).catch(() => {});
            }

            return;
          }

          setError(redactSensitiveText(normalizedMessage));
        },
        onDiagnostics: next => {
          setSnapshot(next);
          services.diagnostics.recordPlaybackSnapshot({ ...next });
        }
      },
      {
        resolveSource: async (request, context) => {
          const runtime = runtimeRef.current;
          if (!runtime || runtime.itemId !== request.itemId) {
            throw new Error('Playback session is no longer active');
          }

          const forceTranscode = formatFallbackByItemRef.current.has(runtime.itemId);
          const playbackSelectionInput = {
            preferredMode: forceTranscode ? 'transcode' as const : undefined,
            preferDirectPlay: forceTranscode ? false : runtime.settings.directPlayEnabled,
            preferDirectStream: forceTranscode ? false : runtime.settings.directStreamEnabled,
            allowTranscode: forceTranscode || runtime.settings.transcodeEnabled
          };

          const requestPlaybackInfo = async (
            audioStreamIndex: number | null | undefined,
            subtitleStreamIndex: number | null | undefined
          ) => runtime.client.getPlaybackInfo(
            runtime.userId,
            request.itemId,
            {
              audioStreamIndex: typeof audioStreamIndex === 'number' ? audioStreamIndex : undefined,
              subtitleStreamIndex: subtitleStreamIndex === null
                ? null
                : typeof subtitleStreamIndex === 'number'
                  ? subtitleStreamIndex
                  : undefined,
              enableDirectPlay: playbackSelectionInput.preferDirectPlay,
              enableDirectStream: playbackSelectionInput.preferDirectStream,
              enableTranscoding: playbackSelectionInput.allowTranscode,
              allowVideoStreamCopy: !forceTranscode,
              allowAudioStreamCopy: !forceTranscode
            },
            context.signal
          );

          const runtimeAudioTrack = typeof runtime.audioStreamIndex === 'number' ? runtime.audioStreamIndex : null;
          const runtimeSubtitleTrack = runtime.subtitleStreamIndex;

          let playbackInfo = await requestPlaybackInfo(runtimeAudioTrack, runtimeSubtitleTrack);
          if (context.signal.aborted) throw new DOMException('Playback superseded', 'AbortError');

          let decision = chooseBestPlaybackSource(playbackInfo, playbackSelectionInput);
          let source = playbackInfo.MediaSources?.find(candidate => candidate.Id === decision.mediaSourceId);
          if (!source) throw new Error('Jellyfin did not return a playable media source');

          let tracks = parsePlaybackTrackOptions(source);
          let resolvedAudioTrack = pickDefaultAudioTrackIndex(tracks.audio, runtimeAudioTrack);
          let resolvedSubtitleTrack = pickDefaultSubtitleTrackIndex(
            tracks.subtitles,
            runtimeSubtitleTrack,
            runtime.settings.subtitleDefaultOff
          );

          const audioSelectionChanged = tracks.audio.length > 0
            && resolvedAudioTrack !== runtimeAudioTrack;
          const subtitleSelectionChanged = tracks.subtitles.length > 0
            && resolvedSubtitleTrack !== runtimeSubtitleTrack;

          if (audioSelectionChanged || subtitleSelectionChanged) {
            playbackInfo = await requestPlaybackInfo(resolvedAudioTrack, resolvedSubtitleTrack);
            if (context.signal.aborted) throw new DOMException('Playback superseded', 'AbortError');
            decision = chooseBestPlaybackSource(playbackInfo, playbackSelectionInput);
            source = playbackInfo.MediaSources?.find(candidate => candidate.Id === decision.mediaSourceId);
            if (!source) throw new Error('Jellyfin did not return a playable media source');
            tracks = parsePlaybackTrackOptions(source);
            resolvedAudioTrack = pickDefaultAudioTrackIndex(tracks.audio, resolvedAudioTrack);
            resolvedSubtitleTrack = pickDefaultSubtitleTrackIndex(
              tracks.subtitles,
              resolvedSubtitleTrack,
              runtime.settings.subtitleDefaultOff
            );
          }

          setAudioTrackOptions(tracks.audio);
          setSubtitleTrackOptions(tracks.subtitles);

          const selectedAudioTrackIndex = isTrackIndexAvailable(tracks.audio, resolvedAudioTrack)
            ? resolvedAudioTrack
            : tracks.audio[0]?.index ?? null;
          const selectedSubtitleTrackIndex = isTrackIndexAvailable(tracks.subtitles, resolvedSubtitleTrack)
            ? resolvedSubtitleTrack
            : null;

          setSelectedAudioTrackIndex(selectedAudioTrackIndex);
          setSelectedSubtitleTrackIndex(selectedSubtitleTrackIndex);

          const sourceVideoStream = source.MediaStreams?.find(stream => stream.Type === 'Video');
          const sourceAudioStream = source.MediaStreams?.find(stream => (
            stream.Type === 'Audio' &&
            typeof selectedAudioTrackIndex === 'number' &&
            stream.Index === selectedAudioTrackIndex
          )) ?? source.MediaStreams?.find(stream => stream.Type === 'Audio' && stream.IsDefault)
            ?? source.MediaStreams?.find(stream => stream.Type === 'Audio');
          const sourceVideoCodec = source.VideoCodec ?? sourceVideoStream?.Codec ?? null;
          const sourceAudioCodec = source.AudioCodec ?? sourceAudioStream?.Codec ?? null;
          const streamUrl = runtime.client.resolvePlaybackStreamUrl(
            request.itemId,
            source,
            decision.mode
          );

          reportingRuntimeByAttemptRef.current.set(context.attemptId, {
            client: runtime.client,
            itemId: runtime.itemId
          });
          while (reportingRuntimeByAttemptRef.current.size > 8) {
            const oldestAttemptId = reportingRuntimeByAttemptRef.current.keys().next().value as string | undefined;
            if (!oldestAttemptId) break;
            reportingRuntimeByAttemptRef.current.delete(oldestAttemptId);
          }
          const transcodingRequested = decision.mode === 'transcode';
          return {
            url: streamUrl,
            playSessionId: playbackInfo.PlaySessionId ?? null,
            mediaSourceId: source.Id,
            mode: decision.mode,
            container: source.Container,
            videoCodec: sourceVideoCodec,
            audioCodec: sourceAudioCodec,
            sourceContainer: source.Container,
            sourceVideoCodec,
            sourceAudioCodec,
            requestedOutputProtocol: transcodingRequested ? 'hls' : 'http',
            requestedOutputContainer: transcodingRequested
              ? 'ts'
              : decision.mode === 'direct-play'
                ? source.Container
                : null,
            requestedOutputVideoCodec: transcodingRequested ? 'h264' : sourceVideoCodec,
            requestedOutputAudioCodec: transcodingRequested ? 'aac' : sourceAudioCodec,
            audioStreamIndex: selectedAudioTrackIndex,
            subtitleStreamIndex: selectedSubtitleTrackIndex
          };
        },
        reportPlaying: async report => {
          const runtime = reportingRuntimeByAttemptRef.current.get(report.attemptId);
          if (!runtime) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          if (runtime.itemId !== report.itemId) return { status: 'skipped' as const, reason: 'attempt-item-mismatch' };
          if (!report.playSessionId) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          await runtime.client.reportPlaying(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks,
            MediaSourceId: report.mediaSourceId ?? undefined,
            PlayMethod: report.playMethod ?? undefined,
            CanSeek: report.canSeek,
            AudioStreamIndex: report.audioStreamIndex ?? undefined,
            SubtitleStreamIndex: report.subtitleStreamIndex ?? undefined,
            IsPaused: report.isPaused
          });
          return { status: 'sent' as const };
        },
        reportProgress: async report => {
          const runtime = reportingRuntimeByAttemptRef.current.get(report.attemptId);
          if (!runtime) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          if (runtime.itemId !== report.itemId) return { status: 'skipped' as const, reason: 'attempt-item-mismatch' };
          if (!report.playSessionId) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          await runtime.client.reportProgress(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks,
            MediaSourceId: report.mediaSourceId ?? undefined,
            PlayMethod: report.playMethod ?? undefined,
            CanSeek: report.canSeek,
            AudioStreamIndex: report.audioStreamIndex ?? undefined,
            SubtitleStreamIndex: report.subtitleStreamIndex ?? undefined,
            IsPaused: report.isPaused
          });
          return { status: 'sent' as const };
        },
        reportStopped: async report => {
          const runtime = reportingRuntimeByAttemptRef.current.get(report.attemptId);
          try {
            if (!runtime) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
            if (runtime.itemId !== report.itemId) return { status: 'skipped' as const, reason: 'attempt-item-mismatch' };
            if (!report.playSessionId) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
            await runtime.client.reportStopped(report.itemId, {
              PlaySessionId: report.playSessionId,
              PositionTicks: report.positionTicks,
              MediaSourceId: report.mediaSourceId ?? undefined
            });
            return { status: 'sent' as const };
          } finally {
            reportingRuntimeByAttemptRef.current.delete(report.attemptId);
          }
        }
      }
    );
  }

  const hideControls = useCallback(() => {
    if (
      !isPlaybackRoute ||
      !shouldRenderVideoControls ||
      ![
        'playing',
        'buffering'
      ].includes(playerStateRef.current)
    ) {
      return;
    }

    setControlsVisible(false);
    services.focusManager.focus('playback-surface', {
      routeId: toRouteString(state.route),
      reason: 'direct'
    });
  }, [
    isPlaybackRoute,
    services.focusManager,
    shouldRenderVideoControls,
    state.route
  ]);

  const hideControlsTimer = useRef<number | null>(null);
  const isControlsAutoHideActive = playerState === 'playing' || playerState === 'buffering';
  const playbackStateRef = useRef<PlaybackEngineState>('idle');
  const lastMouseMoveAtRef = useRef(0);

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimer.current !== null) {
      window.clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    clearHideControlsTimer();
    if (!isControlsAutoHideActive || !shouldRenderVideoControls || !isPlaybackRoute) {
      return;
    }

    hideControlsTimer.current = window.setTimeout(() => {
      hideControlsTimer.current = null;
      hideControls();
    }, 4_500);
  }, [clearHideControlsTimer, hideControls, isControlsAutoHideActive, isPlaybackRoute, shouldRenderVideoControls]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    return () => {
      clearHideControlsTimer();
    };
  }, [clearHideControlsTimer]);

  type PtvRemoteInputDetail = {
    source?: 'user' | 'system';
    action?: { kind: 'move' | 'activate' | 'back'; direction?: string; key?: string };
    repeat?: boolean;
    key?: string;
  };

  useEffect(() => {
    const onRemoteActivity = (event: Event) => {
      const remoteInput = event as CustomEvent<PtvRemoteInputDetail>;
      if (!isPlaybackRoute) return;
      if (remoteInput.detail?.source === 'system') return;
      if (remoteInput.detail?.repeat === true) return;
      showControls();
    };

    window.addEventListener('ptv-remote-input', onRemoteActivity);
    return () => window.removeEventListener('ptv-remote-input', onRemoteActivity);
  }, [showControls, isPlaybackRoute]);

  const handleMouseMove = useCallback(() => {
    const now = performance.now();
    if (now - lastMouseMoveAtRef.current < 300) return;
    lastMouseMoveAtRef.current = now;
    if (!isMiniPlayer) {
      showControls();
    }
  }, [isMiniPlayer, showControls]);

  useEffect(() => {
    if (!isPlaybackRoute || !intent || !shouldRenderVideoControls) {
      clearHideControlsTimer();
      playbackStateRef.current = playerState;
      setControlsVisible(true);
      return;
    }

    if (playbackStateRef.current === playerState) return;
    playbackStateRef.current = playerState;

    if (isControlsAutoHideActive) {
      showControls();
      return;
    }
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [
    clearHideControlsTimer,
    isPlaybackRoute,
    playerState,
    shouldRenderVideoControls,
    isControlsAutoHideActive,
    showControls,
    intent
  ]);


  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!shouldRenderVideoControls) return;
    return services.focusManager.register({
      id: 'playback-surface',
      routeId: toRouteString(state.route),
      ref: video,
      activate: () => true
    });
  }, [services.focusManager, shouldRenderVideoControls, state.route]);

  useEffect(() => services.playback.registerStopOwner(reason => (
    engineRef.current?.stop(reason)
  )), [services.playback]);

  useEffect(() => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video || !intent || !userSession) return;
    setError(null);
    if (formatFallbackItemIdRef.current !== intent.itemId) {
      formatFallbackByItemRef.current.clear();
      formatFallbackItemIdRef.current = intent.itemId;
    }
    networkRetryCountByItemRef.current.delete(intent.itemId);
    if (networkRetryTimerRef.current !== null) {
      window.clearTimeout(networkRetryTimerRef.current);
      networkRetryTimerRef.current = null;
    }
    setAutoAdvancePending(false);
    setControlsVisible(true);
    engine.attach(video);
    void engine.start({
      itemId: intent.itemId,
      startPositionSeconds: intent.startPositionTicks
        ? intent.startPositionTicks / 10_000_000
        : 0
    }).catch(cause => {
      if (engine.getActiveAttemptId()) {
        const message = cause instanceof Error
          ? cause.message
          : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
            ? cause.message
            : 'Playback failed';
        const normalizedMessage = normalizePlaybackErrorMessage(String(message));
        const currentItemId = runtimeRef.current?.itemId;
        const engineSnapshot = engine.getDiagnosticsSnapshot();
        if (
          currentItemId
          && isNetworkPlaybackError(normalizedMessage, engineSnapshot)
          && retryNetworkPlayback(currentItemId, engineSnapshot.currentTime)
        ) {
          return;
        }
        if (
          currentItemId &&
          isPlaybackFormatError(normalizedMessage, engineSnapshot) &&
          !formatFallbackByItemRef.current.has(currentItemId)
        ) {
          formatFallbackByItemRef.current.add(currentItemId);
          setError(redactSensitiveText('Playback format is not supported directly. Retrying with a compatible stream...'));
          const positionSeconds = Math.max(0, engineSnapshot.currentTime);
          void engine.stop('superseded');
          if (runtimeRef.current?.itemId === currentItemId) {
            void engine.start({
              itemId: currentItemId,
              startPositionSeconds: positionSeconds
            }).catch(() => {});
          }
        } else {
          setError(redactSensitiveText(normalizedMessage));
        }
      }
    });

    return () => {
      clearHideControlsTimer();
      if (networkRetryTimerRef.current !== null) {
        window.clearTimeout(networkRetryTimerRef.current);
        networkRetryTimerRef.current = null;
      }
      engine.detach();
    };
  }, [clearHideControlsTimer, intent, retryNetworkPlayback, userSession]);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    const seriesId = intent?.seriesId?.trim();
    if (
      !engine ||
      !intent ||
      intent.kind !== 'episode' ||
      !seriesId ||
      !userSession ||
      !state.settings.autoPlayNext ||
      state.route.screen !== 'playback' ||
      endedItemId !== intent.itemId ||
      autoAdvanceStartedForItemRef.current === intent.itemId
    ) return;

    const completedItemId = intent.itemId;
    autoAdvanceStartedForItemRef.current = completedItemId;
    const controller = new AbortController();
    autoAdvanceControllerRef.current?.abort('auto-advance-replaced');
    autoAdvanceControllerRef.current = controller;
    let active = true;
    setAutoAdvancePending(true);

    void (async () => {
      try {
        await engine.whenReportsSettled();
        if (
          !active ||
          controller.signal.aborted ||
          engine.getState() !== 'ended' ||
          runtimeRef.current?.itemId !== completedItemId
        ) return;

        const queuedNextIntent = intent.queue && canGoNext
          ? playbackIntentAtQueueIndex(intent, queueItemsWithTracks, activeQueueIndex + 1)
          : null;
        const runtime = runtimeRef.current;
        const response = queuedNextIntent
          ? null
          : await runtime.client.getNextUpForSeries(
            runtime.userId,
            seriesId,
            2,
            controller.signal
          );
        if (
          !active ||
          controller.signal.aborted ||
          engine.getState() !== 'ended' ||
          runtimeRef.current?.itemId !== completedItemId
        ) return;

        const nextEpisode = response ? mapPtvItems(response).find(candidate => (
          candidate.type === 'Episode' &&
          candidate.id !== completedItemId &&
          candidate.seriesId === seriesId
        )) : null;
        const nextIntent: PtvPlaybackIntent | null = queuedNextIntent ?? (nextEpisode ? {
          kind: 'episode',
          itemId: nextEpisode.id,
          seriesId: nextEpisode.seriesId ?? seriesId,
          serverId: intent.serverId,
          userId: intent.userId,
          title: nextEpisode.name,
          context: episodeContext(nextEpisode),
          logoUrl: intent.logoUrl,
          startPositionTicks: nextEpisode.playbackPositionTicks
        } : null);
        if (!nextIntent) return;
        setAutoAdvancePending(false);
        dispatch({
          type: 'advance_playback',
          playbackIntent: nextIntent,
          route: playbackRouteFromIntent(nextIntent, playbackRouteMode)
        });
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        services.diagnostics.logWarn('Auto-play next lookup failed', {
          error: redactSensitiveText(message)
        });
      } finally {
        if (autoAdvanceControllerRef.current === controller) {
          autoAdvanceControllerRef.current = null;
        }
        if (active) setAutoAdvancePending(false);
      }
    })();

    return () => {
      active = false;
      controller.abort('playback-route-changed');
      if (autoAdvanceControllerRef.current === controller) {
        autoAdvanceControllerRef.current = null;
      }
    };
  }, [
    dispatch,
    activeQueueIndex,
    canGoNext,
    endedItemId,
    intent,
    services.diagnostics,
    playbackRouteMode,
    queueItemsWithTracks,
    state.route.screen,
    state.settings.autoPlayNext,
    userSession
  ]);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (
      !engine ||
      !intent ||
      intent.kind !== 'audio' ||
      endedItemId !== intent.itemId ||
      !canGoNext ||
      autoAdvanceStartedForItemRef.current === intent.itemId
    ) return;

    const nextIntent = playbackIntentAtQueueIndex(intent, queueItemsWithTracks, activeQueueIndex + 1);
    if (!nextIntent) return;
    const completedItemId = intent.itemId;
    autoAdvanceStartedForItemRef.current = completedItemId;
    const controller = new AbortController();
    autoAdvanceControllerRef.current?.abort('audio-queue-advance-replaced');
    autoAdvanceControllerRef.current = controller;
    let active = true;
    setAutoAdvancePending(true);

    void (async () => {
      try {
        await engine.whenReportsSettled();
        if (
          !active ||
          controller.signal.aborted ||
          engine.getState() !== 'ended' ||
          runtimeRef.current?.itemId !== completedItemId
        ) return;

        setAutoAdvancePending(false);
        advanceAudioPlayback(nextIntent);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        services.diagnostics.logWarn('Audio queue auto-advance failed', {
          error: redactSensitiveText(cause instanceof Error ? cause.message : String(cause))
        });
      } finally {
        if (autoAdvanceControllerRef.current === controller) {
          autoAdvanceControllerRef.current = null;
        }
        if (active) setAutoAdvancePending(false);
      }
    })();

    return () => {
      active = false;
      controller.abort('audio-queue-route-changed');
      if (autoAdvanceControllerRef.current === controller) {
        autoAdvanceControllerRef.current = null;
      }
    };
  }, [
    activeQueueIndex,
    advanceAudioPlayback,
    canGoNext,
    endedItemId,
    intent,
    queueItemsWithTracks,
    services.diagnostics
  ]);

  const progressPercent = snapshot.duration && snapshot.duration > 0
    ? Math.max(0, Math.min(100, (snapshot.currentTime / snapshot.duration) * 100))
    : 0;

const playPauseIcon = useMemo(() => {
  if (autoAdvancePending) return <NextIcon />;
  return snapshot.paused ? <PlayIcon /> : <PauseIcon />;
}, [autoAdvancePending, snapshot.paused]);

const playbackToggleLabel = playerState === 'ended' ? 'Ended' : (snapshot.paused ? 'Play' : 'Pause');

  const loading = playerState === 'idle' || playerState === 'resolving' || playerState === 'loading' || playerState === 'ready';

  const togglePlayback = useCallback(() => {
    if (playerStateRef.current === 'ended' || playerStateRef.current === 'error') return;
    if (snapshot.paused) void engineRef.current?.play();
    else engineRef.current?.pause();
  }, [snapshot.paused]);

  const seekBack = useCallback(() => {
    if (snapshot.canSeek) engineRef.current?.seek(snapshot.currentTime - 30);
  }, [snapshot.canSeek, snapshot.currentTime]);

  const seekForward = useCallback(() => {
    if (snapshot.canSeek) engineRef.current?.seek(snapshot.currentTime + 30);
  }, [snapshot.canSeek, snapshot.currentTime]);

  const jumpToQueueIndex = useCallback((targetIndex: number) => {
    if (!intent || queueItemsWithTracks.length === 0) return;
    if (targetIndex < 0 || targetIndex >= queueItemsWithTracks.length || targetIndex === activeQueueIndex) return;
    const nextIntent = playbackIntentAtQueueIndex(intent, queueItemsWithTracks, targetIndex);
    if (!nextIntent) return;
    advanceAudioPlayback(nextIntent);
  }, [activeQueueIndex, advanceAudioPlayback, intent, queueItemsWithTracks]);

  const openNowPlaying = useCallback(() => {
    if (!intent) return;
    dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent, 'now-playing') });
  }, [dispatch, intent]);

  const closeTrackMenus = useCallback(() => {
    setIsAudioMenuOpen(false);
    setIsSubtitleMenuOpen(false);
  }, []);

  const withPlaybackStartPosition = useCallback((nextIntent: PtvPlaybackIntent) => {
    if (!Number.isFinite(snapshot.currentTime) || snapshot.currentTime <= 0) {
      return nextIntent;
    }
    return {
      ...nextIntent,
      startPositionTicks: Math.round(snapshot.currentTime * 10_000_000)
    };
  }, [snapshot.currentTime]);

  const updateTrackSelection = useCallback((patch: {
    audioStreamIndex?: number | null;
    subtitleStreamIndex?: number | null;
  }) => {
    if (!intent) return;
    const nextIntent: PtvPlaybackIntent = {
      ...intent,
      audioStreamIndex: 'audioStreamIndex' in patch ? patch.audioStreamIndex : intent.audioStreamIndex,
      subtitleStreamIndex: 'subtitleStreamIndex' in patch ? patch.subtitleStreamIndex : intent.subtitleStreamIndex
    };
    dispatch({
      type: 'set_playback_intent',
      playbackIntent: withPlaybackStartPosition(nextIntent)
    });
  }, [dispatch, intent, withPlaybackStartPosition]);

  const selectAudioTrack = useCallback((audioStreamIndex: number) => {
    setSelectedAudioTrackIndex(audioStreamIndex);
    setIsAudioMenuOpen(false);
    updateTrackSelection({ audioStreamIndex });
  }, [updateTrackSelection]);

  const selectSubtitleTrack = useCallback((subtitleStreamIndex: number | null) => {
    setSelectedSubtitleTrackIndex(subtitleStreamIndex);
    setIsSubtitleMenuOpen(false);
    updateTrackSelection({ subtitleStreamIndex });
  }, [updateTrackSelection]);

  const toggleAudioMenu = useCallback(() => {
    setIsSubtitleMenuOpen(false);
    setIsAudioMenuOpen(previous => !previous);
  }, []);

  const toggleSubtitleMenu = useCallback(() => {
    setIsAudioMenuOpen(false);
    setIsSubtitleMenuOpen(previous => !previous);
  }, []);

  const toggleLiked = useCallback(() => {
    setLiked(previous => !previous);
  }, []);

  const openDetails = useCallback(() => {
    if (!intent) return;
    const targetId = isEpisode && intent.seriesId ? intent.seriesId : intent.itemId;
    dispatch({ type: 'set_route', route: buildRoute('details', targetId, null) });
  }, [dispatch, intent, isEpisode]);

  const startOver = useCallback(() => {
    if (!intent) return;
    dispatch({
      type: 'set_playback_intent',
      playbackIntent: {
        ...intent,
        startPositionTicks: 0
      }
    });
  }, [dispatch, intent]);

  const closePlayback = useCallback(() => {
    if (intent?.kind === 'audio') {
      dispatch({ type: 'go_back' });
      return;
    }
    const engine = engineRef.current;
    if (engine) void engine.stop('back');
    dispatch({ type: 'set_playback_intent', playbackIntent: null });
    dispatch({ type: 'go_back' });
  }, [dispatch, intent]);

  const queueIdentity = useMemo(() => {
    const chunks = [
      playbackArtist,
      playbackAlbum
    ].filter(Boolean);
    return chunks.length ? chunks.join(' - ') : null;
  }, [playbackAlbum, playbackArtist]);

  const hasAudioTracks = audioTrackOptions.length > 0;
  const hasSubtitleTracks = subtitleTrackOptions.length > 0;

  if (!intent || !userSession) {
    return null;
  }

  return (
    <section
      className={`ptv-playback-route ${isMiniPlayer ? 'ptv-playback-route--mini' : ''}`}
      onMouseMove={handleMouseMove}
    >
      <video className="ptv-playback__media" ref={videoRef} playsInline muted={false} />
      {(!isMiniPlayer && loading && !error) ? (
        <div className="ptv-playback__status">{isAudio ? 'Preparing audio...' : 'Preparing video...'}</div>
      ) : null}
      {(!isMiniPlayer && autoAdvancePending && !error) ? (
        <div className="ptv-playback__status">{isAudio ? 'Loading next track...' : 'Loading next episode...'}</div>
      ) : null}
      {(!isMiniPlayer && error) ? <div className="ptv-playback__error">{error}</div> : null}

      {!isMiniPlayer && isAudio ? (
        <div className="ptv-playback__now-playing">
          <div className="ptv-playback__identity">
            {playbackArtwork ? (
              <img
                src={playbackArtwork}
                alt=""
                className="ptv-playback__artwork"
                onError={event => event.currentTarget.classList.add('ptv-playback__artwork--missing')}
              />
            ) : (
              <div className="ptv-playback__artwork-fallback" aria-hidden="true">PTV</div>
            )}
            <div className="ptv-playback__identity-copy">
              <h1 className="ptv-playback__title">{playbackTitle}</h1>
              {queueIdentity ? <p className="ptv-playback__meta">{queueIdentity}</p> : null}
              {playbackContext ? <p className="ptv-playback__context">{playbackContext}</p> : null}
            </div>
          </div>
          <div className="ptv-playback__queue">
            <p className="ptv-playback__queue-label">Queue</p>
            <div className="ptv-playback__queue-list">
              {queueItemsWithTracks.length === 0 ? <p className="ptv-playback__queue-empty">No queued tracks.</p> : null}
            {queueItemsWithTracks.map((track, index) => (
              <FocusableButton
                key={`${track.itemId}-${index}`}
                focusId={`playback-queue-${index}-${track.itemId}`}
                focusGroup="playback-queue"
                className={`ptv-playback__queue-button${index === activeQueueIndex ? ' is-current' : ''}`}
                onClick={() => jumpToQueueIndex(index)}
                aria-label={`Play queue item ${index + 1}: ${track.title ?? intent?.title ?? 'Unknown title'}`}
                disabled={index === activeQueueIndex || loading || playerState === 'ended' || Boolean(error)}
              >
                  <span className="ptv-playback__queue-index">{index + 1}</span>
                  <span className="ptv-playback__queue-title">{track.title}</span>
                  {track.artist ? <span className="ptv-playback__queue-meta">{track.artist}</span> : null}
                </FocusableButton>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {isMiniPlayer ? (
        <div className="ptv-playback-mini">
          {playbackArtwork ? (
            <img src={playbackArtwork} alt="" className="ptv-playback-mini__artwork" />
          ) : (
            <div className="ptv-playback-mini__fallback" aria-hidden="true">PTV</div>
          )}
          <div className="ptv-playback-mini__meta">
            <h2 className="ptv-playback-mini__title">{playbackTitle}</h2>
            {queueIdentity ? <p className="ptv-playback-mini__details">{queueIdentity}</p> : null}
            {loading ? <p className="ptv-playback-mini__status">Preparing...</p> : null}
            {error ? <p className="ptv-playback-mini__status">Error: {error}</p> : null}
            <div className="ptv-playback-mini__progress-wrap">
              <div className="ptv-playback-mini__time">{formatMediaTime(snapshot.currentTime)} / {formatMediaDuration(snapshot.duration)}</div>
              <div className="ptv-playback-mini__progress" role="progressbar" aria-label="Mini playback progress">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          </div>
          <div className="ptv-playback-mini__actions">
            <FocusableButton
              focusId="playback-previous"
              aria-label="Previous item"
              onClick={event => {
                event.stopPropagation();
                jumpToQueueIndex(activeQueueIndex - 1);
              }}
              disabled={!canGoPrevious || loading || Boolean(error)}
            >
              Prev
            </FocusableButton>
            <FocusableButton
              focusId="playback-toggle"
              aria-label={snapshot.paused ? 'Play' : 'Pause'}
              onClick={event => {
                event.stopPropagation();
                togglePlayback();
              }}
              disabled={loading || playerState === 'ended' || Boolean(error)}
            >
              {playPauseIcon}
            </FocusableButton>
            <FocusableButton
              focusId="playback-next"
              aria-label="Next item"
              onClick={event => {
                event.stopPropagation();
                jumpToQueueIndex(activeQueueIndex + 1);
              }}
              disabled={!canGoNext || loading || Boolean(error)}
            >
              Next
            </FocusableButton>
            <FocusableButton
              focusId="playback-open"
              aria-label="Now Playing"
              onClick={event => {
                event.stopPropagation();
                openNowPlaying();
              }}
            >
              Now Playing
            </FocusableButton>
          </div>
        </div>
      ) : null}

      {!isMiniPlayer ? (
        <div className={`ptv-playback__overlay ${controlsVisible ? '' : 'is-hidden'}`} aria-hidden={!controlsVisible}>
          <header className="ptv-playback__heading">
            <FocusableButton
              focusId="playback-back"
              className="ptv-playback__back"
              aria-label="Back"
              onClick={() => {
                closeTrackMenus();
                closePlayback();
              }}
            >
              <BackIcon />
            </FocusableButton>
            <FocusableButton
              focusId="playback-logo"
              className="ptv-playback__header-logo-button"
              aria-label={isEpisode ? 'Open series details' : 'Open item details'}
              onClick={() => {
                closeTrackMenus();
                openDetails();
              }}
            >
              {playbackLogo ? (
                <img
                  src={playbackLogo}
                  alt=""
                  className="ptv-playback__header-logo"
                  onError={event => event.currentTarget.classList.add('ptv-playback__header-logo--missing')}
                />
              ) : playbackArtwork ? (
                <img
                  src={playbackArtwork}
                  alt=""
                  className="ptv-playback__header-logo ptv-playback__header-logo--artwork"
                />
              ) : (
                <div className="ptv-playback__header-logo-fallback" aria-hidden="true">
                  PTV
                </div>
              )}
            </FocusableButton>
            <h1 className="ptv-playback__header-title">{headerTitle}</h1>
            {shouldShowPlaybackContext ? <p className="ptv-playback__context">{playbackContext}</p> : null}
          </header>
          <div className="ptv-playback__controls">
            <div className="ptv-playback__progress-wrap">
              <div className="ptv-playback__time-row">
                <span className="ptv-playback__time-current">{formatMediaTime(snapshot.currentTime)}</span>
                <span className="ptv-playback__time-duration">{formatMediaDuration(snapshot.duration)}</span>
              </div>
              <div
                className="ptv-playback__progress"
                role="progressbar"
                aria-label="Playback progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={snapshot.duration && snapshot.duration > 0 ? Math.round(progressPercent) : undefined}
                aria-valuetext={`${formatMediaTime(snapshot.currentTime)} of ${formatMediaDuration(snapshot.duration)}`}
              >
                <div className="ptv-playback__progress-fill" style={{ width: `${progressPercent}%` }} />
                <div className="ptv-playback__progress-thumb" style={{ left: `${progressPercent}%` }} />
              </div>
            </div>
            <div className="ptv-playback__control-row">
              <FocusableButton
                focusId="playback-startover"
                className="ptv-playback__control-button"
                aria-label="Start over"
                onClick={() => {
                  closeTrackMenus();
                  startOver();
                }}
                disabled={loading || playerState === 'ended' || Boolean(error)}
              >
                <ReplayIcon />
              </FocusableButton>
              <FocusableButton
                focusId="playback-previous"
                className="ptv-playback__control-button"
                aria-label="Previous"
                onClick={() => {
                  closeTrackMenus();
                  jumpToQueueIndex(activeQueueIndex - 1);
                }}
                disabled={!canGoPrevious || loading || Boolean(error)}
              >
                <PreviousIcon />
              </FocusableButton>
              <FocusableButton
                focusId="playback-rewind"
                className="ptv-playback__control-button"
                aria-label="Rewind 30 seconds"
                onClick={() => {
                  closeTrackMenus();
                  seekBack();
                }}
                disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
              >
                <RewindIcon />
                <span className="ptv-playback__seek-seconds">30</span>
              </FocusableButton>
              <FocusableButton
                focusId="playback-toggle"
                className="ptv-playback__control-button ptv-playback__toggle-button"
                aria-label={playbackToggleLabel}
                onClick={() => {
                  closeTrackMenus();
                  togglePlayback();
                }}
                disabled={loading || playerState === 'ended' || Boolean(error)}
              >
                {playPauseIcon}
              </FocusableButton>
              <FocusableButton
                focusId="playback-forward"
                className="ptv-playback__control-button"
                aria-label="Fast forward 30 seconds"
                onClick={() => {
                  closeTrackMenus();
                  seekForward();
                }}
                disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
              >
                <ForwardIcon />
                <span className="ptv-playback__seek-seconds">30</span>
              </FocusableButton>
              <FocusableButton
                focusId="playback-next"
                className="ptv-playback__control-button"
                aria-label="Next"
                onClick={() => {
                  closeTrackMenus();
                  jumpToQueueIndex(activeQueueIndex + 1);
                }}
                disabled={!canGoNext || loading || Boolean(error)}
              >
                <NextIcon />
              </FocusableButton>
              <div className="ptv-playback__track-actions">
                <FocusableButton
                  focusId="playback-like"
                  className={`ptv-playback__action-button ptv-playback__action-button--icon${liked ? ' is-liked' : ''}`}
                  aria-label={liked ? 'Liked' : 'Like'}
                  onClick={toggleLiked}
                >
                  <HeartIcon filled={liked} />
                </FocusableButton>
                <div className="ptv-playback__track-menu-holder">
                  <FocusableButton
                    focusId="playback-subtitles"
                    className="ptv-playback__action-button ptv-playback__action-button--icon"
                    aria-label="Subtitles"
                    onClick={toggleSubtitleMenu}
                    disabled={!hasSubtitleTracks}
                  >
                    CC
                  </FocusableButton>
                  {isSubtitleMenuOpen ? (
                    <div className="ptv-playback__track-menu" role="menu" aria-label="Subtitles">
                      <FocusableButton
                        focusId="playback-subtitle-off"
                        className={`ptv-playback__track-option${selectedSubtitleTrackIndex === null ? ' is-current' : ''}`}
                        aria-label="Subtitle track off"
                        onClick={() => selectSubtitleTrack(null)}
                      >
                        Off
                      </FocusableButton>
                      {subtitleTrackOptions.map(track => (
                        <FocusableButton
                          key={`subtitle-${track.index}-${track.label}`}
                          focusId={`playback-subtitle-${track.index}`}
                          className={`ptv-playback__track-option${track.index === selectedSubtitleTrackIndex ? ' is-current' : ''}`}
                          aria-label={`Subtitle track ${track.label}`}
                          onClick={() => selectSubtitleTrack(track.index)}
                        >
                          {track.label}
                        </FocusableButton>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="ptv-playback__track-menu-holder">
                  <FocusableButton
                    focusId="playback-audio"
                    className="ptv-playback__action-button ptv-playback__action-button--icon"
                    aria-label="Audio"
                    onClick={toggleAudioMenu}
                    disabled={!hasAudioTracks}
                  >
                    <AudioIcon />
                  </FocusableButton>
                  {isAudioMenuOpen ? (
                    <div className="ptv-playback__track-menu" role="menu" aria-label="Audio">
                      {audioTrackOptions.map(track => (
                        <FocusableButton
                          key={`audio-${track.index}-${track.label}`}
                          focusId={`playback-audio-${track.index}`}
                          className={`ptv-playback__track-option${track.index === selectedAudioTrackIndex ? ' is-current' : ''}`}
                          aria-label={`Audio track ${track.label}`}
                          onClick={() => selectAudioTrack(track.index)}
                        >
                          {track.label}
                        </FocusableButton>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
