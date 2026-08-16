import { useEffect, useRef, type Dispatch } from 'react';
import { AppProvider, useApp, type AppAction } from '../state/appContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ScreenRouter } from './ScreenRouter';
import { PlaybackScreen } from '../screens/playback/PlaybackScreen';
import { buildRoute, toRouteString } from '../navigation/router';
import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import { PTV_PRODUCTION_SERVER_URL } from '../config/server';
import { toPtvError } from '../core/errors';
import { GlobalRemoteInput } from '../focus/GlobalRemoteInput';
import { createHomeCacheSessionKey, synchronizeHomeCacheSession } from '../state/homeCache';
import { createMediaCacheSessionKey, synchronizeMediaCacheSession } from '../state/mediaCache';
import type { PtvError, PtvRoute, PtvServerSession, PtvUserSession } from '../types/ptv';

type StartupScreen = PtvRoute['screen'];
const lifecycleListenerOwners = new Set<object>();

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
  if (route.screen === 'quick-connect') return 'shell-back-quick-connect';
  if (route.screen === 'home') return 'shell-home';
  if (route.screen === 'movies' || route.screen === 'shows' || route.screen === 'music' || route.screen === 'reading') {
    return 'browse-filter-recent';
  }
  if (route.screen === 'search') {
    return route.itemId && route.sectionId?.startsWith('category:')
      ? 'shell-back-search'
      : 'search-query';
  }
  if (route.screen === 'details') return 'details-primary';
  if (route.screen === 'playback') return 'playback-toggle';
  if (route.screen === 'settings') return 'settings-category-server';
  if (route.screen === 'diagnostics') return 'diagnostics-tab-app';
  return null;
}

function diagnosticOrigin(value?: string | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return '[invalid-origin]';
  }
}

function diagnosticIdSuffix(value?: string | null) {
  if (!value) return null;
  return value.length <= 6 ? value : value.slice(-6);
}

