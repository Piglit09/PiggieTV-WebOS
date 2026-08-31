import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionCoordinator } from '../src/auth/authSessionCoordinator';
import {
  attachAuthenticatedResourceErrorBridge,
  type AuthenticatedResourceSession
} from '../src/auth/authenticatedResourceErrorBridge';
import { JellyfinApiClient } from '../src/api/jellyfin/client';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resourceError(element: HTMLElement) {
  document.body.append(element);
  element.dispatchEvent(new Event('error', { bubbles: false }));
  element.remove();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('authenticated resource error bridge', () => {
  it('validates only authenticated image and media element failures', async () => {
    const validateSession = vi.fn(async () => ({}));
    let session: AuthenticatedResourceSession | null = null;
    const detach = attachAuthenticatedResourceErrorBridge({
      eventTarget: window,
      getCurrentSession: () => session,
      getAuthenticatedClient: () => ({ validateSession }),
      throttleMs: 0,
      validationTimeoutMs: 3_000
    });

    resourceError(document.createElement('img'));
    resourceError(document.createElement('div'));
    expect(validateSession).not.toHaveBeenCalled();

    session = { userId: 'user-1', credentialEpoch: 1 };
    resourceError(document.createElement('img'));
    await settle();
    resourceError(document.createElement('video'));
    await settle();
    resourceError(document.createElement('audio'));
    await settle();

    expect(validateSession).toHaveBeenCalledTimes(3);
    expect(validateSession).toHaveBeenNthCalledWith(1, 'user-1', 3_000);

    detach();
    resourceError(document.createElement('img'));
    expect(validateSession).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent failures and throttles repeated probes for one credential epoch', async () => {
    let currentTime = 100;
    const first = deferred<unknown>();
    const validateSession = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({});
    const detach = attachAuthenticatedResourceErrorBridge({
      eventTarget: window,
      getCurrentSession: () => ({ userId: 'user-1', credentialEpoch: 4 }),
      getAuthenticatedClient: () => ({ validateSession }),
      throttleMs: 5_000,
      now: () => currentTime
    });

    resourceError(document.createElement('img'));
    resourceError(document.createElement('video'));
    expect(validateSession).toHaveBeenCalledTimes(1);

    first.resolve({});
    await settle();
    resourceError(document.createElement('audio'));
    expect(validateSession).toHaveBeenCalledTimes(1);

    currentTime += 5_000;
    resourceError(document.createElement('img'));
    expect(validateSession).toHaveBeenCalledTimes(2);
    detach();
  });

  it('does not let an old epoch probe suppress or clear a newer epoch probe', async () => {
    let credentialEpoch = 7;
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const validateSession = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const detach = attachAuthenticatedResourceErrorBridge({
      eventTarget: window,
      getCurrentSession: () => ({ userId: 'same-user', credentialEpoch }),
      getAuthenticatedClient: () => ({ validateSession }),
      throttleMs: 10_000,
      now: () => 500
    });

    resourceError(document.createElement('img'));
    credentialEpoch = 8;
    resourceError(document.createElement('img'));
    expect(validateSession).toHaveBeenCalledTimes(2);

    first.resolve({});
    await settle();
    resourceError(document.createElement('video'));
    expect(validateSession).toHaveBeenCalledTimes(2);

    second.resolve({});
    await settle();
    detach();
  });

  it('swallows non-auth validation failures without directly changing session ownership', async () => {
    const validateSession = vi.fn(async () => {
      throw { kind: 'server-unreachable', code: 0 };
    });
    const detach = attachAuthenticatedResourceErrorBridge({
      eventTarget: window,
      getCurrentSession: () => ({ userId: 'user-1', credentialEpoch: 1 }),
      getAuthenticatedClient: () => ({ validateSession }),
      throttleMs: 0
    });

    resourceError(document.createElement('img'));
    await settle();

    expect(validateSession).toHaveBeenCalledTimes(1);
    detach();
  });

  it('routes a genuine current /Users/Me 401 through transport to the auth coordinator', async () => {
    const rejected = vi.fn(async () => undefined);
    const coordinator = new AuthSessionCoordinator({ onCurrentSessionRejected: rejected });
    const lease = coordinator.beginPasswordAuthentication();
    expect(coordinator.commitAuthenticated(lease)).not.toBeNull();

    const client = new JellyfinApiClient({
      baseUrl: 'https://server.example.com',
      accessToken: 'disposable-test-token',
      deviceId: 'device-1',
      authenticatedRequestContextProvider: () => {
        const context = coordinator.captureAuthenticatedRequest();
        if (!context) return null;
        return {
          ticket: context.ticket,
          signal: context.signal,
          isCurrent: context.isCurrent,
          onUnauthorized: () => {
            void coordinator.handleRuntimeStatus(context, 401);
          }
        };
      }
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"Message":"Unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })));
    const detach = attachAuthenticatedResourceErrorBridge({
      eventTarget: window,
      getCurrentSession: () => {
        const snapshot = coordinator.getSnapshot();
        return snapshot.authenticated && snapshot.credentialEpoch
          ? { userId: 'user-1', credentialEpoch: snapshot.credentialEpoch }
          : null;
      },
      getAuthenticatedClient: () => client,
      throttleMs: 0
    });

    resourceError(document.createElement('img'));
    await vi.waitFor(() => {
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(coordinator.getSnapshot().state).toBe('UNAUTHENTICATED');
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe('https://server.example.com/Users/Me');
    detach();
  });
});
