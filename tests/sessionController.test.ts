import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUEST_TIMEOUT_MS,
  SessionController,
  type AuthenticationResponse,
  type PasswordAuthenticationRequest,
  type PersistedAuthenticatedSession,
  type SessionApi,
  type SessionControllerDependencies,
  type SessionDiagnosticSnapshot,
  type SessionOperationContext
} from '../src/auth/sessionController';
import type { PtvQuickConnectStateResponse } from '../src/api/jellyfin/client';
import {
  AuthSessionCoordinator,
  type AuthenticatedSessionTicket
} from '../src/auth/authSessionCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const validResponse = (userId = 'user-123456'): AuthenticationResponse => ({
  AccessToken: 'access-token-value',
  ServerId: 'server-1',
  User: { Id: userId, Name: 'Piggie User' }
});

const quickConnectState = (authenticated: boolean): PtvQuickConnectStateResponse => ({
  Authenticated: authenticated,
  Secret: 'quick-secret',
  Code: 'ABCD12',
  DateAdded: '2026-08-01T00:00:00Z',
  DeviceId: 'stable-device-id',
  DeviceName: 'Living Room TV',
  AppName: 'PiggieTV',
  AppVersion: '0.1.0'
});

type HarnessOverrides = Omit<Partial<SessionControllerDependencies>, 'api'> & {
  api?: Partial<SessionApi>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const diagnostics: SessionDiagnosticSnapshot[] = [];
  const order: string[] = [];
  const navigationCurrentChecks: boolean[] = [];
  const activationStates: string[] = [];
  const persisted: PersistedAuthenticatedSession[] = [];
  const ownership = overrides.ownership ?? new AuthSessionCoordinator();
  const authenticateByName = vi.fn(async (request: PasswordAuthenticationRequest) => {
    request.onResponseReceived?.({ status: 200, contentType: 'application/json' });
    request.onJsonParsed?.({ status: 200, contentType: 'application/json' });
    return validResponse();
  });
  const setAuthenticationContext = vi.fn(() => {
    order.push('api-context');
  });
  const activateAuthenticatedRequestContext = vi.fn((
    ticket: AuthenticatedSessionTicket
  ) => {
    void ticket;
    activationStates.push(ownership.getSnapshot().state);
    order.push('activate-context');
  });
  const persistSessionAtomically = vi.fn(async (
    session: PersistedAuthenticatedSession,
    _context: SessionOperationContext,
    activate: () => AuthenticatedSessionTicket
  ) => {
    order.push('persist');
    persisted.push(session);
    return activate();
  });
  const commitAuthenticatedSession = vi.fn(() => {
    order.push('state');
  });
  const navigateHome = vi.fn((context: SessionOperationContext) => {
    navigationCurrentChecks.push(context.isCurrent());
    order.push('navigate');
  });

  const base: SessionControllerDependencies = {
    ...overrides,
    ownership,
    api: {
      authenticateByName,
      setAuthenticationContext,
      activateAuthenticatedRequestContext,
      ...overrides.api
    },
    persistence: overrides.persistence ?? { persistSessionAtomically },
    state: overrides.state ?? { commitAuthenticatedSession },
    navigation: overrides.navigation ?? { navigateHome },
    getDeviceIdentity: overrides.getDeviceIdentity ?? (() => ({
      deviceId: 'stable-device-id',
      deviceName: 'Living Room TV',
      applicationVersion: '0.1.0'
    })),
    diagnostics: overrides.diagnostics ?? { record: snapshot => diagnostics.push(snapshot) }
  };
  const controller = new SessionController(base);

  return {
    controller,
    diagnostics,
    order,
    navigationCurrentChecks,
    activationStates,
    persisted,
    ownership,
    authenticateByName,
    setAuthenticationContext,
    activateAuthenticatedRequestContext,
    persistSessionAtomically,
    commitAuthenticatedSession,
    navigateHome
  };
}

const passwordInput = {
  serverUrl: 'https://PiggieTV.com/',
  serverId: 'server-1',
  username: 'piggie',
  password: ' password with spaces '
};

