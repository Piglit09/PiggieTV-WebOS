import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute, toRouteString } from '../../navigation/router';
import { FocusableButton } from '../../components/FocusableButton';
import { PTV_APPLICATION_VERSION } from '../../config/app';
import type { PtvDiagnosticsSnapshot } from '../../types/ptv';

interface DiagnosticsPage {
  id: string;
  title: string;
  content: Record<string, unknown>;
}

const APPLICATION_VERSION = import.meta.env.VITE_PTV_VERSION ?? PTV_APPLICATION_VERSION;
const PACKAGE_ID = import.meta.env.VITE_PTV_PACKAGE_ID ?? 'com.piggietv.webosnative';
const BUILD_TIMESTAMP = import.meta.env.VITE_PTV_BUILD_TS ?? import.meta.env.VITE_BUILD_TIMESTAMP ?? 'not embedded';
const COMMIT_HASH = import.meta.env.VITE_PTV_COMMIT?.trim() || null;

function buildPages(snapshot: PtvDiagnosticsSnapshot): DiagnosticsPage[] {
  return [
    {
      id: 'application',
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
        userAgent: snapshot.userAgent,
        visibilityState: snapshot.visibilityState,
        currentRoute: snapshot.currentRoute,
        previousRoute: snapshot.previousRoute,
        currentFocusId: snapshot.currentFocusId,
        previousFocusId: snapshot.previousFocusId,
        pluginVersion: snapshot.pluginVersion,
        pluginApiVersion: snapshot.pluginApiVersion,
        capabilities: snapshot.capabilities,
        memoryEstimate: snapshot.memoryEstimate
      }
    },
    {
      id: 'session',
      title: 'Authentication and session restore',
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
      id: 'playback',
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
      id: 'input',
      title: 'Input, focus, and navigation',
      content: {
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
      title: 'Lifecycle and errors',
      content: {
        lastLifecycleEvent: snapshot.lastLifecycleEvent,
        recentLifecycleEvents: snapshot.recentLifecycleEvents,
        lastUiError: snapshot.lastUiError,
        lastPlaybackError: snapshot.lastPlaybackError
      }
    },
    {
      id: 'requests',
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
        requestDurations: snapshot.requestDurations,
        activeFailures: snapshot.activeFailures,
        recentFailures: snapshot.recentFailures,
        recentCompletions: snapshot.recentCompletions
      }
    }
  ];
}

function legacyCopy(text: string) {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  textarea.style.top = '0';
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
  }, [
    services,
    state.capabilities,
    state.ptvCapabilities,
    state.route,
    state.routeHistory,
    state.serverSession?.serverVersion,
    state.serverUrl,
    state.userSession
  ]);

  const [snapshot, setSnapshot] = useState<PtvDiagnosticsSnapshot>(createSnapshot);
  const [pageIndex, setPageIndex] = useState(0);
  const [copyStatus, setCopyStatus] = useState('Sanitized diagnostics are ready to copy.');
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setSnapshot(createSnapshot());
    const timer = window.setInterval(() => setSnapshot(createSnapshot()), 1_000);
    return () => window.clearInterval(timer);
  }, [createSnapshot]);

  const pages = useMemo(() => buildPages(snapshot), [snapshot]);
  const page = pages[pageIndex] ?? pages[0];

  const changePage = (delta: number) => {
    setPageIndex(current => (current + delta + pages.length) % pages.length);
    if (outputRef.current) outputRef.current.scrollTop = 0;
  };

  const scrollPage = (direction: -1 | 1) => {
    const output = outputRef.current;
    if (!output) return;
    const maximum = Math.max(0, output.scrollHeight - output.clientHeight);
    const distance = Math.max(120, output.clientHeight - 60);
    output.scrollTop = Math.max(0, Math.min(maximum, output.scrollTop + direction * distance));
  };

  const copyDiagnostics = async () => {
    const text = services.diagnostics.toDiagnosticText(snapshot);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        setCopyStatus('Copied sanitized diagnostics to the clipboard.');
        return;
      }
    } catch {
      // Older webOS browsers can expose Clipboard APIs that reject at runtime.
    }

    if (legacyCopy(text)) {
      setCopyStatus('Copied sanitized diagnostics using TV compatibility mode.');
      return;
    }

    console.info(`[PiggieTV diagnostics export]\n${text}`);
    setCopyStatus('Clipboard unavailable. Sanitized diagnostics were exported to the developer console.');
  };

  const goBack = () => {
    if (state.routeHistory.length > 0) {
      dispatch({ type: 'go_back' });
      return;
    }
    dispatch({ type: 'reset_route', route: buildRoute('server') });
  };

  return (
    <LayoutShell title="Diagnostics" onBack={goBack}>
      <section className="ptv-section ptv-diagnostics">
        <div className="ptv-diagnostics__heading">
          <h2>{page?.title ?? 'Diagnostics'}</h2>
          <span>Page {pageIndex + 1} of {pages.length}</span>
        </div>
        <pre ref={outputRef} className="ptv-diagnostics__output">
          {services.diagnostics.toDiagnosticText(page?.content ?? {})}
        </pre>
        <div className="ptv-row ptv-diagnostics__paging">
          <FocusableButton focusId="diagnostics-previous" onClick={() => changePage(-1)}>Previous section</FocusableButton>
          <FocusableButton focusId="diagnostics-next" onClick={() => changePage(1)}>Next section</FocusableButton>
          <FocusableButton focusId="diagnostics-page-up" onClick={() => scrollPage(-1)}>Page up</FocusableButton>
          <FocusableButton focusId="diagnostics-page-down" onClick={() => scrollPage(1)}>Page down</FocusableButton>
        </div>
        <div className="ptv-row ptv-diagnostics__actions">
          <FocusableButton focusId="diagnostics-copy" onClick={() => { void copyDiagnostics(); }}>
            Copy diagnostics
          </FocusableButton>
          <FocusableButton focusId="diagnostics-back" onClick={goBack}>Back</FocusableButton>
          <p className="ptv-diagnostics__copy-status" role="status" aria-live="polite">{copyStatus}</p>
        </div>
      </section>
    </LayoutShell>
  );
}
