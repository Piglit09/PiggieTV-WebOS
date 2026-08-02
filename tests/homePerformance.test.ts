import { describe, expect, it } from 'vitest';
import {
  HOME_PERFORMANCE_SHELVES,
  HomePerformanceStore
} from '../src/core/homePerformance';

describe('Home performance store', () => {
  it('starts a privacy-safe attempt with all tracked shelves', () => {
    const store = new HomePerformanceStore();
    const sessionKey = 'https://server.example.com\u0000private-user';

    expect(store.beginAttempt()).toBeNull();
    store.synchronizeSession(sessionKey);
    const attemptId = store.beginAttempt();
    const snapshot = store.snapshot();

    expect(attemptId).toMatch(/^home_[a-z0-9]+$/);
    expect(Object.keys(snapshot.latestAttempt?.rows ?? {})).toEqual(HOME_PERFORMANCE_SHELVES);
    expect(snapshot.latestAttempt?.rows.continue).toEqual({
      shelf: 'continue',
      cache: 'miss',
      durationMs: null,
      outcome: 'pending',
      renderCount: 0
    });
    expect(JSON.stringify(store)).not.toContain(sessionKey);
    expect(JSON.stringify(snapshot)).not.toContain(sessionKey);
  });

  it('sanitizes measurements and retains monotonic counters', () => {
    const store = new HomePerformanceStore();
    store.synchronizeSession('session-a');
    const attemptId = store.beginAttempt() as string;

    expect(store.upsert({
      attemptId,
      usableMs: -2.5,
      firstPopulatedMs: Number.NaN,
      maxActiveRequests: 3.9,
      imageFailures: -8,
      rows: {
        movies: {
          cache: 'hit',
          durationMs: 14.75,
          outcome: 'success',
          renderCount: 2.9
        },
        shows: {
          durationMs: Number.POSITIVE_INFINITY,
          renderCount: Number.NaN
        }
      }
    })).toBe(true);

    expect(store.upsert({
      attemptId,
      usableMs: 120,
      firstPopulatedMs: 45.5,
      maxActiveRequests: 1,
      imageFailures: 4.8,
      rows: {
        movies: { renderCount: 1 },
        shows: { durationMs: -9 }
      }
    })).toBe(true);

    const latest = store.getLatest();
    expect(latest).toMatchObject({
      usableMs: 0,
      firstPopulatedMs: 45.5,
      maxActiveRequests: 3,
      imageFailures: 4
    });
    expect(latest?.rows.movies).toMatchObject({
      cache: 'hit',
      durationMs: 14.75,
      outcome: 'success',
      renderCount: 2
    });
    expect(latest?.rows.shows).toMatchObject({ durationMs: 0, renderCount: 0 });
  });

  it('returns deeply immutable snapshots and ignores terminal-state regressions', () => {
    const store = new HomePerformanceStore();
    store.synchronizeSession('session-a');
    const attemptId = store.beginAttempt() as string;
    store.upsert({
      attemptId,
      status: 'complete',
      rows: { continue: { outcome: 'success', renderCount: 1 } }
    });
    store.upsert({
      attemptId,
      status: 'active',
      rows: { continue: { outcome: 'pending', renderCount: 0 } }
    });

    const recent = store.getRecent();
    expect(Object.isFrozen(recent)).toBe(true);
    expect(Object.isFrozen(recent[0])).toBe(true);
    expect(Object.isFrozen(recent[0]?.rows)).toBe(true);
    expect(Object.isFrozen(recent[0]?.rows.continue)).toBe(true);
    expect(recent[0]).toMatchObject({
      status: 'complete',
      rows: { continue: { outcome: 'success', renderCount: 1 } }
    });
  });

  it('retains only the latest four attempts and rejects evicted updates', () => {
    const store = new HomePerformanceStore();
    store.synchronizeSession('session-a');
    const attemptIds = Array.from({ length: 6 }, () => store.beginAttempt() as string);

    expect(store.getRecent().map(attempt => attempt.attemptId)).toEqual(attemptIds.slice(-4));
    expect(store.getLatest()?.attemptId).toBe(attemptIds[5]);
    expect(store.upsert({ attemptId: attemptIds[0] as string, status: 'complete' })).toBe(false);
  });

  it('resets at session boundaries and rejects stale attempt updates', () => {
    const store = new HomePerformanceStore();
    const secretSessionKey = 'private-session-key';
    store.synchronizeSession(secretSessionKey);
    const staleAttemptId = store.beginAttempt() as string;

    store.synchronizeSession(secretSessionKey);
    expect(store.getRecent()).toHaveLength(1);

    store.synchronizeSession('next-private-session-key');
    expect(store.getRecent()).toHaveLength(0);
    expect(store.upsert({ attemptId: staleAttemptId, status: 'complete' })).toBe(false);
    const currentAttemptId = store.beginAttempt() as string;
    expect(currentAttemptId).not.toBe(staleAttemptId);

    store.synchronizeSession(null);
    expect(store.getLatest()).toBeNull();
    expect(store.beginAttempt()).toBeNull();
    expect(JSON.stringify(store)).not.toContain('private-session-key');
  });

  it('clear removes history and the active session boundary', () => {
    const store = new HomePerformanceStore();
    store.synchronizeSession('session-a');
    const attemptId = store.beginAttempt() as string;

    store.clear();

    expect(store.getRecent()).toEqual([]);
    expect(store.beginAttempt()).toBeNull();
    expect(store.upsert({ attemptId, status: 'complete' })).toBe(false);
  });
});