describe('SessionController password authentication', () => {
  it('commits a valid response in the authoritative order and navigates once', async () => {
    const harness = createHarness();

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result.status).toBe('success');
    expect(result.classification).toBe('success');
    expect(harness.order).toEqual(['persist', 'api-context', 'activate-context', 'state', 'navigate']);
    expect(harness.navigateHome).toHaveBeenCalledTimes(1);
    const [ticket] = harness.activateAuthenticatedRequestContext.mock.calls[0] ?? [];
    const navigationContext = harness.navigateHome.mock.calls[0]?.[0];
    expect(ticket).toBe(harness.ownership.captureAuthenticatedRequest()?.ticket);
    expect(navigationContext?.signal).toBe(harness.ownership.captureAuthenticatedRequest()?.signal);
    expect(harness.navigationCurrentChecks).toEqual([true]);
    expect(harness.activationStates).toEqual(['AUTHENTICATED']);
    expect(harness.ownership.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      activeOperation: null,
      authenticated: true
    });
    expect(harness.persisted).toHaveLength(1);
    expect(harness.persisted[0]).toMatchObject({
      schemaVersion: 1,
      serverUrl: 'https://piggietv.com',
      serverId: 'server-1',
      userId: 'user-123456',
      userName: 'Piggie User',
      deviceId: 'stable-device-id',
      deviceName: 'Living Room TV',
      applicationVersion: '0.1.0'
    });
    expect(harness.authenticateByName.mock.calls[0]?.[0]).toMatchObject({
      password: ' password with spaces ',
      timeoutMs: AUTH_REQUEST_TIMEOUT_MS
    });
    expect(harness.authenticateByName.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);

    expect(harness.diagnostics.map(entry => entry.stage)).toEqual([
      'VALIDATING_INPUT',
      'REQUEST_STARTED',
      'RESPONSE_RECEIVED',
      'AUTH_JSON_PARSED',
      'AUTH_RESULT_VALIDATED',
      'SESSION_PERSIST_STARTED',
      'SESSION_PERSISTED',
      'API_CONTEXT_UPDATED',
      'AUTH_STATE_COMMITTED',
      'NAVIGATION_REQUESTED',
      'COMPLETE'
    ]);
    expect(harness.diagnostics.at(-1)?.navigationRequestCount).toBe(1);
    expect(harness.diagnostics.at(-1)?.stageHistory.map(entry => entry.stage)).toEqual(
      harness.diagnostics.map(entry => entry.stage)
    );
    expect(harness.controller.getState()).toMatchObject({
      status: 'success',
      stage: 'COMPLETE',
      activeAttemptId: null,
      errorMessage: null
    });
  });

  it('returns the current promise for a duplicate submission', async () => {
    const response = deferred<AuthenticationResponse>();
    const authenticateByName = vi.fn(() => response.promise);
    const harness = createHarness({
      api: {
        authenticateByName,
        setAuthenticationContext: vi.fn()
      }
    });

    const first = harness.controller.authenticateByName(passwordInput);
    const duplicate = harness.controller.authenticateByName({ ...passwordInput });

    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(authenticateByName).toHaveBeenCalledTimes(1));
    expect(authenticateByName).toHaveBeenCalledTimes(1);
    response.resolve(validResponse());
    await first;
  });

  it('continues persistence and navigation after the initiating view unsubscribes', async () => {
    const response = deferred<AuthenticationResponse>();
    const authenticateByName = vi.fn(() => response.promise);
    const harness = createHarness({
      api: {
        authenticateByName,
        setAuthenticationContext: vi.fn()
      }
    });
    const subscriber = vi.fn();
    const unsubscribe = harness.controller.subscribe(subscriber);
    const operation = harness.controller.authenticateByName(passwordInput);

    unsubscribe();
    response.resolve(validResponse());
    const result = await operation;

    expect(result.status).toBe('success');
    expect(harness.persistSessionAtomically).toHaveBeenCalledTimes(1);
    expect(harness.navigateHome).toHaveBeenCalledTimes(1);
  });

  it('enters an error terminal state for invalid credentials', async () => {
    const authenticateByName = vi.fn(async () => {
      throw { status: 401, message: 'Invalid user' };
    });
    const harness = createHarness({
      api: {
        authenticateByName,
        setAuthenticationContext: vi.fn()
      }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result).toMatchObject({ status: 'error', classification: 'invalid-credentials' });
    expect(harness.controller.getState()).toMatchObject({ status: 'error', stage: 'FAILED' });
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
    expect(harness.navigateHome).not.toHaveBeenCalled();
  });

  it('preserves an incumbent authenticated epoch when replacement credentials are rejected', async () => {
    const ownership = new AuthSessionCoordinator();
    const restore = ownership.beginRestore();
    const incumbentTicket = ownership.commitAuthenticated(restore);
    const incumbentContext = ownership.captureAuthenticatedRequest();
    const harness = createHarness({
      ownership,
      api: {
        authenticateByName: vi.fn(async () => {
          throw { status: 401, message: 'Invalid user' };
        })
      }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result).toMatchObject({ status: 'error', classification: 'invalid-credentials' });
    expect(ownership.captureAuthenticatedRequest()?.ticket).toBe(incumbentTicket);
    expect(incumbentContext?.isCurrent()).toBe(true);
    expect(ownership.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      activeOperation: null,
      authenticated: true,
      lastFailure: 'AUTH_REJECTED'
    });
    expect(harness.setAuthenticationContext).not.toHaveBeenCalled();
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
  });

  it('maps a connectivity failure and releases the global operation lease', async () => {
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(async () => {
          throw new TypeError('Network request failed');
        })
      }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result).toMatchObject({ status: 'error', classification: 'network-error' });
    expect(harness.ownership.getSnapshot()).toMatchObject({
      state: 'CONNECTIVITY_ERROR',
      activeOperation: null,
      authenticated: false,
      lastFailure: 'CONNECTIVITY_ERROR'
    });
  });

  it('rejects a malformed authentication response before persistence', async () => {
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(async () => ({
          ServerId: 'server-1',
          User: { Id: 'user-1', Name: 'Piggie User' }
        })),
        setAuthenticationContext: vi.fn()
      }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result).toMatchObject({ status: 'error', classification: 'invalid-response' });
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
    expect(harness.diagnostics.at(-1)?.stage).toBe('FAILED');
    expect(harness.ownership.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      activeOperation: null,
      lastFailure: null
    });
  });

  it('uses the validated server ID when Jellyfin omits ServerId', async () => {
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(async () => ({
          AccessToken: 'token-without-server-id',
          User: { Id: 'user-fallback', Name: 'Fallback User' }
        })),
        setAuthenticationContext: vi.fn()
      }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result.status).toBe('success');
    expect(harness.persisted[0]?.serverId).toBe('server-1');
  });

  it('does not allow a superseded response to overwrite a newer attempt', async () => {
    const oldResponse = deferred<AuthenticationResponse>();
    const newResponse = deferred<AuthenticationResponse>();
    const authenticateByName = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const harness = createHarness({
      api: {
        authenticateByName,
        setAuthenticationContext: vi.fn()
      }
    });

    const oldOperation = harness.controller.authenticateByName({ ...passwordInput, username: 'old-user' });
    await vi.waitFor(() => expect(authenticateByName).toHaveBeenCalledTimes(1));
    const newOperation = harness.controller.authenticateByName({ ...passwordInput, username: 'new-user' });
    const oldResult = await oldOperation;
    expect(oldResult).toMatchObject({ status: 'idle', classification: 'stale' });

    newResponse.resolve(validResponse('new-user-id'));
    const newResult = await newOperation;
    oldResponse.resolve(validResponse('old-user-id'));
    await Promise.resolve();

    expect(newResult.status).toBe('success');
    expect(harness.persisted.map(session => session.userId)).toEqual(['new-user-id']);
    expect(harness.navigateHome).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState()).toMatchObject({ status: 'success', stage: 'COMPLETE' });
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptId: oldResult.attemptId, stage: 'CANCELLED', stale: true })
      ])
    );
  });

  it('lets external logout cancel persistence without publishing or navigating stale state', async () => {
    const persistenceStarted = deferred<void>();
    const releasePersistence = deferred<void>();
    const persisted: string[] = [];
    const ownership = new AuthSessionCoordinator();
    const harness = createHarness({
      ownership,
      persistence: {
        persistSessionAtomically: vi.fn(async (session, context, activate) => {
          persistenceStarted.resolve();
          await releasePersistence.promise;
          if (!context.isCurrent()) throw new Error('superseded persistence');
          persisted.push(session.userId);
          return activate();
        })
      }
    });

    const operation = harness.controller.authenticateByName(passwordInput);
    await persistenceStarted.promise;
    const logoutLease = ownership.beginLogout();
    const result = await operation;
    releasePersistence.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({ status: 'idle', classification: 'cancelled' });
    expect(persisted).toEqual([]);
    expect(harness.setAuthenticationContext).not.toHaveBeenCalled();
    expect(harness.commitAuthenticatedSession).not.toHaveBeenCalled();
    expect(harness.activateAuthenticatedRequestContext).not.toHaveBeenCalled();
    expect(harness.navigateHome).not.toHaveBeenCalled();
    expect(ownership.getSnapshot()).toMatchObject({ state: 'LOGGING_OUT', activeOperation: 'logout' });
    expect(ownership.completeLogout(logoutLease)).toBe(true);
  });

  it('redacts passwords and tokens from diagnostics', async () => {
    const token = 'super-secret-access-token';
    const password = 'private-password';
    const diagnostics: SessionDiagnosticSnapshot[] = [];
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(async () => ({
          ...validResponse(),
          AccessToken: token
        })),
        setAuthenticationContext: vi.fn()
      },
      persistence: {
        persistSessionAtomically: vi.fn(async () => {
          throw new Error(`could not save token=${token} password=${password}`);
        })
      },
      diagnostics: { record: snapshot => diagnostics.push(snapshot) }
    });

    const result = await harness.controller.authenticateByName({ ...passwordInput, password });
    const serialized = JSON.stringify(diagnostics);

    expect(result.classification).toBe('storage-failure');
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(password);
    expect(serialized).toContain('***redacted***');
  });

  it('stops before API context, state, and navigation when persistence fails', async () => {
    const persistSessionAtomically = vi.fn(async () => {
      throw new Error('Storage quota exceeded');
    });
    const harness = createHarness({
      persistence: { persistSessionAtomically }
    });

    const result = await harness.controller.authenticateByName(passwordInput);

    expect(result).toMatchObject({ status: 'error', classification: 'storage-failure' });
    expect(harness.setAuthenticationContext).not.toHaveBeenCalled();
    expect(harness.commitAuthenticatedSession).not.toHaveBeenCalled();
    expect(harness.navigateHome).not.toHaveBeenCalled();
    expect(harness.diagnostics.at(-1)).toMatchObject({
      stage: 'FAILED',
      persistenceSucceeded: false,
      navigationRequested: false,
      navigationRequestCount: 0
    });
    expect(harness.ownership.getSnapshot()).toMatchObject({
      state: 'STORAGE_ERROR',
      activeOperation: null,
      lastFailure: 'STORAGE_ERROR'
    });
  });
});

