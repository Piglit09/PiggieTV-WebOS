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
