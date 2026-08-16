import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from '../src/core/diagnostics';
import {
  RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY,
  RuntimeDiagnosticsMonitor
} from '../src/core/runtimeDiagnostics';

class MemoryStorage {
  public readonly values = new Map<string, string>();
  public writes = 0;

  public getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string) {
    this.writes += 1;
    this.values.set(key, value);
  }
}

function timerHarness() {
  let callback: (() => void) | null = null;
  return {
    clearInterval: vi.fn(),
    fire: () => callback?.(),
    setInterval: vi.fn((next: () => void) => {
      callback = next;
      return 17;
    })
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, '__ptvDiagnosticHealth');
});

describe('runtime diagnostics', () => {
  it('does no storage, timer, or global work when disabled', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const timers = timerHarness();
    const monitor = new RuntimeDiagnosticsMonitor({
      enabled: false,
      persistentStorage,
      sessionStorage,
      timerHost: timers
    });

    const stop = monitor.startHeartbeat(() => ({ currentRoute: 'shows' }));
    stop();
    expect(persistentStorage.writes).toBe(0);
    expect(sessionStorage.writes).toBe(0);
    expect(timers.setInterval).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toMatchObject({
      diagnosticMode: false,
      heartbeatActive: false,
      page: { pageInstanceId: null, pageLoadCount: null, webViewSessionId: null }
    });

    const diagnostics = new DiagnosticsService({ runtimeDiagnosticsEnabled: false });
    const cleanup = diagnostics.startRuntimeDiagnostics(() => ({ currentRoute: 'shows' }));
    expect((window as unknown as Record<string, unknown>).__ptvDiagnosticHealth).toBeUndefined();
    cleanup();
  });

  it('changes the page instance, preserves the WebView session, and increments the page-load count', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const first = new RuntimeDiagnosticsMonitor({
      enabled: true,
      now: () => 1_000,
      persistentStorage,
      random: () => 0.1,
      sessionStorage,
      timeOrigin: () => 900,
      timerHost: null
    });
    const firstSnapshot = first.snapshot();
    expect(first.snapshot().page.pageInstanceId).toBe(firstSnapshot.page.pageInstanceId);

    const second = new RuntimeDiagnosticsMonitor({
      enabled: true,
      now: () => 2_000,
      persistentStorage,
      random: () => 0.2,
      sessionStorage,
      timeOrigin: () => 1_900,
      timerHost: null
    });

    expect(firstSnapshot.page.pageInstanceId).not.toBe(second.page.pageInstanceId);
    expect(firstSnapshot.page.webViewSessionId).toBe(second.page.webViewSessionId);
    expect(firstSnapshot.page.pageLoadCount).toBe(1);
    expect(second.page.pageLoadCount).toBe(2);
    expect(second.page.timeOrigin).toBe(1_900);
  });

  it('uses one five-second heartbeat timer and cleans it up exactly once', () => {
    let now = 10_000;
    const persistentStorage = new MemoryStorage();
    const timers = timerHarness();
    const monitor = new RuntimeDiagnosticsMonitor({
      enabled: true,
      now: () => now,
      persistentStorage,
      random: () => 0.25,
      sessionStorage: new MemoryStorage(),
      timeOrigin: () => 9_500,
      timerHost: timers
    });
    const stop = monitor.startHeartbeat(() => ({ currentRoute: 'shows' }));
    const duplicateStop = monitor.startHeartbeat(() => ({ currentRoute: 'details' }));

    expect(timers.setInterval).toHaveBeenCalledOnce();
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(JSON.parse(persistentStorage.getItem(RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY) ?? '{}')).toMatchObject({
      currentRoute: 'shows',
      timestamp: 10_000
    });

    now = 15_000;
    timers.fire();
    expect(monitor.snapshot()).toMatchObject({
      heartbeatActive: true,
      heartbeatAgeMs: 0,
      lastHeartbeat: { currentRoute: 'shows', timestamp: 15_000 }
    });

    duplicateStop();
    expect(timers.clearInterval).not.toHaveBeenCalled();
    stop();
    stop();
    expect(timers.clearInterval).toHaveBeenCalledOnce();
    expect(monitor.snapshot().heartbeatActive).toBe(false);
  });

  it('exposes a frozen read-only health snapshot and bounded render-window events', () => {
    const persistentStorage = new MemoryStorage();
    const timers = timerHarness();
    const diagnostics = new DiagnosticsService({
      runtimeDiagnosticsEnabled: true,
      runtimeDiagnostics: {
        now: () => 20_000,
        persistentStorage,
        random: () => 0.3,
        sessionStorage: new MemoryStorage(),
        timeOrigin: () => 19_500,
        timerHost: timers
      }
    });
    const cleanup = diagnostics.startRuntimeDiagnostics(() => ({
      currentFocusId: 'browse-shows-private-item-1234567890',
      currentRoute: 'shows'
    }));
    const diagnosticWindow = window as unknown as Record<string, unknown>;
    const api = diagnosticWindow.__ptvDiagnosticHealth as {
      snapshot: () => ReturnType<DiagnosticsService['getRuntimeHealthSnapshot']>;
    };

    expect(Object.isFrozen(api)).toBe(true);
    for (let index = 0; index < 30; index += 1) {
      diagnostics.recordShowsLibraryEvent({
        type: 'render-window-change',
        metadataCount: 120 + index,
        renderWindowStart: index * 8,
        renderWindowEnd: index * 8 + 96,
        renderedCardCount: 96,
        currentColumns: 8,
        focusedItemId: 'private-item-1234567890'
      });
    }

    const snapshot = api.snapshot();
    expect(snapshot.diagnosticMode).toBe(true);
    expect(snapshot.showsLibrary.current).toMatchObject({
      metadataCount: 149,
      currentColumns: 8,
      renderedCardCount: 96,
      focusedItemId: '...34567890'
    });
    expect(snapshot.showsLibrary.recentEvents).toHaveLength(12);
    expect(snapshot.lastHeartbeat).toMatchObject({
      currentFocusId: 'browse-shows-[redacted]',
      currentRoute: 'shows'
    });

    cleanup();
    expect(diagnosticWindow.__ptvDiagnosticHealth).toBeUndefined();
    expect(timers.clearInterval).toHaveBeenCalledOnce();
  });

  it('deduplicates identical render-window diagnostic events', () => {
    const diagnostics = new DiagnosticsService({
      runtimeDiagnosticsEnabled: true,
      runtimeDiagnostics: {
        persistentStorage: new MemoryStorage(),
        random: () => 0.4,
        sessionStorage: new MemoryStorage(),
        timerHost: null
      }
    });
    const event = {
      type: 'render-window-change',
      metadataCount: 120,
      renderWindowStart: 24,
      renderWindowEnd: 120,
      renderedCardCount: 96,
      currentColumns: 8
    };

    diagnostics.recordShowsLibraryEvent(event);
    diagnostics.recordShowsLibraryEvent(event);
    expect(diagnostics.getRuntimeHealthSnapshot().showsLibrary.recentEvents).toHaveLength(1);
  });

  it('publishes an immediate sanitized heartbeat for focus transitions and reconciliation events', () => {
    let now = 30_000;
    let currentFocusId = 'browse-filter-recent';
    const privateItemId = '0123456789abcdef0123456789abcdef';
    const privateFocusId = `browse-shows-${privateItemId}`;
    const privateServerUrl = 'https://user:password@private.example.com:8096/path?api_key=never-export-this';
    const persistentStorage = new MemoryStorage();
    const timers = timerHarness();
    const diagnostics = new DiagnosticsService({
      runtimeDiagnosticsEnabled: true,
      runtimeDiagnostics: {
        now: () => now,
        persistentStorage,
        random: () => 0.5,
        sessionStorage: new MemoryStorage(),
        timeOrigin: () => 29_500,
        timerHost: timers
      }
    });
    const cleanup = diagnostics.startRuntimeDiagnostics(() => ({
      currentFocusId,
      currentRoute: 'shows'
    }));
    const writesAfterStartup = persistentStorage.writes;

    now = 30_100;
    currentFocusId = privateFocusId;
    diagnostics.recordFocusTransition({
      timestamp: now,
      routeId: 'shows',
      previousFocusId: 'browse-filter-recent',
      nextFocusId: privateFocusId,
      inputKey: 'ArrowDown',
      reason: 'directional',
      direction: 'down',
      fallbackUsed: false
    });

    const transitionHeartbeat = JSON.parse(
      persistentStorage.getItem(RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY) ?? '{}'
    ) as Record<string, unknown>;
    expect(persistentStorage.writes).toBeGreaterThan(writesAfterStartup);
    expect(transitionHeartbeat).toMatchObject({
      timestamp: 30_100,
      currentFocusId: 'browse-shows-[redacted]',
      lastFocusTransition: {
        nextFocusId: 'browse-shows-[redacted]',
        inputKey: 'ArrowDown',
        reason: 'directional'
      }
    });

    const writesAfterTransition = persistentStorage.writes;
    now = 30_200;
    diagnostics.recordFocusReconciliationEvent({
      timestamp: now,
      type: 'pending-focus-restored',
      routeId: 'shows',
      focusId: `details-related-${privateItemId}`,
      requestedFocusId: `details-season-${privateItemId}`,
      registeredFocusId: `details-episode-${privateItemId}`,
      unregisteredFocusId: `recent-${privateServerUrl}`,
      logicalFocusId: `details-season-episode-${privateItemId}`,
      nativeFocusId: `details-track-${privateItemId}`,
      pendingFocusId: `playback-queue-7-${privateItemId}`,
      inputKey: 'ArrowDown',
      reason: 'directional',
      direction: 'down',
      targetMounted: true,
      interactionMode: 'remote',
      pendingToken: 7,
      fallbackReason: null,
      nativeFocusApplied: true,
      reconciliationViolation: false,
      renderWindowStart: 520
    });

    const reconciliationHeartbeat = JSON.parse(
      persistentStorage.getItem(RUNTIME_DIAGNOSTICS_HEARTBEAT_KEY) ?? '{}'
    ) as Record<string, unknown>;
    expect(persistentStorage.writes).toBeGreaterThan(writesAfterTransition);
    expect(reconciliationHeartbeat).toMatchObject({
      timestamp: 30_200,
      currentFocusId: 'browse-shows-[redacted]',
      focusReconciliation: {
        current: {
          type: 'pending-focus-restored',
          focusId: 'details-related-[redacted]',
          requestedFocusId: 'details-season-[redacted]',
          registeredFocusId: 'details-episode-[redacted]',
          unregisteredFocusId: 'recent-[redacted-server]',
          logicalFocusId: 'details-season-episode-[redacted]',
          nativeFocusId: 'details-track-[redacted]',
          pendingFocusId: 'playback-queue-7-[redacted]',
          pendingToken: 7
        }
      }
    });
    expect(JSON.stringify(reconciliationHeartbeat)).not.toContain(privateItemId);
    expect(JSON.stringify(reconciliationHeartbeat)).not.toContain('private.example.com');
    expect(JSON.stringify(reconciliationHeartbeat)).not.toContain('never-export-this');

    cleanup();
  });
});
