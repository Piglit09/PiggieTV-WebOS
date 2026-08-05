import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { chooseBestPlaybackSource } from '../../playback/decision';
import {
  PlaybackEngine,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackEngineState
} from '../../playback/engine';
import { JellyfinApiClient, resolvePlaybackStreamUrl } from '../../api/jellyfin/client';
import { mapPtvItems } from '../../api/jellyfin/mappers';
import { FocusableButton } from '../../components/FocusableButton';
import { formatMediaDuration, formatMediaTime } from '../../utils/format';
import { playbackRouteFromIntent, toRouteString } from '../../navigation/router';
import { redactSensitiveText } from '../../core/redaction';
import type { PtvPlaybackIntent, PtvPlaybackQueueItem } from '../../types/ptv';

type PlaybackRuntime = {
  client: ReturnType<ReturnType<typeof useApp>['services']['jellyfin']['getClient']>;
  serverUrl: string;
  itemId: string;
  userId: string;
  accessToken: string;
  deviceId: string;
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

function episodeContext(item: { seriesName?: string | null; seasonName?: string | null; parentIndexNumber?: number | null; indexNumber?: number | null }) {
  const number = item.parentIndexNumber && item.indexNumber
    ? `S${item.parentIndexNumber} E${item.indexNumber}`
    : item.indexNumber
      ? `Episode ${item.indexNumber}`
      : item.seasonName ?? null;
  return [item.seriesName, number].filter(Boolean).join(' - ') || undefined;
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

export function PlaybackScreen() {
  const { state, dispatch, services } = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const runtimeRef = useRef<PlaybackRuntime>(null);
  const reportingRuntimeByAttemptRef = useRef<Map<string, PlaybackReportingRuntime>>(new Map());
  const engineRef = useRef<PlaybackEngine | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const playerStateRef = useRef<PlaybackEngineState>('idle');
  const autoAdvanceControllerRef = useRef<AbortController | null>(null);
  const autoAdvanceStartedForItemRef = useRef<string | null>(null);

  const [playerState, setPlayerState] = useState<PlaybackEngineState>('idle');
  const [endedItemId, setEndedItemId] = useState<string | null>(null);
  const [autoAdvancePending, setAutoAdvancePending] = useState(false);
  const [snapshot, setSnapshot] = useState<PlaybackDiagnosticsSnapshot>(emptySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  const intent = state.playbackIntent;
  const userSession = state.userSession;
  const isAudio = intent?.kind === 'audio';
  const isNowPlayingRoute = state.route.screen === 'playback'
    && isAudio
    && state.route.sectionId === 'now-playing';
  const playbackRouteMode = isNowPlayingRoute ? 'now-playing' : 'mini';
  const isMiniPlayer = isAudio && !isNowPlayingRoute;
  const shouldRenderVideoControls = !isMiniPlayer;
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
  playerStateRef.current = playerState;

  if (intent && userSession && state.serverUrl) {
    runtimeRef.current = {
      client: services.jellyfin.configureSession(state.serverUrl, userSession.accessToken),
      serverUrl: state.serverUrl,
      itemId: intent.itemId,
      userId: intent.userId,
      accessToken: userSession.accessToken,
      deviceId: userSession.deviceId,
      settings: state.settings,
      audioStreamIndex: intent.audioStreamIndex,
      subtitleStreamIndex: intent.subtitleStreamIndex
    };
  } else {
    runtimeRef.current = null;
  }

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
          }
        },
        onError: message => setError(message),
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
          const playbackInfo = await runtime.client.getPlaybackInfo(
            runtime.userId,
            request.itemId,
            {
              audioStreamIndex: runtime.audioStreamIndex ?? undefined,
              subtitleStreamIndex: runtime.subtitleStreamIndex ?? undefined,
              enableDirectPlay: runtime.settings.directPlayEnabled,
              enableDirectStream: runtime.settings.directStreamEnabled,
              enableTranscoding: runtime.settings.transcodeEnabled
            },
            context.signal
          );
          if (context.signal.aborted) throw new DOMException('Playback superseded', 'AbortError');
          const decision = chooseBestPlaybackSource(playbackInfo, {
            preferDirectPlay: runtime.settings.directPlayEnabled,
            preferDirectStream: runtime.settings.directStreamEnabled,
            allowTranscode: runtime.settings.transcodeEnabled
          });
          const source = playbackInfo.MediaSources?.find(candidate => candidate.Id === decision.mediaSourceId);
          if (!source) throw new Error('Jellyfin did not return a playable media source');
          const sourceVideoStream = source.MediaStreams?.find(stream => stream.Type === 'Video');
          const sourceAudioStream = source.MediaStreams?.find(stream => (
            stream.Type === 'Audio' &&
            typeof runtime.audioStreamIndex === 'number' &&
            stream.Index === runtime.audioStreamIndex
          )) ?? source.MediaStreams?.find(stream => stream.Type === 'Audio' && stream.IsDefault)
            ?? source.MediaStreams?.find(stream => stream.Type === 'Audio');
          const sourceVideoCodec = source.VideoCodec ?? sourceVideoStream?.Codec ?? null;
          const sourceAudioCodec = source.AudioCodec ?? sourceAudioStream?.Codec ?? null;
          const streamUrl = resolvePlaybackStreamUrl(
            runtime.serverUrl,
            request.itemId,
            source,
            decision.mode,
            runtime.accessToken,
            runtime.deviceId
          );
          const reportingClient = new JellyfinApiClient({
            baseUrl: runtime.serverUrl,
            accessToken: runtime.accessToken,
            deviceId: runtime.deviceId,
            requestTracker: services.requestTracker
          });
          reportingRuntimeByAttemptRef.current.set(context.attemptId, {
            client: reportingClient,
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
            requestedOutputAudioCodec: transcodingRequested ? 'aac' : sourceAudioCodec
          };
        },
        reportPlaying: async report => {
          const runtime = reportingRuntimeByAttemptRef.current.get(report.attemptId);
          if (!runtime) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          if (runtime.itemId !== report.itemId) return { status: 'skipped' as const, reason: 'attempt-item-mismatch' };
          if (!report.playSessionId) return { status: 'skipped' as const, reason: 'attempt-runtime-unavailable' };
          await runtime.client.reportPlaying(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks
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
              PositionTicks: report.positionTicks
            });
            return { status: 'sent' as const };
          } finally {
            reportingRuntimeByAttemptRef.current.delete(report.attemptId);
          }
        }
      }
    );
  }

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimer.current !== null) {
      window.clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearHideControlsTimer();
    if (playerStateRef.current === 'playing' && shouldRenderVideoControls) {
      hideControlsTimer.current = window.setTimeout(() => {
        hideControlsTimer.current = null;
        services.focusManager.focus('playback-surface', {
          routeId: toRouteString(state.route),
          reason: 'direct'
        });
        setControlsVisible(false);
      }, 4_500);
    }
  }, [clearHideControlsTimer, services.focusManager, shouldRenderVideoControls, state.route]);

  useEffect(() => {
    const onRemoteActivity = () => showControls();
    window.addEventListener('ptv-remote-input', onRemoteActivity);
    return () => window.removeEventListener('ptv-remote-input', onRemoteActivity);
  }, [showControls]);

  useEffect(() => {
    if (!shouldRenderVideoControls) {
      clearHideControlsTimer();
      setControlsVisible(true);
      return;
    }
    if (playerState === 'playing') {
      showControls();
      return;
    }
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [clearHideControlsTimer, playerState, shouldRenderVideoControls, showControls]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!shouldRenderVideoControls) return;
    return services.focusManager.register({
      id: 'playback-surface',
      routeId: toRouteString(state.route),
      ref: video,
      activate: () => {
        showControls();
        return true;
      }
    });
  }, [services.focusManager, showControls, shouldRenderVideoControls, state.route]);

  useEffect(() => services.playback.registerStopOwner(reason => (
    engineRef.current?.stop(reason)
  )), [services.playback]);

  useEffect(() => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video || !intent || !userSession) return;
    setError(null);
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
        setError(redactSensitiveText(message));
      }
    });

    return () => {
      clearHideControlsTimer();
      engine.detach();
    };
  }, [clearHideControlsTimer, intent, userSession]);

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

        const runtime = runtimeRef.current;
        const response = await runtime.client.getNextUpForSeries(
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

        const nextEpisode = mapPtvItems(response).find(candidate => (
          candidate.type === 'Episode' &&
          candidate.id !== completedItemId &&
          candidate.seriesId === seriesId
        ));
        if (!nextEpisode) return;

        const nextIntent: PtvPlaybackIntent = {
          kind: 'episode',
          itemId: nextEpisode.id,
          seriesId: nextEpisode.seriesId ?? seriesId,
          serverId: intent.serverId,
          userId: intent.userId,
          title: nextEpisode.name,
          context: episodeContext(nextEpisode),
          startPositionTicks: nextEpisode.playbackPositionTicks
        };
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
    endedItemId,
    intent,
    services.diagnostics,
    playbackRouteMode,
    state.route.screen,
    state.settings.autoPlayNext,
    userSession
  ]);

  const progressPercent = snapshot.duration && snapshot.duration > 0
    ? Math.max(0, Math.min(100, (snapshot.currentTime / snapshot.duration) * 100))
    : 0;

  const playPauseLabel = useMemo(() => {
    if (autoAdvancePending) return 'Next';
    if (playerState === 'ended') return 'Ended';
    if (error) return 'Error';
    return snapshot.paused ? 'Play' : 'Pause';
  }, [autoAdvancePending, error, playerState, snapshot.paused]);

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
    const track = queueItemsWithTracks[targetIndex];
    if (!track || !track.itemId) return;
    const nextIntent: PtvPlaybackIntent = {
      kind: 'audio',
      itemId: track.itemId,
      serverId: intent.serverId,
      userId: intent.userId,
      title: track.title || intent.title,
      context: track.context ?? intent.context,
      artist: track.artist ?? intent.artist,
      album: track.album ?? intent.album,
      albumId: track.albumId ?? intent.albumId,
      artworkUrl: track.artworkUrl ?? intent.artworkUrl,
      startPositionTicks: track.startPositionTicks,
      queue: {
        items: queueItemsWithTracks,
        index: targetIndex
      }
    };
    dispatch({
      type: 'advance_playback',
      playbackIntent: nextIntent,
      route: playbackRouteFromIntent(nextIntent, playbackRouteMode)
    });
  }, [activeQueueIndex, dispatch, intent, queueItemsWithTracks, playbackRouteMode]);

  const openNowPlaying = useCallback(() => {
    if (!intent) return;
    dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent, 'now-playing') });
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

  if (!intent || !userSession) {
    return null;
  }

  const isVideoMode = intent.kind !== 'audio';

  return (
    <section
      className={`ptv-playback-route ${isMiniPlayer ? 'ptv-playback-route--mini' : ''}`}
      onMouseMove={showControls}
      onClick={() => {
        if (!isMiniPlayer) showControls();
      }}
    >
      <video className="ptv-playback__media" ref={videoRef} playsInline muted={false} />
      {(!isMiniPlayer && loading && !error) ? (
        <div className="ptv-playback__status">{isAudio ? 'Preparing audio...' : 'Preparing video...'}</div>
      ) : null}
      {(!isMiniPlayer && autoAdvancePending && !error) ? <div className="ptv-playback__status">Loading next episode...</div> : null}
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
              onClick={event => {
                event.stopPropagation();
                togglePlayback();
              }}
              disabled={loading || playerState === 'ended' || Boolean(error)}
            >
              {playPauseLabel}
            </FocusableButton>
            <FocusableButton
              focusId="playback-next"
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
        <div className={`ptv-playback__heading${isVideoMode ? ' is-video' : ''}`}>
          {isVideoMode ? (
            <>
              <h1 className="ptv-playback__title">{playbackTitle}</h1>
              {playbackContext ? <p className="ptv-playback__context">{playbackContext}</p> : null}
            </>
          ) : null}
        </div>
        <div className="ptv-playback__controls">
          {isAudio ? (
            <FocusableButton
              focusId="playback-previous"
              onClick={() => jumpToQueueIndex(activeQueueIndex - 1)}
              disabled={!canGoPrevious || loading || Boolean(error)}
            >
              Prev
            </FocusableButton>
          ) : null}

          <FocusableButton
            focusId="playback-toggle"
            onClick={togglePlayback}
            disabled={loading || playerState === 'ended' || Boolean(error)}
          >
            {playPauseLabel}
          </FocusableButton>
          <FocusableButton
            focusId="playback-rewind"
            onClick={seekBack}
            disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
          >
            -30s
          </FocusableButton>
          <FocusableButton
            focusId="playback-forward"
            onClick={seekForward}
            disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
          >
            +30s
          </FocusableButton>

          {isAudio ? (
            <FocusableButton
              focusId="playback-next"
              onClick={() => jumpToQueueIndex(activeQueueIndex + 1)}
              disabled={!canGoNext || loading || Boolean(error)}
            >
              Next
            </FocusableButton>
          ) : null}

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
          </div>
          <span className="ptv-playback__time">
            {formatMediaTime(snapshot.currentTime)} / {formatMediaDuration(snapshot.duration)}
          </span>
          <FocusableButton focusId="playback-close" onClick={closePlayback}>Back</FocusableButton>
        </div>
        </div>
      ) : null}
    </section>
  );
}
