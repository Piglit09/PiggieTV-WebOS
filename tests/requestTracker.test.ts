import { describe, expect, it } from 'vitest';
import { RequestTracker } from '../src/core/requestTracker';

describe('request tracker', () => {
  it('tracks a completed request and reports request duration', () => {
    const tracker = new RequestTracker();
    const requestId = tracker.start('/api/items', 'GET');
    tracker.complete(requestId, 200, 42);

    expect(tracker.getActiveCount()).toBe(0);
    expect(tracker.getAverageDuration()).toBe(42);
    expect(tracker.getRecentCompletions().length).toBe(1);
    expect(tracker.getRecentCompletions()[0].status).toBe(200);
  });

  it('tracks failed and cancelled requests separately', () => {
    const tracker = new RequestTracker();
    const failed = tracker.start('/api/1', 'GET');
    tracker.fail(failed, new Error('Network issue'));

    const cancelled = tracker.start('/api/2', 'GET');
    tracker.cancel(cancelled, 'User canceled');

    expect(tracker.getRecentCompletions().length).toBe(0);
    expect(tracker.getRecentErrors(10).length).toBe(1);
    expect(tracker.getCancelledCount()).toBe(1);
  });

  it('retains successful, failed, cancelled, and active requests in recent history', () => {
    const tracker = new RequestTracker();
    const completed = tracker.start('/api/completed', 'GET');
    const failed = tracker.start('/api/failed', 'GET');
    const cancelled = tracker.start('/api/cancelled', 'GET');
    const active = tracker.start('/api/active', 'GET');

    tracker.complete(completed, 200, 25);
    tracker.fail(failed, new Error('Network issue'));
    tracker.cancel(cancelled, 'Route hidden');

    const recent = tracker.getRecentRequests(10);
    expect(recent.map(entry => entry.id)).toEqual([completed, failed, cancelled, active]);
    expect(recent.find(entry => entry.id === completed)).toMatchObject({ status: 200, durationMs: 25 });
    expect(recent.find(entry => entry.id === failed)).toMatchObject({ error: 'Network issue' });
    expect(recent.find(entry => entry.id === cancelled)).toMatchObject({
      cancelled: true,
      error: 'Route hidden'
    });
    expect(recent.find(entry => entry.id === active)).toMatchObject({ url: '/api/active' });
  });

  it('sanitizes resource IDs, dynamic routes, and all query values before retention', () => {
    const tracker = new RequestTracker();
    const userId = '0123456789abcdef0123456789abcdef';
    const itemId = 'fedcba9876543210fedcba9876543210';
    const apiKey = 'private-api-key-value';
    const searchTerm = 'private search title';
    const section = 'private-row-id';

    tracker.start(
      `/Users/${userId}/Items?api_key=${apiKey}&UserId=${userId}&SearchTerm=${searchTerm}&Limit=20`,
      'GET',
      'home',
      `details:${itemId}?section=${section}`
    );

    const [entry] = tracker.getActive();
    expect(entry?.url).toBe(
      '/Users/...cdef/Items?api_key=[redacted]&UserId=[redacted]&SearchTerm=[redacted]&Limit=[redacted]'
    );
    expect(entry?.route).toBe('details:[redacted]?section=[redacted]');
    const retained = JSON.stringify(entry);
    expect(retained).not.toContain(userId);
    expect(retained).not.toContain(itemId);
    expect(retained).not.toContain(apiKey);
    expect(retained).not.toContain(searchTerm);
    expect(retained).not.toContain(section);
  });

  it('records timeout and duplicate completions safely', () => {
    const tracker = new RequestTracker();
    const requestId = tracker.start('/api/timeout', 'GET');
    tracker.fail(requestId, new Error('request timeout'), true);

    tracker.complete(requestId, 408, 1);

    expect(tracker.getTimeoutCount()).toBe(1);
    expect(tracker.getDuplicateCount()).toBe(1);
    expect(tracker.getActiveCount()).toBe(0);
  });

  it('tracks peak parallel concurrency', () => {
    const tracker = new RequestTracker();
    const one = tracker.start('/api/one', 'GET');
    const two = tracker.start('/api/two', 'GET');
    const three = tracker.start('/api/three', 'GET');

    expect(tracker.getPeakConcurrency()).toBe(3);
    tracker.complete(one, 200, 5);
    tracker.complete(two, 200, 5);
    tracker.complete(three, 200, 5);
    expect(tracker.getPeakConcurrency()).toBe(3);
    expect(tracker.getActiveCount()).toBe(0);
  });

  it('reports the true slowest duration rather than the latest completion', () => {
    const tracker = new RequestTracker();
    const slowest = tracker.start('/api/slowest', 'GET');
    const fastest = tracker.start('/api/fastest', 'GET');
    const latest = tracker.start('/api/latest', 'GET');

    tracker.complete(slowest, 200, 540);
    tracker.complete(fastest, 200, 7);
    tracker.complete(latest, 200, 80);

    expect(tracker.getRecentCompletions(1)[0]?.durationMs).toBe(80);
    expect(tracker.getSlowestDuration()).toBe(540);
  });

  it('enforces a bounded completion history', () => {
    const tracker = new RequestTracker();
    for (let index = 0; index < 170; index += 1) {
      const requestId = tracker.start(`/api/item/${index}`, 'GET');
      tracker.complete(requestId, 200, index);
    }

    expect(tracker.getRecentCompletions(200).length).toBeLessThanOrEqual(160);
    expect(tracker.getRecentCompletions().length).toBe(10);
    const first = tracker.getRecentCompletions(200)[0];
    expect(first.url).toBe('/api/item/10');
  });
});
