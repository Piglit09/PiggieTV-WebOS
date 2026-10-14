import { describe, expect, it, vi } from 'vitest';
import {
  AuthSessionCoordinator,
  type AuthenticatedSessionTicket
} from '../src/auth/authSessionCoordinator';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commitPassword(coordinator: AuthSessionCoordinator): AuthenticatedSessionTicket {
  const lease = coordinator.beginPasswordAuthentication();
  const ticket = coordinator.commitAuthenticated(lease);
  if (!ticket) throw new Error('Expected authenticated ticket');
  return ticket;
}

describe('AuthSessionCoordinator operation ownership', () => {
  it('uses one generation across restore, password, and Quick Connect operations', () => {
    const coordinator = new AuthSessionCoordinator();
    const restore = coordinator.beginRestore();

    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'RESTORING',
      generation: 1,
      activeOperation: 'restore'
    });
    expect(coordinator.markValidating(restore)).toBe(true);
    expect(coordinator.getSnapshot().state).toBe('VALIDATING');

    const password = coordinator.beginPasswordAuthentication();
    expect(restore.signal.aborted).toBe(true);
    expect(restore.isCurrent()).toBe(false);
    expect(coordinator.markValidating(restore)).toBe(false);
    expect(password.generation).toBe(2);
    expect(coordinator.getSnapshot().state).toBe('AUTHENTICATING');

    const quickConnect = coordinator.beginQuickConnect();
    expect(password.signal.aborted).toBe(true);
    expect(password.isCurrent()).toBe(false);
    expect(quickConnect.generation).toBe(3);
    expect(quickConnect.isCurrent()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'QUICK_CONNECT_WAITING',
      activeOperation: 'quick-connect'
    });
    expect(coordinator.markAuthenticating(quickConnect)).toBe(true);
    expect(coordinator.getSnapshot().state).toBe('AUTHENTICATING');

    const replacement = coordinator.beginPasswordAuthentication();
    expect(coordinator.markAuthenticating(quickConnect)).toBe(false);
    expect(coordinator.markAuthenticating(replacement)).toBe(false);
    expect(coordinator.getSnapshot().state).toBe('AUTHENTICATING');
  });

  it('prevents a superseded authentication completion from surviving logout', () => {
    const coordinator = new AuthSessionCoordinator();
    commitPassword(coordinator);
    const request = coordinator.captureAuthenticatedRequest();
    const replacementLogin = coordinator.beginPasswordAuthentication();

    const logout = coordinator.beginLogout();

    expect(replacementLogin.signal.aborted).toBe(true);
    expect(request?.signal.aborted).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'LOGGING_OUT',
      authenticated: false,
      credentialEpoch: null
    });
    expect(coordinator.commitAuthenticated(replacementLogin)).toBeNull();
    expect(coordinator.completeLogout(logout)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      authenticated: false,
      activeOperation: null
    });
  });

  it('preserves the current credential epoch when a replacement candidate fails or is cancelled', () => {
    const coordinator = new AuthSessionCoordinator();
    const originalTicket = commitPassword(coordinator);
    const originalRequest = coordinator.captureAuthenticatedRequest();

    const password = coordinator.beginPasswordAuthentication();
    expect(coordinator.failConnectivity(password)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      authenticated: true,
      credentialEpoch: originalTicket.credentialEpoch,
      lastFailure: 'CONNECTIVITY_ERROR'
    });
    expect(originalRequest?.isCurrent()).toBe(true);

    const quickConnect = coordinator.beginQuickConnect();
    expect(coordinator.cancel(quickConnect)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      credentialEpoch: originalTicket.credentialEpoch,
      lastFailure: null
    });
    expect(originalRequest?.isCurrent()).toBe(true);

    const rejectedCandidate = coordinator.beginPasswordAuthentication();
    expect(coordinator.rejectAuthentication(rejectedCandidate)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      credentialEpoch: originalTicket.credentialEpoch,
      lastFailure: 'AUTH_REJECTED'
    });
    expect(originalRequest?.isCurrent()).toBe(true);
  });

  it('notifies subscribers with snapshots while isolating subscriber errors', () => {
    const coordinator = new AuthSessionCoordinator();
    const states: string[] = [];
    coordinator.subscribe(() => {
      throw new Error('subscriber failed');
    });
    const unsubscribe = coordinator.subscribe(snapshot => states.push(snapshot.state));

    const restore = coordinator.beginRestore();
    coordinator.markValidating(restore);
    coordinator.completeUnauthenticated(restore);
    unsubscribe();
    coordinator.beginPasswordAuthentication();

    expect(states).toEqual(['UNAUTHENTICATED', 'RESTORING', 'VALIDATING', 'UNAUTHENTICATED']);
  });

  it('returns rejected password and Quick Connect candidates to the prior stable state', () => {
    const coordinator = new AuthSessionCoordinator();
    const password = coordinator.beginPasswordAuthentication();

    expect(coordinator.rejectAuthentication(password)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      authenticated: false,
      lastFailure: 'AUTH_REJECTED'
    });

    const quickConnect = coordinator.beginQuickConnect();
    expect(coordinator.rejectAuthentication(quickConnect)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      authenticated: false,
      lastFailure: 'AUTH_REJECTED'
    });
  });

  it('keeps rejected restored credentials transitional until durable cleanup completes', () => {
    const coordinator = new AuthSessionCoordinator();
    const restore = coordinator.beginRestore();
    coordinator.markValidating(restore);

    expect(coordinator.rejectAuthentication(restore)).toBe(false);
    expect(coordinator.rejectRestoredCredential(restore)).toBe(true);
    expect(restore.isCurrent()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTH_REJECTED',
      activeOperation: 'restore',
      lastFailure: 'AUTH_REJECTED'
    });

    expect(coordinator.completeUnauthenticated(restore)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'UNAUTHENTICATED',
      activeOperation: null,
      authenticated: false
    });
  });
});