describe('SessionController Quick Connect', () => {
  it('owns initiate, sequential state polling, and one final authentication for duplicate starts', async () => {
    const order: string[] = [];
    const initiateQuickConnect = vi.fn(async () => ({ Secret: 'quick-secret', Code: 'ABCD12' }));
    initiateQuickConnect.mockImplementation(async () => {
      order.push('initiate');
      return { Secret: 'quick-secret', Code: 'ABCD12' };
    });
    const getQuickConnectState = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('state:false');
        return quickConnectState(false);
      })
      .mockImplementationOnce(async () => {
        order.push('state:true');
        return quickConnectState(true);
      });
    const authenticateWithQuickConnect = vi.fn(async () => {
      order.push('authenticate');
      return validResponse('quick-user');
    });
    const setAuthenticationContext = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const ownership = new AuthSessionCoordinator();
    const authStates: string[] = [];
    ownership.subscribe(snapshot => authStates.push(snapshot.state));
    const harness = createHarness({
      ownership,
      api: {
        authenticateByName: vi.fn(),
        initiateQuickConnect,
        getQuickConnectState,
        authenticateWithQuickConnect,
        setAuthenticationContext
      },
      sleep
    });

    const first = harness.controller.startQuickConnect({
      serverUrl: 'https://piggietv.com',
      serverId: 'server-1'
    });
    const duplicate = harness.controller.startQuickConnect({
      serverUrl: 'https://piggietv.com/',
      serverId: 'server-1'
    });

    expect(duplicate).toBe(first);
    const result = await first;

    expect(result.status).toBe('success');
    expect(initiateQuickConnect).toHaveBeenCalledTimes(1);
    expect(getQuickConnectState).toHaveBeenCalledTimes(2);
    expect(authenticateWithQuickConnect).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['initiate', 'state:false', 'state:true', 'authenticate']);
    expect(getQuickConnectState.mock.calls[0]?.[0]).toMatchObject({
      secret: 'quick-secret',
      timeoutMs: AUTH_REQUEST_TIMEOUT_MS
    });
    const attemptSignal = initiateQuickConnect.mock.calls[0]?.[0].signal;
    expect(attemptSignal).toBeInstanceOf(AbortSignal);
    expect(getQuickConnectState.mock.calls[0]?.[0].signal).toBe(attemptSignal);
    expect(authenticateWithQuickConnect.mock.calls[0]?.[0]).toMatchObject({ secret: 'quick-secret' });
    expect(authenticateWithQuickConnect.mock.calls[0]?.[0].signal).toBe(attemptSignal);
    expect(harness.persistSessionAtomically).toHaveBeenCalledTimes(1);
    expect(harness.navigateHome).toHaveBeenCalledTimes(1);
    expect(authStates).toEqual(expect.arrayContaining([
      'QUICK_CONNECT_WAITING',
      'AUTHENTICATING',
      'AUTHENTICATED'
    ]));
    expect(authStates.indexOf('QUICK_CONNECT_WAITING')).toBeLessThan(authStates.indexOf('AUTHENTICATING'));
    expect(authStates.indexOf('AUTHENTICATING')).toBeLessThan(authStates.indexOf('AUTHENTICATED'));
    expect(JSON.stringify(harness.diagnostics)).not.toContain('quick-secret');
  });

  it('cancels an in-flight state poll without performing the final authentication', async () => {
    const stateResponse = deferred<PtvQuickConnectStateResponse>();
    const getQuickConnectState = vi.fn(() => stateResponse.promise);
    const authenticateWithQuickConnect = vi.fn(async () => validResponse('quick-user'));
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(),
        initiateQuickConnect: vi.fn(async () => ({ Secret: 'cancel-secret', Code: 'CANCEL' })),
        getQuickConnectState,
        authenticateWithQuickConnect,
        setAuthenticationContext: vi.fn()
      },
      sleep: async () => undefined
    });

    const operation = harness.controller.startQuickConnect({
      serverUrl: 'https://piggietv.com',
      serverId: 'server-1'
    });
    await vi.waitFor(() => expect(getQuickConnectState).toHaveBeenCalledTimes(1));
    const signal = getQuickConnectState.mock.calls[0]?.[0].signal;

    harness.controller.cancelCurrentAttempt();
    const result = await operation;

    expect(result).toMatchObject({ status: 'idle', classification: 'cancelled' });
    expect(signal.aborted).toBe(true);
    expect(authenticateWithQuickConnect).not.toHaveBeenCalled();
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
    expect(harness.navigateHome).not.toHaveBeenCalled();
    expect(harness.ownership.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      activeOperation: null,
      authenticated: false
    });
    expect(JSON.stringify({ result, diagnostics: harness.diagnostics })).not.toContain('cancel-secret');
  });

  it('rejects a malformed state response and redacts its secret', async () => {
    const secret = 'state-secret-value';
    const authenticateWithQuickConnect = vi.fn(async () => validResponse('quick-user'));
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(),
        initiateQuickConnect: vi.fn(async () => ({ Secret: secret, Code: 'STATE1' })),
        getQuickConnectState: vi.fn(async () => ({
          ...quickConnectState(true),
          Secret: secret,
          Authenticated: 'yes' as unknown as boolean
        })),
        authenticateWithQuickConnect,
        setAuthenticationContext: vi.fn()
      },
      sleep: async () => undefined
    });

    const result = await harness.controller.startQuickConnect({
      serverUrl: 'https://piggietv.com',
      serverId: 'server-1'
    });

    expect(result).toMatchObject({ status: 'error', classification: 'invalid-response' });
    expect(authenticateWithQuickConnect).not.toHaveBeenCalled();
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, diagnostics: harness.diagnostics })).not.toContain(secret);
  });

  it('treats a state lookup error as terminal and redacts its secret', async () => {
    const secret = 'lookup-secret-value';
    const getQuickConnectState = vi.fn(async () => {
      throw { status: 404, message: `Unknown secret=${secret}` };
    });
    const authenticateWithQuickConnect = vi.fn(async () => validResponse('quick-user'));
    const harness = createHarness({
      api: {
        authenticateByName: vi.fn(),
        initiateQuickConnect: vi.fn(async () => ({ Secret: secret, Code: 'LOOKUP' })),
        getQuickConnectState,
        authenticateWithQuickConnect,
        setAuthenticationContext: vi.fn()
      },
      sleep: async () => undefined
    });

    const result = await harness.controller.startQuickConnect({
      serverUrl: 'https://piggietv.com',
      serverId: 'server-1'
    });
    const serialized = JSON.stringify({ result, diagnostics: harness.diagnostics });

    expect(result.status).toBe('error');
    expect(getQuickConnectState).toHaveBeenCalledTimes(1);
    expect(authenticateWithQuickConnect).not.toHaveBeenCalled();
    expect(harness.persistSessionAtomically).not.toHaveBeenCalled();
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('***redacted***');
  });
});
