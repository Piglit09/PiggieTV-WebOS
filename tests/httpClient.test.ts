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
});