describe('AuthSessionCoordinator credential epochs and runtime 401', () => {
  it('synchronously rejects only the current credential epoch', async () => {
    const onCurrentSessionRejected = vi.fn();
    const coordinator = new AuthSessionCoordinator({ onCurrentSessionRejected });
    commitPassword(coordinator);
    const context = coordinator.captureAuthenticatedRequest();
    if (!context) throw new Error('Expected authenticated request context');

    const handled = coordinator.handleRuntimeStatus(context, 401);

    expect(context.signal.aborted).toBe(true);
    expect(context.isCurrent()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTH_REJECTED',
      authenticated: false,
      credentialEpoch: null
    });
    expect(onCurrentSessionRejected).toHaveBeenCalledTimes(1);
    await expect(handled).resolves.toBe(true);
    expect(coordinator.getSnapshot().state).toBe('UNAUTHENTICATED');
  });

  it('ignores a stale 401 after a new login, including when the server issued the same token', async () => {
    const onCurrentSessionRejected = vi.fn();
    const coordinator = new AuthSessionCoordinator({ onCurrentSessionRejected });
    const firstTicket = commitPassword(coordinator);
    const staleRequest = coordinator.captureAuthenticatedRequest();
    if (!staleRequest) throw new Error('Expected first request context');

    // Credential values never enter this coordinator. A new successful commit
    // always gets a new exact ticket even if Jellyfin reused the same token.
    const secondTicket = commitPassword(coordinator);
    const currentRequest = coordinator.captureAuthenticatedRequest();

    expect(secondTicket).not.toBe(firstTicket);
    expect(secondTicket.credentialEpoch).toBe(firstTicket.credentialEpoch + 1);
    expect(staleRequest.signal.aborted).toBe(true);
    await expect(coordinator.handleRuntimeStatus(staleRequest, 401)).resolves.toBe(false);
    expect(onCurrentSessionRejected).not.toHaveBeenCalled();
    expect(currentRequest?.isCurrent()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      credentialEpoch: secondTicket.credentialEpoch
    });
  });

  it('coalesces duplicate 401 handling for one exact ticket', async () => {
    const cleanup = deferred<void>();
    const onCurrentSessionRejected = vi.fn(() => cleanup.promise);
    const coordinator = new AuthSessionCoordinator({ onCurrentSessionRejected });
    commitPassword(coordinator);
    const firstRequest = coordinator.captureAuthenticatedRequest();
    const secondRequest = coordinator.captureAuthenticatedRequest();
    if (!firstRequest || !secondRequest) throw new Error('Expected request contexts');

    const first = coordinator.handleRuntimeStatus(firstRequest, 401);
    const duplicate = coordinator.handleRuntimeStatus(secondRequest, 401);

    expect(duplicate).toBe(first);
    expect(onCurrentSessionRejected).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await expect(first).resolves.toBe(true);
    expect(onCurrentSessionRejected).toHaveBeenCalledTimes(1);
    await expect(coordinator.handleRuntimeStatus(firstRequest, 401)).resolves.toBe(false);
    expect(onCurrentSessionRejected).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed rejection cleanup overwrite a newer login', async () => {
    const cleanup = deferred<void>();
    const coordinator = new AuthSessionCoordinator({
      onCurrentSessionRejected: () => cleanup.promise
    });
    commitPassword(coordinator);
    const rejectedRequest = coordinator.captureAuthenticatedRequest();
    if (!rejectedRequest) throw new Error('Expected request context');
    const rejection = coordinator.handleRuntimeStatus(rejectedRequest, 401);

    const replacementTicket = commitPassword(coordinator);
    cleanup.resolve();
    await expect(rejection).resolves.toBe(true);

    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      credentialEpoch: replacementTicket.credentialEpoch,
      authenticated: true
    });
  });

  it('aborts every request from a replaced credential epoch', () => {
    const coordinator = new AuthSessionCoordinator();
    commitPassword(coordinator);
    const first = coordinator.captureAuthenticatedRequest();
    const second = coordinator.captureAuthenticatedRequest();
    if (!first || !second) throw new Error('Expected request contexts');

    commitPassword(coordinator);
    const replacement = coordinator.captureAuthenticatedRequest();

    expect(first.signal).toBe(second.signal);
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    expect(replacement?.signal).not.toBe(first.signal);
    expect(replacement?.isCurrent()).toBe(true);
  });

  it('does not change auth state for non-401 statuses', async () => {
    const onCurrentSessionRejected = vi.fn();
    const coordinator = new AuthSessionCoordinator({ onCurrentSessionRejected });
    const ticket = commitPassword(coordinator);
    const context = coordinator.captureAuthenticatedRequest();
    if (!context) throw new Error('Expected request context');

    await expect(coordinator.handleRuntimeStatus(context, 403)).resolves.toBe(false);
    await expect(coordinator.handleRuntimeStatus(context, 500)).resolves.toBe(false);

    expect(context.isCurrent()).toBe(true);
    expect(onCurrentSessionRejected).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'AUTHENTICATED',
      credentialEpoch: ticket.credentialEpoch
    });
  });
});

