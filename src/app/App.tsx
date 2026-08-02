import { useEffect, useRef, type Dispatch } from 'react';
import { AppProvider, useApp, type AppAction } from '../state/appContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ScreenRouter } from './ScreenRouter';
import { buildRoute, toRouteString } from '../navigation/router';
import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import { PTV_PRODUCTION_SERVER_URL } from '../config/server';
import { toPtvError } from '../core/errors';
import { GlobalRemoteInput } from '../focus/GlobalRemoteInput';
import type { PtvError, PtvRoute, PtvServerSession, PtvUserSession } from '../types/ptv';

type StartupScreen = PtvRoute['screen'];

function normalizePtvError(input: unknown): PtvError {
  if (input && typeof input === 'object' && 'kind' in input && 'message' in input) {
    const typed = input as PtvError;
    return {
      kind: typed.kind,
      message: typed.message || 'Request failed',
      code: typed.code,
      requestId: typed.requestId,
      recoverable: typed.recoverable ?? true
    };
  }
  return toPtvError(input, 'unknown');
}

function isRejectedSession(error: PtvError) {
  return error.kind === 'authentication-failed' || error.kind === 'session-expired' || error.code === 401 || error.code === 403;
}

function setRouteSafe(dispatch: Dispatch<AppAction>, screen: StartupScreen) {
  dispatch({ type: 'set_route', route: buildRoute(screen), replace: true });
}

function routeFallback(route: PtvRoute) {
  if (route.screen === 'auth') return 'auth-username';
  if (route.screen === 'server') return 'server-url';
  if (route.screen === 'quick-connect') return 'qc-back';
  if (route.screen === 'details') return 'details-play';
  if (route.screen === 'playback') return 'playback-toggle';
  if (route.screen === 'settings') return 'settings-diagnostics';
  return null;
}

