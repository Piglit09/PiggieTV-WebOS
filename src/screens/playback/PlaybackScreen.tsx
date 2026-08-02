import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { chooseBestPlaybackSource } from '../../playback/decision';
import {
  PlaybackEngine,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackEngineState
} from '../../playback/engine';
import { JellyfinApiClient, resolvePlaybackStreamUrl } from '../../api/jellyfin/client';
import { FocusableButton } from '../../components/FocusableButton';
import { formatMediaDuration, formatMediaTime } from '../../utils/format';
import { toRouteString } from '../../navigation/router';
import { redactSensitiveText } from '../../core/redaction';

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

export function PlaybackScreen() {
  const { state, dispatch, services } = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const runtimeRef = useRef<PlaybackRuntime>(null);
  const reportingRuntimeByAttemptRef = useRef<Map<string, PlaybackReportingRuntime>>(new Map());
  const engineRef = useRef<PlaybackEngine | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const playerStateRef = useRef<PlaybackEngineState>('idle');
  const [playerState, setPlayerState] = useState<PlaybackEngineState>('idle');
  const [snapshot, setSnapshot] = useState<PlaybackDiagnosticsSnapshot>(emptySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const intent = state.playbackIntent;
  const userSession = state.userSession;
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
          if (next !== 'stopped') setPlayerState(next);
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
          if (!runtime || runtime.itemId !== request.itemId) throw new Error('Playback session is no longer active');
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
          if (!report.playSessionId) return { status: 'skipped' as const, reason: 'play-session-id-unavailable' };
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
          if (!report.playSessionId) return { status: 'skipped' as const, reason: 'play-session-id-unavailable' };
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
            if (!report.playSessionId) return { status: 'skipped' as const, reason: 'play-session-id-unavailable' };
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
    if (playerStateRef.current === 'playing') {
      hideControlsTimer.current = window.setTimeout(() => {
        hideControlsTimer.current = null;
        services.focusManager.focus('playback-surface', {
          routeId: toRouteString(state.route),
          reason: 'direct'
        });
        setControlsVisible(false);
      }, 4_500);
    }
  }, [clearHideControlsTimer, services.focusManager, state.route]);

  useEffect(() => {
    const onRemoteActivity = () => showControls();
    window.addEventListener('ptv-remote-input', onRemoteActivity);
    return () => window.removeEventListener('ptv-remote-input', onRemoteActivity);
  }, [showControls]);

  useEffect(() => {
    if (playerState === 'playing') {
      showControls();
      return;
    }
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [clearHideControlsTimer, playerState, showControls]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return services.focusManager.register({
      id: 'playback-surface',
      routeId: toRouteString(state.route),
      ref: video,
      activate: () => {
        showControls();
        return true;
      }
    });
  }, [services.focusManager, showControls, state.route]);

  useEffect(() => services.playback.registerStopOwner(reason => (
    engineRef.current?.stop(reason)
  )), [services.playback]);

  useEffect(() => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video || !intent || !userSession) return;
    setError(null);
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

  const closePlayback = () => {
    const engine = engineRef.current;
    if (engine) void engine.stop('back');
    dispatch({ type: 'set_playback_intent', playbackIntent: null });
    dispatch({ type: 'go_back' });
  };

  if (!intent || !userSession) {
    return (
      <section className="ptv-playback-route">
        <video ref={videoRef} playsInline />
        <div className="ptv-playback__error">No playback item selected.</div>
        <div className="ptv-playback__controls">
          <FocusableButton focusId="playback-close" onClick={() => dispatch({ type: 'go_back' })}>Back</FocusableButton>
        </div>
      </section>
    );
  }

  const progressPercent = snapshot.duration && snapshot.duration > 0
    ? Math.max(0, Math.min(100, (snapshot.currentTime / snapshot.duration) * 100))
    : 0;
  const loading = playerState === 'idle' || playerState === 'resolving' || playerState === 'loading' || playerState === 'ready';
  const playbackTitle = intent.title?.trim() || 'Now Playing';
  const playbackContext = intent.context?.trim();

  return (
    <section className="ptv-playback-route" onMouseMove={showControls} onClick={showControls}>
      <video ref={videoRef} playsInline />
      {loading && !error ? <div className="ptv-playback__status">Preparing video…</div> : null}
      {error ? <div className="ptv-playback__error">{error}</div> : null}
      <div className={`ptv-playback__overlay ${controlsVisible ? '' : 'is-hidden'}`} aria-hidden={!controlsVisible}>
        <div className="ptv-playback__heading">
          <h1 className="ptv-playback__title">{playbackTitle}</h1>
          {playbackContext ? <p className="ptv-playback__context">{playbackContext}</p> : null}
        </div>
        <div className="ptv-playback__controls">
          <FocusableButton
            focusId="playback-toggle"
            onClick={() => {
              showControls();
              if (playerStateRef.current === 'ended' || playerStateRef.current === 'error') return;
              if (snapshot.paused) void engineRef.current?.play();
              else engineRef.current?.pause();
            }}
            disabled={loading || playerState === 'ended' || Boolean(error)}
          >
            {playerState === 'ended' ? 'Ended' : snapshot.paused ? 'Play' : 'Pause'}
          </FocusableButton>
          <FocusableButton
            focusId="playback-rewind"
            onClick={() => engineRef.current?.seek(snapshot.currentTime - 30)}
            disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
          >
            −30s
          </FocusableButton>
          <FocusableButton
            focusId="playback-forward"
            onClick={() => engineRef.current?.seek(snapshot.currentTime + 30)}
            disabled={!snapshot.canSeek || playerState === 'ended' || Boolean(error)}
          >
            +30s
          </FocusableButton>
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
    </section>
  );
}
