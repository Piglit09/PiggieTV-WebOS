import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute, toRouteString } from '../../navigation/router';
import { FocusableButton } from '../../components/FocusableButton';
import { PTV_APPLICATION_VERSION } from '../../config/app';
import type { PtvDiagnosticsSnapshot } from '../../types/ptv';

interface DiagnosticsPage {
  id: string;
  label: string;
  title: string;
  content: Record<string, unknown>;
}

const APPLICATION_VERSION = import.meta.env.VITE_PTV_VERSION ?? PTV_APPLICATION_VERSION;
const PACKAGE_ID = import.meta.env.VITE_PTV_PACKAGE_ID ?? 'com.piggietv.webosnative';
const BUILD_TIMESTAMP = import.meta.env.VITE_PTV_BUILD_TS ?? import.meta.env.VITE_BUILD_TIMESTAMP ?? 'not embedded';
const COMMIT_HASH = import.meta.env.VITE_PTV_COMMIT?.trim() || null;

function buildPages(snapshot: PtvDiagnosticsSnapshot, recentLogs: unknown[]): DiagnosticsPage[] {
  return [
    {
      id: 'app',
      label: 'App',
      title: 'Application',
      content: {
        appVersion: snapshot.appVersion,
        packageId: snapshot.packageId,
        buildTimestamp: snapshot.buildTimestamp,
        commitHash: snapshot.commitHash,
        mode: snapshot.mode,
        webosVersion: snapshot.webosVersion,
        tvModel: snapshot.tvModel,
        viewport: snapshot.viewport,
        dpr: snapshot.dpr,
        visibilityState: snapshot.visibilityState,
        currentRoute: snapshot.currentRoute,
        previousRoute: snapshot.previousRoute,
        capabilities: snapshot.capabilities,
        memoryEstimate: snapshot.memoryEstimate
      }
    },
    {
      id: 'home',
      label: 'Home',
      title: 'Home performance',
      content: {
        latestAttempt: snapshot.homePerformance?.latestAttempt ?? null,
        recentAttempts: snapshot.homePerformance?.recentAttempts ?? []
      }
    },
    {
      id: 'network',
      label: 'Network',
      title: 'Network requests',
      content: {
        activeRequests: snapshot.activeRequests,
        peakConcurrentRequests: snapshot.peakConcurrentRequests,
        averageRequestDuration: snapshot.averageRequestDuration,
        failedRequestCount: snapshot.failedRequestCount,
        cancelledRequestCount: snapshot.cancelledRequestCount,
        timeoutRequestCount: snapshot.timeoutRequestCount,
        duplicateRequestCount: snapshot.duplicateRequestCount,
        slowestRequestMs: snapshot.slowestRequestMs,
        recentFailures: snapshot.recentFailures,
        recentCompletions: snapshot.recentCompletions
      }
    },
    {
      id: 'playback',
      label: 'Playback',
      title: 'Playback',
      content: {
        playbackState: snapshot.playbackState,
        playbackDecision: snapshot.playbackDecision,
        mediaCodecs: snapshot.mediaCodecs,
        currentPositionTicks: snapshot.currentPositionTicks,
        lastPlaybackError: snapshot.lastPlaybackError,
        playbackDetails: snapshot.playbackDetails
      }
    },
    {
      id: 'session',
      label: 'Session',
      title: 'Session and authentication',
      content: {
        serverVersion: snapshot.serverVersion,
        serverUrl: snapshot.serverUrl,
        userId: snapshot.userId,
        currentSession: snapshot.currentSession,
        authentication: snapshot.authentication,
        sessionRestore: snapshot.sessionRestore,
        recentSessionRestoreEvents: snapshot.recentSessionRestoreEvents
      }
    },
    {
      id: 'input',
      label: 'Input / Focus',
      title: 'Input, focus, and navigation',
      content: {
        currentFocusId: snapshot.currentFocusId,
        previousFocusId: snapshot.previousFocusId,
        lastInputEvent: snapshot.lastInputEvent,
        recentInputEvents: snapshot.recentInputEvents,
        lastNavigationEvent: snapshot.lastNavigationEvent,
        recentNavigationEvents: snapshot.recentNavigationEvents,
        lastRouteFocusRestore: snapshot.lastRouteFocusRestore,
        recentFocusTransitions: snapshot.recentFocusTransitions
      }
    },
    {
      id: 'lifecycle',
      label: 'Lifecycle',
      title: 'Lifecycle and errors',
      content: {
        lastLifecycleEvent: snapshot.lastLifecycleEvent,
        recentLifecycleEvents: snapshot.recentLifecycleEvents,
        lastUiError: snapshot.lastUiError,
        lastPlaybackError: snapshot.lastPlaybackError,
        recentLogs: recentLogs.slice(-20)
      }
    }
  ];
}

function humanLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, first => first.toUpperCase());
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="ptv-diagnostic-empty">Unavailable</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span>{Number.isFinite(value) ? value.toLocaleString() : 'Unavailable'}</span>;
  return <span>{String(value)}</span>;
}

function DiagnosticValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined || typeof value !== 'object') return <PrimitiveValue value={value} />;
  if (depth >= 4) return <span className="ptv-diagnostic-empty">Nested data available in Raw JSON</span>;

  if (Array.isArray(value)) {
    if (!value.length) return <span className="ptv-diagnostic-empty">None</span>;
    const visible = value.slice(-6);
    return (
      <div className="ptv-diagnostic-list">
        {value.length > visible.length ? <span className="ptv-diagnostic-empty">Showing latest {visible.length} of {value.length}</span> : null}
        {visible.map((entry, index) => (
          <div className="ptv-diagnostic-list__item" key={index}>
            <DiagnosticValue value={entry} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <dl className={`ptv-diagnostic-kv ptv-diagnostic-kv--depth-${depth}`}>
      {Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
        <div key={key}>
          <dt>{humanLabel(key)}</dt>
          <dd><DiagnosticValue value={entry} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
}

function legacyCopy(text: string) {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function DiagnosticsScreen() {
  const { state, services, dispatch } = useApp();

  const createSnapshot = useCallback(() => {
    const previousRoute = state.routeHistory[state.routeHistory.length - 1];
    const lastFocusTransition = services.focusManager.lastTransition;
    const stored = services.storage.getState();
    const persistedSession = stored.session;
    return services.diagnostics.snapshot({
      appVersion: APPLICATION_VERSION,
      packageId: PACKAGE_ID,
      buildTimestamp: BUILD_TIMESTAMP,
      commitHash: COMMIT_HASH,
      route: toRouteString(state.route),
      previousRoute: previousRoute ? toRouteString(previousRoute) : null,
      focusId: services.focusManager.focusId,
      previousFocusId: lastFocusTransition?.previousFocusId ?? services.focusManager.previousFocusId,
      userAgent: typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent,
      visibilityState: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
      serverUrl: state.serverUrl ?? '',
      serverVersion: state.serverSession?.serverVersion,
      userId: state.userSession?.userId,
      currentSession: {
        envelopeSchemaVersion: stored.schemaVersion,
        sessionSchemaVersion: persistedSession?.schemaVersion ?? null,
        sessionPresent: Boolean(persistedSession),
        inMemorySessionPresent: Boolean(state.userSession),
        tokenPresent: Boolean(persistedSession?.accessToken),
        serverUrl: persistedSession?.serverUrl ?? state.serverUrl,
        userId: persistedSession?.userId ?? state.userSession?.userId
      },
      capabilities: [
        ...state.capabilities.map(capability => capability.id),
        ...state.ptvCapabilities.map(capability => capability.id)
      ],
      mode: import.meta.env.MODE === 'production' ? 'production' : 'development'
    });
  }, [services, state.capabilities, state.ptvCapabilities, state.route, state.routeHistory, state.serverSession?.serverVersion, state.serverUrl, state.userSession]);

  const [snapshot, setSnapshot] = useState<PtvDiagnosticsSnapshot>(createSnapshot);
  const [pageIndex, setPageIndex] = useState(0);
  const [rawVisible, setRawVisible] = useState(false);
  const [copyStatus, setCopyStatus] = useState('Redacted diagnostics are ready.');
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSnapshot(createSnapshot());
    const timer = window.setInterval(() => setSnapshot(createSnapshot()), 1_000);
    return () => window.clearInterval(timer);
  }, [createSnapshot]);

  const pages = buildPages(snapshot, services.diagnostics.getRecentLogs());
  const page = pages[pageIndex] ?? pages[0];

  const selectPage = (index: number) => {
    setPageIndex(index);
    setRawVisible(false);
    if (outputRef.current) outputRef.current.scrollTop = 0;
  };

  const scrollPage = (direction: -1 | 1) => {
    const output = outputRef.current;
    if (!output) return;
    const maximum = Math.max(0, output.scrollHeight - output.clientHeight);
    const distance = Math.max(160, output.clientHeight - 80);
    output.scrollTop = Math.max(0, Math.min(maximum, output.scrollTop + direction * distance));
  };

  const copyDiagnostics = async () => {
    const text = services.diagnostics.toDiagnosticText(snapshot);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        setCopyStatus('Copied redacted diagnostics.');
        return;
      }
    } catch {
      // Older webOS Clipboard implementations may reject at runtime.
    }
    if (legacyCopy(text)) {
      setCopyStatus('Copied redacted diagnostics in TV compatibility mode.');
      return;
    }
    console.info(`[PiggieTV diagnostics export]\n${text}`);
    setCopyStatus('Clipboard unavailable. Redacted diagnostics were sent to the developer console.');
  };

  const clearErrors = () => {
    services.diagnostics.resetErrors();
    setSnapshot(createSnapshot());
    setCopyStatus('Current UI and playback errors were cleared.');
  };

  const goBack = () => {
    if (state.routeHistory.length > 0) dispatch({ type: 'go_back' });
    else dispatch({ type: 'reset_route', route: buildRoute('server') });
  };

  return (
    <LayoutShell title="Diagnostics" onBack={goBack} currentSection="settings">
      <section className="ptv-diagnostics">
        <div className="ptv-diagnostics__heading">
          <div><span className="ptv-eyebrow">Redacted support evidence</span><h2>Diagnostics</h2></div>
          <span>{page?.title ?? 'Application'}</span>
        </div>

        <nav className="ptv-diagnostics__tabs" aria-label="Diagnostic categories">
          {pages.map((candidate, index) => (
            <FocusableButton
              key={candidate.id}
              focusId={`diagnostics-tab-${candidate.id}`}
              preferredRow="diagnostics-tabs"
              className={pageIndex === index ? 'is-selected' : ''}
              aria-current={pageIndex === index ? 'page' : undefined}
              onClick={() => selectPage(index)}
            >
              {candidate.label}
            </FocusableButton>
          ))}
        </nav>

        <div ref={outputRef} className="ptv-diagnostics__output">
          {rawVisible ? (
            <pre>{services.diagnostics.toDiagnosticText(page?.content ?? {})}</pre>
          ) : (
            <DiagnosticValue value={page?.content ?? {}} />
          )}
        </div>

        <div className="ptv-diagnostics__actions">
          <FocusableButton focusId="diagnostics-page-up" preferredRow="diagnostics-actions" onClick={() => scrollPage(-1)}>Page up</FocusableButton>
          <FocusableButton focusId="diagnostics-page-down" preferredRow="diagnostics-actions" onClick={() => scrollPage(1)}>Page down</FocusableButton>
          <FocusableButton focusId="diagnostics-raw" preferredRow="diagnostics-actions" onClick={() => setRawVisible(value => !value)}>
            {rawVisible ? 'Human view' : 'Raw JSON'}
          </FocusableButton>
          <FocusableButton focusId="diagnostics-copy" preferredRow="diagnostics-actions" onClick={() => { void copyDiagnostics(); }}>
            Copy Redacted Diagnostics
          </FocusableButton>
          <FocusableButton focusId="diagnostics-clear" preferredRow="diagnostics-actions" onClick={clearErrors}>Clear current errors</FocusableButton>
        </div>
        <p className="ptv-diagnostics__copy-status" role="status" aria-live="polite">{copyStatus}</p>
      </section>
    </LayoutShell>
  );
}
