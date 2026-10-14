import React, { createContext, useContext, useMemo, useReducer } from 'react';
import { FocusManager } from '../focus/FocusManager';
import { StorageRepository } from '../storage/repository';
import { RequestTracker } from '../core/requestTracker';
import { DiagnosticsService } from '../core/diagnostics';
import { JellyfinApiClient } from '../api/jellyfin/client';
import { JellyfinClientContext } from '../api/jellyfin/context';
import { SessionController } from '../auth/sessionController';
import {
  AuthSessionCoordinator,
  type AuthenticatedSessionTicket
} from '../auth/authSessionCoordinator';
import { PTV_APPLICATION_VERSION, PTV_DEVICE_NAME } from '../config/app';
import { PlaybackLifecycle } from '../playback/lifecycle';
import type { PtvCapability, PtvError, PtvLibrary, PtvPlaybackIntent, PtvRoute, PtvServerSession, PtvUserSession } from '../types/ptv';
import { buildRoute } from '../navigation/router';
import { StartupRestoreCoordinator } from '../app/startupRestoreCoordinator';

export interface AppSettings {
  reducedMotion: boolean;
  defaultQuality: 'auto' | 'hd' | '4k';
  directPlayEnabled: boolean;
  directStreamEnabled: boolean;
  transcodeEnabled: boolean;
  autoPlayNext: boolean;
  subtitleDefaultOff: boolean;
}

export interface AppState {
  initialized: boolean;
  route: PtvRoute;
  routeHistory: PtvRoute[];
  startupInProgress: boolean;
  startupMessage: string;
  startupError: string | null;
  bootstrapRetryNonce: number;
  serverUrl: string | null;
  serverSession: PtvServerSession | null;
  userSession: PtvUserSession | null;
  userName: string | null;
  recentServers: string[];
  capabilities: PtvCapability[];
  ptvCapabilities: PtvCapability[];
  libraries: PtvLibrary[];
  playbackIntent: PtvPlaybackIntent | null;
  lastError: PtvError | null;
  settings: AppSettings;
}

export type AppAction =
  | { type: 'set_bootstrap_complete' }
  | { type: 'set_startup'; startupInProgress: boolean; startupMessage: string; startupError?: string | null }
  | { type: 'retry_bootstrap' }
  | { type: 'set_route'; route: PtvRoute; replace?: boolean }
  | { type: 'reset_route'; route: PtvRoute }
  | { type: 'go_back' }
  | { type: 'set_server_url'; serverUrl: string | null }
  | { type: 'set_server_session'; serverSession: PtvServerSession | null }
  | { type: 'set_user_session'; userSession: PtvUserSession | null; userName?: string | null }
  | { type: 'set_error'; error: PtvError | null }
  | { type: 'set_capabilities'; capabilities: PtvCapability[]; ptvCapabilities: PtvCapability[] }
  | { type: 'set_libraries'; libraries: PtvLibrary[] }
  | { type: 'set_recent_servers'; recentServers: string[] }
  | { type: 'set_playback_intent'; playbackIntent: PtvPlaybackIntent | null }
  | { type: 'advance_playback'; playbackIntent: PtvPlaybackIntent; route: PtvRoute }
  | { type: 'update_settings'; settings: Partial<AppSettings> }
  | { type: 'logout' };

export interface AppServices {
  storage: StorageRepository;
  jellyfin: JellyfinClientContext;
  auth: AuthSessionCoordinator;
  session: SessionController;
  validateServer: (
    serverUrl: string,
    timeoutMs?: number,
    hooks?: Parameters<JellyfinApiClient['validateServer']>[1],
    signal?: AbortSignal
  ) => ReturnType<JellyfinApiClient['validateServer']>;
  playback: PlaybackLifecycle;
  focusManager: FocusManager;
  requestTracker: RequestTracker;
  diagnostics: DiagnosticsService;
  startupRestore: StartupRestoreCoordinator;
  activateAuthenticatedRequestContext: (ticket: AuthenticatedSessionTicket) => void;
  logout: (target?: 'auth' | 'server') => Promise<void>;
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  services: AppServices;
}

const AppContext = createContext<AppContextValue | null>(null);

const DEFAULT_SETTINGS: AppSettings = {
  reducedMotion: false,
  defaultQuality: 'auto',
  directPlayEnabled: true,
  directStreamEnabled: true,
  transcodeEnabled: true,
  autoPlayNext: true,
  subtitleDefaultOff: false
};