function StartupCoordinator() {
  const { state, dispatch, services } = useApp();
  const bootstrapRun = useRef(0);

  useEffect(() => {
    const routeId = toRouteString(state.route);
    services.focusManager.setPointerFocusActive(false);
    services.focusManager.setActiveRoute(routeId, {
      restore: true,
      fallbackFocusId: routeFallback(state.route),
      focusFirstIfUnremembered: true
    });
  }, [services.focusManager, state.route]);

  useEffect(() => services.focusManager.subscribeTransitions(transition => {
    services.diagnostics.recordFocusTransition({ ...transition });
  }), [services.diagnostics, services.focusManager]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      services.diagnostics.logError('window.onerror', `${event.message}@${event.filename}:${event.lineno}`, true);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const issue = normalizePtvError(event.reason);
      if (issue.kind === 'cancelled-request' || issue.kind === 'stale-response') return;
      services.diagnostics.logError('unhandledrejection', `${issue.kind}: ${issue.message}`, true);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [services.diagnostics]);

  useEffect(() => {
    const runId = ++bootstrapRun.current;
    const controller = new AbortController();
    const isCurrent = () => bootstrapRun.current === runId && !controller.signal.aborted;

    const setStartup = (message: string, error: string | null = null) => {
      if (!isCurrent()) return;
      dispatch({
        type: 'set_startup',
        startupInProgress: error == null,
        startupMessage: message,
        startupError: error
      });
    };

    const finalize = (route: StartupScreen, message: string, error: string | null = null) => {
      if (!isCurrent()) return;
      setStartup(message, error);
      setRouteSafe(dispatch, route);
      dispatch({ type: 'set_bootstrap_complete' });
    };

    const boot = async () => {
      const stored = services.storage.getState();
      const savedSession = stored.session;
      const requestedServer = savedSession?.serverUrl || stored.lastServerUrl || PTV_PRODUCTION_SERVER_URL;
      let serverUrl: string;

      dispatch({ type: 'set_startup', startupInProgress: true, startupMessage: 'Restoring saved session' });
      setRouteSafe(dispatch, 'startup');
      dispatch({ type: 'set_recent_servers', recentServers: stored.recentServers });

      try {
        serverUrl = normalizeServerUrl(requestedServer);
      } catch (error) {
        finalize('server', 'Stored server URL is not valid', error instanceof Error ? error.message : 'Server URL is invalid');
        return;
      }

      dispatch({ type: 'set_server_url', serverUrl });
      services.jellyfin.clearAuthorization();
      const client = services.jellyfin.configureServer(serverUrl);

      let identity: Awaited<ReturnType<typeof client.validateServer>>;
      try {
        setStartup('Validating server');
        identity = await client.validateServer(10_000, {}, controller.signal);
      } catch (error) {
        if (!isCurrent()) return;
        const issue = normalizePtvError(error);
        dispatch({ type: 'set_server_session', serverSession: null });
        finalize('server', 'Unable to reach server', issue.message);
        return;
      }

      if (!isCurrent()) return;
      const serverSession: PtvServerSession = {
        serverId: identity.ServerId,
        baseUrl: serverUrl,
        serverName: identity.ServerName,
        serverVersion: identity.Version,
        connectedAt: Date.now(),
        lastValidatedAt: Date.now()
      };
      dispatch({ type: 'set_server_session', serverSession });
      try {
        services.storage.upsertServer(serverSession);
      } catch (error) {
        services.diagnostics.logWarn('Server metadata persistence failed', error);
      }

      if (!savedSession || savedSession.serverUrl !== serverUrl) {
        dispatch({ type: 'set_user_session', userSession: null });
        finalize('auth', 'Sign in required');
        return;
      }

      services.jellyfin.configureSession(serverUrl, savedSession.accessToken);
      try {
        setStartup('Validating saved user');
        const profile = await client.validateSession(savedSession.userId, 8_000, controller.signal);
        if (profile.Id !== savedSession.userId || (profile.Name && profile.Name !== savedSession.userName)) {
          throw toPtvError('Saved session returned the wrong user', 'invalid-server-response');
        }
        if (!isCurrent()) return;

        const userSession: PtvUserSession = {
          userId: savedSession.userId,
          userName: typeof profile.Name === 'string' && profile.Name.trim() ? profile.Name : savedSession.userName,
          accessToken: savedSession.accessToken,
          serverId: identity.ServerId,
          serverUrl,
          deviceId: savedSession.deviceId,
          createdAt: savedSession.savedAt,
          updatedAt: Date.now()
        };
        dispatch({ type: 'set_user_session', userSession, userName: userSession.userName });
        finalize('home', 'Ready');
      } catch (error) {
        if (!isCurrent()) return;
        const issue = normalizePtvError(error);
        services.jellyfin.clearAuthorization();
        dispatch({ type: 'set_user_session', userSession: null });
        if (isRejectedSession(issue)) {
          try {
            services.storage.clearSession();
          } catch (storageError) {
            services.diagnostics.logError('Rejected session could not be removed', storageError, true);
          }
          finalize('auth', 'Session expired', 'Your saved session was rejected. Sign in again.');
          return;
        }
        finalize('auth', 'Saved session could not be validated', issue.message);
      }
    };

    void boot();
    return () => controller.abort('startup-superseded');
  }, [dispatch, services.diagnostics, services.jellyfin, services.storage]);

  useEffect(() => {
    if (!state.userSession || !state.serverUrl) return;
    const controller = new AbortController();
    void services.jellyfin
      .configureSession(state.serverUrl, state.userSession.accessToken)
      .discoverCapabilities(8_000, controller.signal)
      .then(capabilities => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'set_capabilities', capabilities, ptvCapabilities: [] });
        }
      })
      .catch(error => {
        const issue = normalizePtvError(error);
        if (issue.kind !== 'cancelled-request') services.diagnostics.logWarn('Capability discovery failed', issue);
      });
    return () => controller.abort('capability-route-hidden');
  }, [dispatch, services.diagnostics, services.jellyfin, state.serverUrl, state.userSession]);

  const handleBack = () => {
    if (state.route.screen === 'quick-connect') {
      services.session.cancelCurrentAttempt();
    }
    if (state.routeHistory.length > 0) {
      if (state.route.screen === 'playback') {
        void services.playback.stop();
        dispatch({ type: 'set_playback_intent', playbackIntent: null });
      }
      dispatch({ type: 'go_back' });
      return;
    }
    if (state.route.screen === 'auth') {
      setRouteSafe(dispatch, 'server');
      return;
    }
    if (state.route.screen === 'server' || state.route.screen === 'home') {
      window.close();
    }
  };

  return (
    <>
      <GlobalRemoteInput
        focusManager={services.focusManager}
        getRouteId={() => toRouteString(state.route)}
        onBack={handleBack}
        onInput={record => {
          services.diagnostics.recordFocusTransition({
            route: record.routeId,
            previousFocusId: record.previousFocusId,
            nextFocusId: record.nextFocusId,
            key: record.action.key,
            reason: record.reason,
            fallbackUsed: record.fallbackUsed
          });
          window.dispatchEvent(new CustomEvent('ptv-remote-input', { detail: record }));
        }}
      />
      <ErrorBoundary
        diagnostics={services.diagnostics}
        onRestart={() => window.location.reload()}
        onBack={() => setRouteSafe(dispatch, 'server')}
        onOpenDiagnostics={() => setRouteSafe(dispatch, 'diagnostics')}
      >
        <ScreenRouter />
      </ErrorBoundary>
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <StartupCoordinator />
    </AppProvider>
  );
}
