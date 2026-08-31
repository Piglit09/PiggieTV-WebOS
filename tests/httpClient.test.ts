import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from '../src/api/http/http';
import { RequestTracker } from '../src/core/requestTracker';

const authorization = {
  accessToken: 'sensitive-access-token',
  clientName: 'PiggieTV',
  deviceName: 'LG webOS TV',
  deviceId: 'stable-device-id',
  applicationVersion: '0.1.0'
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared Jellyfin HTTP transport', () => {
  it('uses the stable device identity while redacting query tokens from tracking', async () => {
    const tracker = new RequestTracker();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toContain('DeviceId="stable-device-id"');
      expect(headers.Authorization).toContain('Token="sensitive-access-token"');
      expect(headers['X-MediaBrowser-Token']).toBe('sensitive-access-token');
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestJson<{ ok: boolean }>('https://server.example.com/Items', {
      query: { api_key: 'sensitive-access-token' },
      retries: 0,
      requestTracker: tracker
    }, authorization);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tracked = JSON.stringify(tracker.getRecentRequests());
    expect(tracked).not.toContain('sensitive-access-token');
    expect(tracked).toContain('redacted');
  });

  it('detaches the exact listener objects registered for request cancellation', async () => {
    const caller = new AbortController();
    const epoch = new AbortController();
    const added: Array<{ signal: AbortSignal; listener: EventListenerOrEventListenerObject }> = [];
    const removed: Array<{ signal: AbortSignal; listener: EventListenerOrEventListenerObject }> = [];
    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function(
      this: AbortSignal,
      type,
      listener,
      options
    ) {
      if (type === 'abort') added.push({ signal: this, listener });
      return EventTarget.prototype.addEventListener.call(this, type, listener, options);
    });
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(function(
      this: AbortSignal,
      type,
      listener,
      options
    ) {
      if (type === 'abort') removed.push({ signal: this, listener });
      return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    try {
      await requestJson('https://server.example.com/Items', {
        retries: 0,
        signal: caller.signal,
        authenticatedRequest: {
          ticket: { epoch: 11 },
          signal: epoch.signal,
          isCurrent: () => true,
          onUnauthorized: vi.fn()
        }
      }, authorization);

      expect(added).toHaveLength(2);
      expect(removed).toHaveLength(2);
      for (const binding of added) {
        expect(typeof binding.listener).toBe('function');
        expect(removed).toContainEqual(binding);
      }
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('classifies malformed successful bodies explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    await expect(requestJson('https://server.example.com/System/Info/Public', {
      retries: 0
    }, authorization)).rejects.toMatchObject({ kind: 'malformed-json' });
  });

  it('classifies HTTP 5xx responses as server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"Message":"Unavailable"}', {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })));

    await expect(requestJson('https://server.example.com/Items', {
      retries: 0
    }, authorization)).rejects.toMatchObject({ kind: 'server-error', code: 503 });
  });

  it('never propagates unlabeled server-echoed auth secrets into errors or diagnostics', async () => {
    const tracker = new RequestTracker();
    const password = 'exact-unlabeled-password-value';
    const quickConnectSecret = 'exact-unlabeled-quick-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Message: password }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ErrorMessage: quickConnectSecret }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }));
    vi.stubGlobal('fetch', fetchMock);

    const passwordFailure = await requestJson('https://server.example.com/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: 'tester', Pw: password },
      retries: 0,
      requestTracker: tracker,
      requestCategory: 'authentication'
    }, authorization).catch(error => error as { message?: string });
    const quickConnectFailure = await requestJson('https://server.example.com/Users/AuthenticateWithQuickConnect', {
      method: 'POST',
      body: { Secret: quickConnectSecret },
      retries: 0,
      requestTracker: tracker,
      requestCategory: 'authentication'
    }, authorization).catch(error => error as { message?: string });

    const evidence = JSON.stringify({
      passwordFailure,
      quickConnectFailure,
      requests: tracker.getRecentRequests()
    });
    expect(passwordFailure.message).toBe('Authentication request was rejected');
    expect(quickConnectFailure.message).toBe('Authentication request failed (500)');
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain(quickConnectSecret);
  });

  it('never propagates a bare current token echoed by an authenticated media endpoint', async () => {
    const tracker = new RequestTracker();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      Message: authorization.accessToken
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    })));

    const failure = await requestJson('https://server.example.com/Items', {
      retries: 0,
      requestTracker: tracker,
      requestCategory: 'jellyfin'
    }, authorization).catch(error => error as { message?: string });

    const evidence = JSON.stringify({ failure, requests: tracker.getRecentRequests() });
    expect(failure.message).toBe('Authenticated request failed (500)');
    expect(evidence).not.toContain(authorization.accessToken);
  });

  it('publishes one current authenticated ticket for a raw 401 and never retries it', async () => {
    const epoch = new AbortController();
    const ticket = { epoch: 7 };
    const onUnauthorized = vi.fn(() => epoch.abort());
    const fetchMock = vi.fn(async () => new Response('{"Message":"Unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('https://server.example.com/Users/Me', {
      retries: 3,
      authenticatedRequest: {
        ticket,
        signal: epoch.signal,
        isCurrent: () => true,
        onUnauthorized
      }
    }, authorization)).rejects.toMatchObject({ kind: 'authentication-failed', code: 401 });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(ticket);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not publish authenticated rejection for 403, network failure, or cancellation', async () => {
    const onUnauthorized = vi.fn();
    const context = () => ({
      ticket: { epoch: 8 },
      signal: new AbortController().signal,
      isCurrent: () => true,
      onUnauthorized
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"Message":"Forbidden"}', {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('https://server.example.com/Items', {
      retries: 0,
      authenticatedRequest: context()
    }, authorization)).rejects.toMatchObject({ code: 403 });
    await expect(requestJson('https://server.example.com/Items', {
      retries: 0,
      authenticatedRequest: context()
    }, authorization)).rejects.toMatchObject({ kind: 'server-unreachable' });

    const caller = new AbortController();
    caller.abort('route-hidden');
    await expect(requestJson('https://server.example.com/Items', {
      retries: 0,
      signal: caller.signal,
      authenticatedRequest: context()
    }, authorization)).rejects.toMatchObject({ kind: 'cancelled-request' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('treats a raw 401 from a retired credential epoch as cancellation without publishing it', async () => {
    let isCurrent = true;
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(async () => {
      isCurrent = false;
      return new Response('{"Message":"Unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('https://server.example.com/Users/Me', {
      retries: 3,
      authenticatedRequest: {
        ticket: { epoch: 7 },
        signal: new AbortController().signal,
        isCurrent: () => isCurrent,
        onUnauthorized
      }
    }, authorization)).rejects.toMatchObject({ kind: 'cancelled-request' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('cancels a pending retry when the captured credential epoch is retired', async () => {
    const epoch = new AbortController();
    const onUnauthorized = vi.fn();
    let observeFailure!: () => void;
    const failureObserved = new Promise<void>(resolve => { observeFailure = resolve; });
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = requestJson('https://server.example.com/Items', {
      retries: 2,
      retryDelayMs: 5_000,
      onRequestFailure: observeFailure,
      authenticatedRequest: {
        ticket: { epoch: 9 },
        signal: epoch.signal,
        isCurrent: () => !epoch.signal.aborted,
        onUnauthorized
      }
    }, authorization);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'cancelled-request' });

    await failureObserved;
    epoch.abort();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not start a fetch for an already cancelled route request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort('route-hidden');

    await expect(requestJson('https://server.example.com/Items', {
      retries: 0,
      signal: controller.signal
    }, authorization)).rejects.toMatchObject({ kind: 'cancelled-request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an empty 204 playback acknowledgement and records it as a successful response', async () => {
    const tracker = new RequestTracker();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 204,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson<Record<string, unknown>>('https://server.example.com/Sessions/Playing', {
      method: 'POST',
      body: { ItemId: 'item-1' },
      retries: 0,
      requestTracker: tracker,
      requestCategory: 'playback',
      requestRoute: 'POST Sessions/Playing'
    }, authorization)).resolves.toEqual({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tracker.getRecentRequests()).toEqual([
      expect.objectContaining({
        status: 204,
        category: 'playback',
        route: 'POST Sessions/Playing',
        parseResult: 'empty'
      })
    ]);
    expect(tracker.getTimeoutCount()).toBe(0);
  });

  it('does not amplify a bounded request when retries are disabled', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = requestJson('https://server.example.com/Sessions/Playing', {
      method: 'POST',
      body: { ItemId: 'item-1' },
      timeoutMs: 50,
      retries: 0
    }, authorization);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'request-timeout' });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies legacy Chromium TypeError aborts from its timeout as request timeouts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new TypeError('Failed to fetch'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = requestJson('https://server.example.com/System/Info/Public', {
      timeoutMs: 50,
      retries: 0
    }, authorization);
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'request-timeout',
      message: 'The server took too long to respond'
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies legacy Chromium TypeError aborts from a caller as cancellation', async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new TypeError('Failed to fetch'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = requestJson('https://server.example.com/System/Info/Public', {
      signal: caller.signal,
      retries: 2
    }, authorization);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'cancelled-request' });

    caller.abort('route-hidden');
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps caller cancellation authoritative when legacy fetch rejection is delayed past the timeout', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        window.setTimeout(() => reject(new TypeError('Failed to fetch')), 100);
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = requestJson('https://server.example.com/System/Info/Public', {
      signal: caller.signal,
      timeoutMs: 50,
      retries: 0
    }, authorization);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'cancelled-request' });

    caller.abort('route-hidden');
    await vi.advanceTimersByTimeAsync(150);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
