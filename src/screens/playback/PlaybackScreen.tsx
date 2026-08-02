import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { chooseBestPlaybackSource } from '../../playback/decision';
import {
  PlaybackEngine,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackEngineState
} from '../../playback/engine';
import { resolvePlaybackStreamUrl } from '../../api/jellyfin/client';
import { FocusableButton } from '../../components/FocusableButton';
import { formatMediaDuration, formatMediaTime } from '../../utils/format';
import { toRouteString } from '../../navigation/router';

type PlaybackRuntime = {
  client: ReturnType<ReturnType<typeof useApp>['services']['jellyfin']['getClient']>;
  itemId: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  settings: ReturnType<typeof useApp>['state']['settings'];
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
} | null;

const emptySnapshot: PlaybackDiagnosticsSnapshot = {
  attemptId: null,
  state: 'idle',
  itemIdSuffix: null,
  mediaSourceIdSuffix: null,
  container: null,
  videoCodec: null,
  audioCodec: null,
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
  lastMediaEvent: null,
  lastPlayerError: null,
  sourceAssignments: 0,
  loadCalls: 0,
  playCalls: 0,
  playingReports: 0,
  progressReports: 0,
  stoppedReports: 0
};

export function PlaybackScreen() {
  const { state, dispatch, services } = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const runtimeRef = useRef<PlaybackRuntime>(null);
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
          return {
            url: resolvePlaybackStreamUrl(
              state.serverUrl as string,
              request.itemId,
              source,
              decision.mode,
              runtime.accessToken,
              runtime.deviceId
            ),
            playSessionId: playbackInfo.PlaySessionId ?? null,
            mediaSourceId: source.Id,
            mode: decision.mode,
            container: source.Container,
            videoCodec: source.VideoCodec,
            audioCodec: source.AudioCodec
          };
        },
        reportPlaying: async report => {
          const runtime = runtimeRef.current;
          if (!runtime || !report.playSessionId) return;
          await runtime.client.reportPlaying(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks
          });
        },
        reportProgress: async report => {
          const runtime = runtimeRef.current;
          if (!runtime || !report.playSessionId) return;
          await runtime.client.reportProgress(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks,
            IsPaused: report.isPaused
          });
        },
        reportStopped: async report => {
          const runtime = runtimeRef.current;
          if (!runtime || !report.playSessionId) return;
          await runtime.client.reportStopped(report.itemId, {
            PlaySessionId: report.playSessionId,
            PositionTicks: report.positionTicks
          });
        }
      }
    );
  }

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
    if (playerStateRef.current === 'playing') {
      hideControlsTimer.current = window.setTimeout(() => {
        services.focusManager.focus('playback-surface', {
          routeId: toRouteString(state.route),
          reason: 'direct'
        });
        setControlsVisible(false);
      }, 4_500);
    }
  }, [services.focusManager, state.route]);

  useEffect(() => {
    const onRemoteActivity = () => showControls();
    window.addEventListener('ptv-remote-input', onRemoteActivity);
    return () => window.removeEventListener('ptv-remote-input', onRemoteActivity);
  }, [showControls]);

  useEffect(() => {
    if (playerState === 'playing') showControls();
  }, [playerState, showControls]);

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

  useEffect(() => services.playback.registerStopOwner(() => (
    engineRef.current?.stop('user')
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
        setError(cause instanceof Error ? cause.message : 'Playback failed');
      }
    });

    return () => {
      if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
      engine.detach();
    };
  }, [intent, userSession]);

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

  return (
    <section className="ptv-playback-route" onMouseMove={showControls} onClick={showControls}>
      <video ref={videoRef} playsInline />
      {loading && !error ? <div className="ptv-playback__status">Preparing video…</div> : null}
      {error ? <div className="ptv-playback__error">{error}</div> : null}
      <div className={`ptv-playback__controls ${controlsVisible ? '' : 'is-hidden'}`} aria-hidden={!controlsVisible}>
        <FocusableButton
          focusId="playback-toggle"
          onClick={() => {
            showControls();
            if (snapshot.paused) void engineRef.current?.play();
            else engineRef.current?.pause();
          }}
          disabled={loading || Boolean(error)}
        >
          {snapshot.paused ? 'Play' : 'Pause'}
        </FocusableButton>
        <FocusableButton focusId="playback-rewind" onClick={() => engineRef.current?.seek(snapshot.currentTime - 30)} disabled={!snapshot.canSeek}>
          −30s
        </FocusableButton>
        <FocusableButton focusId="playback-forward" onClick={() => engineRef.current?.seek(snapshot.currentTime + 30)} disabled={!snapshot.canSeek}>
          +30s
        </FocusableButton>
        <div className="ptv-playback__progress" aria-hidden="true">
          <div className="ptv-playback__progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <span className="ptv-playback__time">
          {formatMediaTime(snapshot.currentTime)} / {formatMediaDuration(snapshot.duration)}
        </span>
        <FocusableButton focusId="playback-close" onClick={closePlayback}>Close</FocusableButton>
      </div>
    </section>
  );
}