function StartupCoordinator() {
  const { state, dispatch, services } = useApp();
  const previousMediaCacheSessionKey = useRef<string | null | undefined>(undefined);
  const runtimeRouteRef = useRef(toRouteString(state.route));
  runtimeRouteRef.current = toRouteString(state.route);
  const homeCacheSessionKey = createHomeCacheSessionKey(state.serverUrl, state.userSession);
  const mediaCacheSessionKey = createMediaCacheSessionKey(state.serverUrl, state.userSession);

  useEffect(() => {
    synchronizeHomeCacheSession(homeCacheSessionKey);
    services.diagnostics.synchronizeHomePerformanceSession(homeCacheSessionKey);
  }, [homeCacheSessionKey, services.diagnostics]);

  useEffect(() => {
    if (
      previousMediaCacheSessionKey.current !== undefined &&
      previousMediaCacheSessionKey.current !== mediaCacheSessionKey
    ) {
      services.focusManager.clearRouteFocus();
    }
    previousMediaCacheSessionKey.current = mediaCacheSessionKey;
    synchronizeMediaCacheSession(mediaCacheSessionKey);
  }, [mediaCacheSessionKey, services.focusManager]);

  useEffect(() => {
    document.documentElement.classList.toggle('ptv-reduced-motion', state.settings.reducedMotion);
    return () => document.documentElement.classList.remove('ptv-reduced-motion');
  }, [state.settings.reducedMotion]);

  useEffect(() => {
    const routeId = toRouteString(state.route);
    services.focusManager.claimRemoteInteraction();
    services.focusManager.setActiveRoute(routeId, {
      restore: true,
      fallbackFocusId: routeFallback(state.route),
      // Details content arrives asynchronously. Keep its requested primary target
      // pending instead of prematurely settling on the first shell control.
      focusFirstIfUnremembered: state.route.screen !== 'details'
    });
  }, [services.focusManager, state.route]);

  useEffect(() => {
    const unsubscribeTransitions = services.focusManager.subscribeTransitions(transition => {
      services.diagnostics.recordFocusTransition({ ...transition });
    });
    if (!services.diagnostics.runtimeDiagnosticsActive) {
      return unsubscribeTransitions;
    }
    const unsubscribeReconciliation = services.focusManager.subscribeReconciliationEvents(event => {
      services.diagnostics.recordFocusReconciliationEvent({ ...event });
    });
    return () => {
      unsubscribeTransitions();
      unsubscribeReconciliation();
    };
  }, [services.diagnostics, services.focusManager]);

  useEffect(() => services.diagnostics.startRuntimeDiagnostics(() => ({
    currentRoute: runtimeRouteRef.current,
    currentFocusId: services.focusManager.focusId,
    focusInteraction: services.focusManager.interactionState,
    lastFocusTransition: services.focusManager.lastTransition,
    documentVisibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    online: typeof navigator === 'undefined' ? null : navigator.onLine
  })), [services.diagnostics, services.focusManager]);

  const previousRouteRef = useRef<string | null>(null);
  useEffect(() => {
    const currentRoute = toRouteString(state.route);
    services.diagnostics.recordNavigationEvent({
      type: 'route-change',
      at: Date.now(),
      previousRoute: previousRouteRef.current,
      currentRoute,
      historyDepth: state.routeHistory.length
    });
    previousRouteRef.current = currentRoute;
  }, [services.diagnostics, state.route, state.routeHistory.length]);

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
    const listenerOwner = {};
    lifecycleListenerOwners.add(listenerOwner);
    const record = (type: string, details: Record<string, unknown> = {}) => {
      const event = {
        type,
        at: Date.now(),
        visibilityState: document.visibilityState,
        ...details,
        listenerOwnerCount: lifecycleListenerOwners.size,
        duplicateListenerOwnership: lifecycleListenerOwners.size > 1
      };
      services.diagnostics.recordLifecycleEvent(event);
      services.diagnostics.recordRuntimeHeartbeat({
        lifecycleState: type,
        visibilityState: document.visibilityState
      });
    };
    const onVisibilityChange = () => record('visibilitychange');
    const onFocus = () => record('focus');
    const onBlur = () => record('blur');
    const onBeforeUnload = () => record('beforeunload');
    const onPageHide = (event: PageTransitionEvent) => {
      record('pagehide', { persisted: event.persisted, playbackStopRequested: true });
      void services.playback.stop('pagehide').then(
        () => record('pagehide-playback-stopped', { persisted: event.persisted }),
        error => services.diagnostics.logWarn('Pagehide playback cleanup failed', error)
      );
    };
    const onPageShow = (event: PageTransitionEvent) => record('pageshow', { persisted: event.persisted });

    record('lifecycle-listeners-attached');
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      lifecycleListenerOwners.delete(listenerOwner);
      record('lifecycle-listeners-detached');
    };
  }, [services.diagnostics, services.playback]);

  useEffect(() => {
    const lease = services.startupRestore.acquire(
      `bootstrap-${state.bootstrapRetryNonce}`,
      async ({ signal, generation, isCurrent }) => {

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
          const restoreStartedAt = Date.now();
          const restoreAttemptId = `restore-${generation}`;
          const recordRestore = (
            stage: string,
            status: string,
            details: Record<string, unknown> = {}
          ) => services.diagnostics.recordSessionRestore({
            attemptId: restoreAttemptId,
            stage,
            status,
            startedAt: restoreStartedAt,
            durationMs: Math.max(0, Date.now() - restoreStartedAt),
            envelopeSchemaVersion: stored.schemaVersion,
            sessionSchemaVersion: savedSession?.schemaVersion ?? null,
            sessionPresent: Boolean(savedSession),
            tokenPresent: Boolean(savedSession?.accessToken),
            serverOrigin: diagnosticOrigin(savedSession?.serverUrl ?? requestedServer),
            userIdSuffix: diagnosticIdSuffix(savedSession?.userId),
            ...details
          });
          let serverUrl: string;

          recordRestore('STORAGE_READ', savedSession ? 'pending' : 'no-session');
          dispatch({ type: 'set_startup', startupInProgress: true, startupMessage: 'Restoring saved session' });
          setRouteSafe(dispatch, 'startup');
          dispatch({ type: 'set_recent_servers', recentServers: stored.recentServers });

          try {
            serverUrl = normalizeServerUrl(requestedServer);
          } catch (error) {
            recordRestore('SERVER_URL_INVALID', 'failed', { retryable: false });
            finalize('server', 'Stored server URL is not valid', error instanceof Error ? error.message : 'Server URL is invalid');
            return;
          }

          dispatch({ type: 'set_server_url', serverUrl });
          services.jellyfin.clearAuthorization();
          const client = services.jellyfin.configureServer(serverUrl);

          let identity: Awaited<ReturnType<typeof client.validateServer>>;
          try {
            setStartup('Validating server');
            recordRestore('SERVER_VALIDATION_STARTED', 'pending');
            identity = await client.validateServer(10_000, {}, signal);
          } catch (error) {
            if (!isCurrent()) return;
            const issue = normalizePtvError(error);
            dispatch({ type: 'set_server_session', serverSession: null });
            recordRestore('SERVER_VALIDATION_FAILED', savedSession ? 'retryable-failure' : 'failed', {
              httpStatus: issue.code ?? null,
              result: issue.kind,
              retryable: Boolean(savedSession),
              sessionRetained: Boolean(savedSession)
            });
            finalize(
              savedSession ? 'auth' : 'server',
              savedSession ? 'Saved session could not reach the server' : 'Unable to reach server',
              issue.message
            );
            return;
          }

          if (!isCurrent()) return;
          recordRestore('SERVER_VALIDATED', 'pending', { httpStatus: 200, serverVersion: identity.Version });
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
            recordRestore('NO_SAVED_SESSION', 'complete', {
              sessionPresent: false,
              tokenPresent: false,
              usersMeResult: 'not-requested'
            });
            finalize('auth', 'Sign in required');
            return;
          }

          services.jellyfin.configureSession(serverUrl, savedSession.accessToken);
          recordRestore('API_CONTEXT_CONFIGURED', 'pending', { apiContextConfigured: true });
          try {
            setStartup('Validating saved user');
            recordRestore('USERS_ME_STARTED', 'pending', { apiContextConfigured: true });
            const profile = await client.validateSession(savedSession.userId, 8_000, signal);
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
            recordRestore('COMPLETE', 'success', {
              apiContextConfigured: true,
              usersMeResult: 'success',
              usersMeHttpStatus: 200,
              restoredUserIdSuffix: diagnosticIdSuffix(profile.Id),
              sessionRetained: true,
              targetRoute: 'home'
            });
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
              recordRestore('SESSION_REJECTED', 'rejected', {
                apiContextConfigured: false,
                usersMeResult: issue.kind,
                usersMeHttpStatus: issue.code ?? null,
                sessionRetained: false,
                targetRoute: 'auth'
              });
              finalize('auth', 'Session expired', 'Your saved session was rejected. Sign in again.');
              return;
            }
            recordRestore('USERS_ME_FAILED', 'retryable-failure', {
              apiContextConfigured: false,
              usersMeResult: issue.kind,
              usersMeHttpStatus: issue.code ?? null,
              retryable: true,
              sessionRetained: true,
              targetRoute: 'auth'
            });
            finalize('auth', 'Saved session could not be validated', issue.message);
          }
        };

        try {
          await boot();
        } catch (error) {
          if (!isCurrent()) return;
          services.diagnostics.logError('Unexpected startup restore failure', error, true);
          const issue = normalizePtvError(error);
          dispatch({
            type: 'set_startup',
            startupInProgress: false,
            startupMessage: 'Saved session could not be restored',
            startupError: issue.message
          });
          setRouteSafe(dispatch, 'server');
          dispatch({ type: 'set_bootstrap_complete' });
        }
      }
    );

    return lease.release;
  }, [dispatch, services.diagnostics, services.jellyfin, services.startupRestore, services.storage, state.bootstrapRetryNonce]);

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
    const currentRoute = toRouteString(state.route);
    const historyTarget = state.routeHistory.length > 0
      ? state.routeHistory[state.routeHistory.length - 1]
      : undefined;
    const recordBack = (branch: string, targetRoute: string | null) => {
      services.diagnostics.recordNavigationEvent({
        type: 'back',
        at: Date.now(),
        currentRoute,
        previousRoute: historyTarget ? toRouteString(historyTarget) : null,
        historyDepth: state.routeHistory.length,
        branch,
        targetRoute
      });
    };
    if (state.route.screen === 'quick-connect') {
      services.session.cancelCurrentAttempt();
    }
    if (state.routeHistory.length > 0) {
      const targetRoute = historyTarget ? toRouteString(historyTarget) : null;
      if (state.route.screen === 'playback') {
        const playbackIntent = state.playbackIntent;
        if (playbackIntent?.kind === 'audio') {
          recordBack('playback-audio-keep-going', targetRoute);
        } else {
          recordBack('playback-stop-and-history', targetRoute);
          void services.playback.stop('back');
          dispatch({ type: 'set_playback_intent', playbackIntent: null });
        }
        dispatch({ type: 'go_back' });
      } else {
        recordBack(state.route.screen === 'quick-connect' ? 'quick-connect-cancel-and-history' : 'history', targetRoute);
        dispatch({ type: 'go_back' });
      }
      return;
    }
    if (state.route.screen === 'auth') {
      recordBack('auth-to-server', 'server');
      setRouteSafe(dispatch, 'server');
      return;
    }
    if (state.route.screen === 'diagnostics') {
      recordBack('diagnostics-fallback', 'server');
      dispatch({ type: 'reset_route', route: buildRoute('server') });
      return;
    }
    if (
      state.route.screen === 'movies' ||
      state.route.screen === 'shows' ||
      state.route.screen === 'music' ||
      state.route.screen === 'reading' ||
      state.route.screen === 'search'
    ) {
      recordBack('primary-to-home', 'home');
      dispatch({ type: 'reset_route', route: buildRoute('home') });
      return;
    }
    if (state.route.screen === 'server' || state.route.screen === 'home') {
      recordBack('exit-requested', null);
      window.close();
      return;
    }
    recordBack('unhandled', null);
  };

  return (
    <>
      <GlobalRemoteInput
        focusManager={services.focusManager}
        allowDirectionalRepeat
        getRouteId={() => toRouteString(state.route)}
        onBack={handleBack}
        onOwnershipConflict={() => services.diagnostics.recordInputEvent({
          type: 'ownership-conflict',
          at: Date.now(),
          route: toRouteString(state.route)
        })}
        onInput={record => {
          services.diagnostics.recordInputEvent({
            ...record,
            actionKind: record.action.kind,
            key: record.action.key
          });
          window.dispatchEvent(new CustomEvent('ptv-remote-input', {
            detail: {
              ...record,
              source: 'user',
              key: record.action.key
            }
          }));
        }}
      />
      <ErrorBoundary
        diagnostics={services.diagnostics}
        onRestart={() => window.location.reload()}
        onBack={() => setRouteSafe(dispatch, 'server')}
        onOpenDiagnostics={() => setRouteSafe(dispatch, 'diagnostics')}
      >
        <ScreenRouter />
        <PlaybackScreen />
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
