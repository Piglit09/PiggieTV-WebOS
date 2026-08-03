import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '../src/core/diagnostics';
import { redactSensitiveText } from '../src/core/redaction';
import { RequestTracker } from '../src/core/requestTracker';

const snapshotInput = {
  appVersion: '0.1.0',
  packageId: 'com.piggietv.webosnative',
  buildTimestamp: '2026-01-01T00:00:00Z',
  commitHash: 'abc1234',
  mode: 'development' as const,
  route: 'home',
  previousRoute: 'auth',
  focusId: null,
  previousFocusId: null,
  userAgent: 'Mozilla/5.0 (Web0S; LG TV)',
  visibilityState: 'visible',
  serverUrl: 'https://piggietv.com',
  capabilities: []
};

describe('diagnostics', () => {
  it('redacts server url and user id', () => {
    const diagnostics = new DiagnosticsService();
    const snapshot = diagnostics.snapshot({
      ...snapshotInput,
      serverUrl: 'https://user:pass@stream.piggietv.com',
      serverVersion: '10.9.0',
      userId: '0123456789abcdef',
      capabilities: ['quick-connect'],
      lastLifecycleEvent: 'booted'
    });
    expect(snapshot.serverUrl).not.toContain('user:pass');
    expect(snapshot.userId).toBe('...cdef');
    expect(snapshot.userId).not.toBe('0123456789abcdef');
    expect(snapshot.packageId).toBe('com.piggietv.webosnative');
    expect(snapshot.previousRoute).toBe('auth');
    expect(snapshot.userAgent).toContain('LG TV');
    expect(snapshot.visibilityState).toBe('visible');
  });

  it('tracks logs', () => {
    const diagnostics = new DiagnosticsService();
    diagnostics.logError('token invalid', { token: 'abc' });
    const [entry] = diagnostics.getRecentLogs();
    expect(diagnostics.getRecentLogs().length).toBe(1);
    expect(entry.message).toBe('token invalid');
    expect(entry.details).toContain('token');
    expect(entry.details).not.toContain('abc');
  });

  it('redacts URL, bearer, authorization, password, and playback error secrets end to end', () => {
    const secret = 'never-export-this';
    const userId = '0123456789abcdef0123456789abcdef';
    const diagnosticText = redactSensitiveText(
      `https://server/Users/${userId}/Items?api_key=${secret}&UserId=${userId} `
      + `Bearer ${secret} Authorization="Token=${secret}" password=${secret} `
      + `{"UserId":"${userId}"} UserId=${userId}`
    );
    expect(diagnosticText).not.toContain(secret);
    expect(diagnosticText).not.toContain(userId);
    expect(diagnosticText).toContain('Users/...cdef/Items');
    expect(diagnosticText).toContain('UserId=...cdef');
    expect(diagnosticText).toContain('"UserId":"...cdef"');

    const diagnostics = new DiagnosticsService();
    diagnostics.recordPlaybackError(`Playback failed at /stream?token=${secret}`);
    diagnostics.logError(`Authorization: Bearer ${secret}`);
    const snapshot = diagnostics.snapshot({
      ...snapshotInput,
      route: 'playback:item',
    });
    expect(diagnostics.toDiagnosticText(snapshot)).not.toContain(secret);
    expect(JSON.stringify(diagnostics.getRecentLogs())).not.toContain(secret);
  });

  it('reports only safe current-session state and schema/token booleans', () => {
    const diagnostics = new DiagnosticsService();
    const userId = '0123456789abcdef0123456789abcdef';
    const snapshot = diagnostics.snapshot({
      ...snapshotInput,
      currentSession: {
        envelopeSchemaVersion: 2,
        sessionSchemaVersion: 1,
        sessionPresent: true,
        inMemorySessionPresent: true,
        tokenPresent: true,
        serverUrl: 'https://user:password@private.example.com:8096/path?api_key=never-export-this',
        userId
      }
    });

    expect(snapshot.currentSession).toEqual({
      envelopeSchemaVersion: 2,
      sessionSchemaVersion: 1,
      sessionPresent: true,
      inMemorySessionPresent: true,
      tokenPresent: true,
      serverOrigin: 'https://***.example.com:8096 (redacted)',
      userIdSuffix: '...cdef'
    });
    const exported = diagnostics.toDiagnosticText(snapshot);
    expect(exported).not.toContain(userId);
    expect(exported).not.toContain('never-export-this');
    expect(exported).not.toContain('user:password');
  });

  it('records sanitized session restore, input, lifecycle, navigation, and route focus evidence', () => {
    const diagnostics = new DiagnosticsService();
    const secret = 'restore-token-value';

    diagnostics.recordSessionRestore({
      timestamp: 100,
      stage: 'users-me-validation',
      status: 'pending',
      serverUrl: `https://user:pass@private.example.com/Users/Me?token=${secret}`,
      userId: 'user-123456',
      token: secret,
      tokenPresent: true,
      storageSchemaVersion: 2,
      sessionSchemaVersion: 1
    });
    diagnostics.recordInputEvent({
      timestamp: 101,
      action: { kind: 'back', key: 'Back' },
      keyCode: 461,
      repeat: false,
      handled: true
    });
    diagnostics.recordLifecycleEvent('visibilitychange');
    diagnostics.recordNavigationEvent({
      timestamp: 102,
      type: 'route-change',
      input: 'Back',
      outcome: 'history-back',
      previousRoute: 'details:item',
      currentRoute: 'home'
    });
    diagnostics.recordFocusTransition({
      timestamp: 103,
      routeId: 'home',
      previousFocusId: 'details-back',
      nextFocusId: 'home-row-0',
      reason: 'route-fallback',
      fallbackUsed: true
    });

    const snapshot = diagnostics.snapshot(snapshotInput);
    const exported = diagnostics.toDiagnosticText(snapshot);

    expect(snapshot.sessionRestore).toMatchObject({
      stage: 'users-me-validation',
      userId: '...3456',
      tokenPresent: true,
      storageSchemaVersion: 2,
      sessionSchemaVersion: 1
    });
    expect(snapshot.lastInputEvent).toMatchObject({ keyCode: 461, repeat: false, handled: true });
    expect(snapshot.lastLifecycleEvent).toBe('visibilitychange');
    expect(snapshot.previousRoute).toBe('details:[redacted]');
    expect(snapshot.lastNavigationEvent).toMatchObject({ outcome: 'history-back', currentRoute: 'home' });
    expect(snapshot.lastRouteFocusRestore).toMatchObject({ reason: 'route-fallback', fallbackUsed: true });
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain('user:pass');
    expect(exported).not.toContain('user-123456');
  });

  it('sanitizes dynamic routes, query values, and focus IDs in raw snapshots', () => {
    const diagnostics = new DiagnosticsService();
    const itemId = '0123456789abcdef0123456789abcdef';
    const sectionId = 'private-home-row';

    diagnostics.recordNavigationEvent({
      type: 'route-change',
      previousRoute: `playback:${itemId}`,
      currentRoute: `details:${itemId}?section=${sectionId}`
    });
    diagnostics.recordFocusTransition({
      routeId: `details:${itemId}`,
      previousFocusId: `details-episode-${itemId}`,
      nextFocusId: `home-movies-${itemId}`,
      reason: 'route-restore'
    });

    const snapshot = diagnostics.snapshot({
      ...snapshotInput,
      route: `details:${itemId}?section=${sectionId}`,
      previousRoute: `playback:${itemId}`,
      focusId: `home-movies-${itemId}`,
      previousFocusId: `details-episode-${itemId}`
    });

    expect(snapshot).toMatchObject({
      currentRoute: 'details:[redacted]?section=[redacted]',
      previousRoute: 'playback:[redacted]',
      currentFocusId: 'home-movies-[redacted]',
      previousFocusId: 'details-episode-[redacted]'
    });
    expect(snapshot.lastNavigationEvent).toMatchObject({
      previousRoute: 'playback:[redacted]',
      currentRoute: 'details:[redacted]?section=[redacted]'
    });
    expect(snapshot.lastRouteFocusRestore).toMatchObject({
      routeId: 'details:[redacted]',
      previousFocusId: 'details-episode-[redacted]',
      nextFocusId: 'home-movies-[redacted]'
    });
    const rawSnapshot = JSON.stringify(snapshot);
    expect(rawSnapshot).not.toContain(itemId);
    expect(rawSnapshot).not.toContain(sectionId);
  });

  it('includes mixed recent request outcomes and the true slowest duration', () => {
    const diagnostics = new DiagnosticsService();
    const tracker = new RequestTracker();
    diagnostics.attachTracker(tracker);

    const slow = tracker.start('/api/slow', 'GET', 'home', 'home');
    const fast = tracker.start('/api/fast', 'GET', 'home', 'home');
    const failed = tracker.start('/api/failed', 'GET', 'home', 'home');
    const cancelled = tracker.start('/api/cancelled', 'GET', 'home', 'home');
    const active = tracker.start('/api/active', 'GET', 'home', 'home');
    tracker.complete(slow, 200, 730);
    tracker.complete(fast, 204, 12);
    tracker.fail(failed, new Error('Network unavailable'));
    tracker.cancel(cancelled, 'Route hidden');

    const snapshot = diagnostics.snapshot(snapshotInput);
    const recent = snapshot.recentCompletions ?? [];

    expect(recent.map(entry => entry.id)).toEqual([slow, fast, failed, cancelled, active]);
    expect(recent.find(entry => entry.id === failed)).toMatchObject({ error: 'Network unavailable' });
    expect(recent.find(entry => entry.id === cancelled)).toMatchObject({
      cancelled: true,
      error: 'Route hidden'
    });
    expect(snapshot).toMatchObject({
      activeRequests: 1,
      failedRequestCount: 1,
      cancelledRequestCount: 1,
      slowestRequestMs: 730
    });
  });

  it('exports Home performance metrics without the private session boundary', () => {
    const diagnostics = new DiagnosticsService();
    const privateUser = 'diagnostics-private-user';
    const privateToken = 'diagnostics-private-token';
    const sessionKey = `https://private.example.com\u0000${privateUser}\u0000${privateToken}`;
    diagnostics.synchronizeHomePerformanceSession(sessionKey);
    const attemptId = diagnostics.beginHomePerformanceAttempt();

    expect(attemptId).toMatch(/^home_[a-z0-9]+$/);
    diagnostics.recordHomePerformance({
      attemptId: attemptId as string,
      usableMs: 92.5,
      firstPopulatedMs: 44,
      maxActiveRequests: 3,
      imageFailures: 1,
      status: 'complete',
      rows: {
        continue: {
          cache: 'hit',
          durationMs: 8,
          outcome: 'success',
          renderCount: 2
        },
        movies: {
          cache: 'miss',
          durationMs: 71.25,
          outcome: 'success',
          renderCount: 1
        }
      }
    });

    const snapshot = diagnostics.snapshot(snapshotInput);
    expect(snapshot.homePerformance?.latestAttempt).toMatchObject({
      attemptId,
      usableMs: 92.5,
      firstPopulatedMs: 44,
      maxActiveRequests: 3,
      imageFailures: 1,
      status: 'complete',
      rows: {
        continue: { cache: 'hit', durationMs: 8, outcome: 'success', renderCount: 2 },
        movies: { cache: 'miss', durationMs: 71.25, outcome: 'success', renderCount: 1 }
      }
    });
    const rawSnapshot = JSON.stringify(snapshot);
    expect(rawSnapshot).not.toContain(sessionKey);
    expect(rawSnapshot).not.toContain(privateUser);
    expect(rawSnapshot).not.toContain(privateToken);
    expect(diagnostics.toDiagnosticText(snapshot)).not.toContain(privateToken);
  });

  it('bounds high-frequency input diagnostics while retaining the latest event', () => {
    const diagnostics = new DiagnosticsService();
    for (let sequence = 0; sequence < 45; sequence += 1) {
      diagnostics.recordInputEvent({ sequence, keyCode: 40, action: { kind: 'move', key: 'ArrowDown' } });
    }

    const snapshot = diagnostics.snapshot(snapshotInput);
    expect(snapshot.recentInputEvents).toHaveLength(16);
    expect(snapshot.recentInputEvents?.[0]).toMatchObject({ sequence: 29 });
    expect(snapshot.lastInputEvent).toMatchObject({ sequence: 44 });
  });

  it('promotes the latest playback snapshot into the summary fields', () => {
    const diagnostics = new DiagnosticsService();
    diagnostics.recordPlaybackSnapshot({
      state: 'playing',
      decision: 'direct-play',
      videoCodec: 'h264',
      audioCodec: 'aac',
      currentTime: 12.5
    });

    const snapshot = diagnostics.snapshot(snapshotInput);
    expect(snapshot).toMatchObject({
      playbackState: 'playing',
      playbackDecision: 'direct-play',
      mediaCodecs: 'h264/aac',
      currentPositionTicks: 125_000_000
    });
  });
});