function initialState(): AppState {
  return {
    initialized: false,
    route: buildRoute('startup'),
    routeHistory: [],
    startupInProgress: true,
    startupMessage: 'Starting PiggieTV',
    startupError: null,
    bootstrapRetryNonce: 0,
    serverUrl: null,
    serverSession: null,
    userSession: null,
    userName: null,
    recentServers: [],
    capabilities: [],
    ptvCapabilities: [],
    libraries: [],
    playbackIntent: null,
    lastError: null,
    settings: DEFAULT_SETTINGS
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'set_bootstrap_complete':
      return { ...state, initialized: true, startupInProgress: false };

    case 'set_startup':
      return {
        ...state,
        startupInProgress: action.startupInProgress,
        startupMessage: action.startupMessage,
        startupError: action.startupError ?? null
      };

    case 'retry_bootstrap':
      return {
        ...state,
        startupInProgress: true,
        startupMessage: 'Retrying saved session',
        startupError: null,
        bootstrapRetryNonce: state.bootstrapRetryNonce + 1
      };

    case 'set_route': {
      if (
        state.route.screen === action.route.screen &&
        state.route.itemId === action.route.itemId &&
        state.route.sectionId === action.route.sectionId
      ) {
        return { ...state, route: action.route };
      }
      if (action.replace) {
        return {
          ...state,
          routeHistory: state.routeHistory,
          route: action.route
        };
      }
      return {
        ...state,
        routeHistory: [...state.routeHistory, state.route],
        route: action.route
      };
    }

    case 'reset_route':
      return {
        ...state,
        route: action.route,
        routeHistory: []
      };

    case 'go_back': {
      if (!state.routeHistory.length) return state;
      const next = state.routeHistory[state.routeHistory.length - 1];
      if (!next) {
        return { ...state, routeHistory: [] };
      }
      return {
        ...state,
        route: next,
        routeHistory: state.routeHistory.slice(0, -1)
      };
    }

    case 'set_server_url':
      return { ...state, serverUrl: action.serverUrl };

    case 'set_server_session':
      return { ...state, serverSession: action.serverSession };

    case 'set_user_session':
      return {
        ...state,
        userSession: action.userSession,
        userName: action.userName ?? action.userSession?.userName ?? null
      };

    case 'set_error':
      return { ...state, lastError: action.error };

    case 'set_capabilities':
      return {
        ...state,
        capabilities: action.capabilities,
        ptvCapabilities: action.ptvCapabilities
      };

    case 'set_libraries':
      return { ...state, libraries: action.libraries };

    case 'set_recent_servers':
      return { ...state, recentServers: action.recentServers };

    case 'set_playback_intent':
      return { ...state, playbackIntent: action.playbackIntent };

    case 'advance_playback':
      return {
        ...state,
        playbackIntent: action.playbackIntent,
        route: action.route
      };

    case 'update_settings':
      return { ...state, settings: { ...state.settings, ...action.settings } };

    case 'logout':
      return {
        ...state,
        userSession: null,
        userName: null,
        playbackIntent: null
      };

    default:
      return state;
  }
}