describe('AuthSessionCoordinator failure states', () => {
  it('surfaces restore connectivity and storage failures without minting a ticket', () => {
    const connectivityCoordinator = new AuthSessionCoordinator();
    const connectivityRestore = connectivityCoordinator.beginRestore();
    expect(connectivityCoordinator.failConnectivity(connectivityRestore)).toBe(true);
    expect(connectivityRestore.signal.aborted).toBe(true);
    expect(connectivityCoordinator.getSnapshot()).toMatchObject({
      state: 'CONNECTIVITY_ERROR',
      authenticated: false,
      credentialEpoch: null,
      lastFailure: 'CONNECTIVITY_ERROR'
    });

    const storageCoordinator = new AuthSessionCoordinator();
    const storageRestore = storageCoordinator.beginRestore();
    expect(storageCoordinator.failStorage(storageRestore)).toBe(true);
    expect(storageCoordinator.getSnapshot()).toMatchObject({
      state: 'STORAGE_ERROR',
      authenticated: false,
      credentialEpoch: null,
      lastFailure: 'STORAGE_ERROR'
    });
  });

  it('surfaces rejection cleanup failure without reviving the credential epoch', async () => {
    const coordinator = new AuthSessionCoordinator({
      onCurrentSessionRejected: () => Promise.reject(new Error('cleanup failed'))
    });
    commitPassword(coordinator);
    const context = coordinator.captureAuthenticatedRequest();
    if (!context) throw new Error('Expected request context');

    await expect(coordinator.handleRuntimeStatus(context, 401)).resolves.toBe(true);

    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'STORAGE_ERROR',
      authenticated: false,
      credentialEpoch: null,
      lastFailure: 'STORAGE_ERROR'
    });
    expect(coordinator.captureAuthenticatedRequest()).toBeNull();
  });

  it('remains fail-closed while surfacing a local logout storage failure', () => {
    const coordinator = new AuthSessionCoordinator();
    commitPassword(coordinator);
    const context = coordinator.captureAuthenticatedRequest();
    const logout = coordinator.beginLogout();

    expect(coordinator.failStorage(logout)).toBe(true);
    expect(context?.signal.aborted).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'STORAGE_ERROR',
      authenticated: false,
      credentialEpoch: null,
      lastFailure: 'STORAGE_ERROR'
    });
  });
});