export function AppProvider(props: React.PropsWithChildren) {
  const [state, dispatch] = useReducer(appReducer, initialState());
  const services = useMemo<AppServices>(() => {
    const storage = new StorageRepository();
    const focusManager = new FocusManager();
    const requestTracker = new RequestTracker();
    const diagnostics = new DiagnosticsService();
    const startupRestore = new StartupRestoreCoordinator();
    const auth = new AuthSessionCoordinator();
    const jellyfin = new JellyfinClientContext(storage.getOrCreateDeviceId(), requestTracker);
    const playback = new PlaybackLifecycle();

    const createCandidateClient = (serverUrl: string) => new JellyfinApiClient({
      baseUrl: serverUrl,
      deviceId: storage.getOrCreateDeviceId(),
      requestTracker
    });

    const installAuthenticatedRequestContext = () => {
      jellyfin.setAuthenticatedRequestContextProvider(() => {
        const context = auth.captureAuthenticatedRequest();
        if (!context) return null;
        return {
          ticket: context.ticket,
          signal: context.signal,
          isCurrent: context.isCurrent,
          onUnauthorized: ticket => {
            if (ticket !== context.ticket) return;
            void auth.handleRuntimeStatus(context, 401);
          }
        };
      });
    };

    const session = new SessionController({
      ownership: auth,
      api: {
        authenticateByName: request => createCandidateClient(request.serverUrl).authenticateByName(
            request.username,
            request.password,
            request.timeoutMs,
            request.signal,
            'authentication',
            {
              onResponseReceived: payload => request.onResponseReceived?.(payload),
              onJsonParsed: payload => request.onJsonParsed?.(payload)
            }
          ),
        initiateQuickConnect: request => createCandidateClient(request.serverUrl)
          .initiateQuickConnect(request.timeoutMs, request.signal),
        getQuickConnectState: request => createCandidateClient(request.serverUrl)
          .getQuickConnectState(
            request.secret,
            request.timeoutMs,
            request.signal,
            {
              onResponseReceived: payload => request.onResponseReceived?.(payload),
              onJsonParsed: payload => request.onJsonParsed?.(payload)
            }
          ),
        authenticateWithQuickConnect: request => createCandidateClient(request.serverUrl)
          .authenticateWithQuickConnect(
            request.secret,
            request.timeoutMs,
            request.signal,
            {
              onResponseReceived: payload => request.onResponseReceived?.(payload),
              onJsonParsed: payload => request.onJsonParsed?.(payload)
            }
          ),
        setAuthenticationContext: authenticated => {
          // Fail closed during the tiny persistence-to-epoch handoff. Once the
          // coordinator commits, the hook below installs the real epoch provider.
          jellyfin.setAuthenticatedRequestContextProvider(() => null);
          jellyfin.configureSession(authenticated.serverUrl, authenticated.accessToken);
        },
        activateAuthenticatedRequestContext: ticket => {
          const current = auth.captureAuthenticatedRequest();
          if (!current || current.ticket !== ticket) {
            throw new Error('Authenticated request ownership could not be activated');
          }
          installAuthenticatedRequestContext();
        }
      },
      persistence: {
        persistSessionAtomically: (authenticated, context, activate) => storage.saveSession({
            schemaVersion: 1,
            serverUrl: authenticated.serverUrl,
            serverId: authenticated.serverId,
            accessToken: authenticated.accessToken,
            userId: authenticated.userId,
            userName: authenticated.userName,
            deviceId: authenticated.deviceId,
            deviceName: authenticated.deviceName,
            applicationVersion: authenticated.applicationVersion,
            savedAt: authenticated.savedAt
          }, {
            signal: context.signal,
            isCurrent: context.isCurrent
          }, activate)
      },
      state: {
        commitAuthenticatedSession: authenticated => {
          dispatch({
            type: 'set_user_session',
            userSession: {
              userId: authenticated.userId,
              userName: authenticated.userName,
              serverId: authenticated.serverId,
              serverUrl: authenticated.serverUrl,
              deviceId: authenticated.deviceId,
              createdAt: authenticated.savedAt,
              updatedAt: authenticated.savedAt
            },
            userName: authenticated.userName
          });
        }
      },
      navigation: {
        navigateHome: () => {
          dispatch({ type: 'reset_route', route: buildRoute('home') });
        }
      },
      getDeviceIdentity: () => ({
        deviceId: storage.getOrCreateDeviceId(),
        deviceName: PTV_DEVICE_NAME,
        applicationVersion: PTV_APPLICATION_VERSION
      }),
      diagnostics: {
        record: snapshot => diagnostics.recordSessionSnapshot({ ...snapshot })
      }
    });

    const clearVisibleSession = (target: 'auth' | 'server', message: string, error: string | null) => {
      session.cancelCurrentAttempt();
      jellyfin.reset();
      dispatch({ type: 'logout' });
      dispatch({ type: 'set_capabilities', capabilities: [], ptvCapabilities: [] });
      dispatch({ type: 'set_libraries', libraries: [] });
      dispatch({
        type: 'set_startup',
        startupInProgress: false,
        startupMessage: message,
        startupError: error
      });
      dispatch({ type: 'reset_route', route: buildRoute(target) });
      void playback.stop('superseded').catch(() => {
        diagnostics.logWarn('Playback cleanup did not complete during local session rejection');
      });
    };

    auth.setCurrentSessionRejectionHandler(async () => {
      try {
        storage.armSessionClearBarrier();
      } catch (error) {
        clearVisibleSession('auth', 'Secure session cleanup failed', 'SECURE_STORAGE_FAILURE');
        throw error;
      }

      clearVisibleSession('auth', 'Session expired', 'Your session expired. Sign in again.');
      await storage.completePendingSessionClear();
    });

    const logout = async (target: 'auth' | 'server' = 'auth') => {
      const lease = auth.beginLogout();
      const retiring = jellyfin.captureRetiringAuthorization();

      try {
        storage.armSessionClearBarrier();
      } catch (error) {
        auth.failStorage(lease);
        clearVisibleSession(target, 'Secure logout failed', 'SECURE_STORAGE_FAILURE');
        throw error;
      }

      clearVisibleSession(target, target === 'server' ? 'Choose a server' : 'Signed out', null);

      if (retiring) {
        void retiring.client.logout(retiring.accessToken).then(
          () => diagnostics.recordSessionSnapshot({
            ...auth.getSnapshot(),
            serverRevocation: 'success'
          }),
          () => diagnostics.recordSessionSnapshot({
            ...auth.getSnapshot(),
            serverRevocation: 'failed'
          })
        );
      }

      try {
        await storage.completePendingSessionClear();
      } catch (error) {
        auth.failStorage(lease);
        dispatch({
          type: 'set_startup',
          startupInProgress: false,
          startupMessage: 'Secure logout failed',
          startupError: 'SECURE_STORAGE_FAILURE'
        });
        throw error;
      }

      auth.completeLogout(lease);
    };

    auth.subscribe(snapshot => diagnostics.recordSessionSnapshot({ ...snapshot }));
    diagnostics.attachTracker(requestTracker);
    return {
      storage,
      jellyfin,
      auth,
      session,
      validateServer: (serverUrl, timeoutMs, hooks, signal) => createCandidateClient(serverUrl)
        .validateServer(timeoutMs, hooks, signal),
      playback,
      focusManager,
      requestTracker,
      diagnostics,
      startupRestore,
      activateAuthenticatedRequestContext: ticket => {
        const current = auth.captureAuthenticatedRequest();
        if (!current || current.ticket !== ticket) {
          throw new Error('Authenticated request ownership is stale');
        }
        installAuthenticatedRequestContext();
      },
      logout
    };
  }, [dispatch]);

  return <AppContext.Provider value={{ state, dispatch, services }}>{props.children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used inside an AppProvider');
  }
  return context;
}
