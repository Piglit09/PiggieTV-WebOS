import React, { useEffect, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { FocusableButton } from '../../components/FocusableButton';
import { ErrorBanner } from '../../components/ErrorBanner';

export function QuickConnectScreen() {
  const { state, dispatch, services } = useApp();
  const [sessionState, setSessionState] = useState(() => services.session.getState());
  const [retryKey, setRetryKey] = useState(0);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  useEffect(() => services.session.subscribe(setSessionState), [services.session]);

  useEffect(() => {
    if (!state.serverUrl) return;
    void services.session.startQuickConnect({
      serverUrl: state.serverUrl,
      serverId: state.serverSession?.serverId
    });
    return () => services.session.cancelCurrentAttempt();
  }, [retryKey, services.session, state.serverSession?.serverId, state.serverUrl]);

  const goBack = () => {
    services.session.cancelCurrentAttempt();
    if (state.routeHistory.length > 0) {
      dispatch({ type: 'go_back' });
    } else {
      dispatch({ type: 'set_route', route: buildRoute('auth'), replace: true });
    }
  };

  const status = sessionState.stage === 'VALIDATING_INPUT' || sessionState.stage === 'REQUEST_STARTED'
    ? 'Starting Quick Connect…'
    : sessionState.quickConnectCode
      ? 'Authorize this code in a signed-in Jellyfin app.'
      : sessionState.status === 'error'
        ? 'Quick Connect stopped.'
        : 'Waiting for the server…';
  const diagnostic = services.session.getDiagnosticSnapshot();

  return (
    <LayoutShell title="Quick Connect" onBack={goBack}>
      <section className="ptv-section">
        <h2>Quick Connect</h2>
        <p>{status}</p>
        {sessionState.quickConnectCode ? <div className="ptv-quick-code">{sessionState.quickConnectCode}</div> : null}
        <div className="ptv-row">
          <FocusableButton
            focusId="qc-retry"
            onClick={() => {
              services.session.cancelCurrentAttempt();
              setRetryKey(value => value + 1);
            }}
            disabled={sessionState.status === 'pending'}
          >
            Retry
          </FocusableButton>
          <FocusableButton
            focusId="qc-diagnostics-toggle"
            onClick={() => setDiagnosticsOpen(open => !open)}
          >
            {diagnosticsOpen ? 'Hide diagnostics' : 'Show diagnostics'}
          </FocusableButton>
        </div>
        {diagnosticsOpen ? (
          <div className="ptv-auth-diagnostics">
            <p>Attempt: {diagnostic?.attemptId ?? 'none'} · Stage: {diagnostic?.stage ?? 'IDLE'} · Status: {diagnostic?.status ?? 'idle'}</p>
            <p>HTTP: {diagnostic?.httpStatus ?? 'n/a'} · Duration: {diagnostic?.durationMs ?? 0} ms · Result: {diagnostic?.resultClassification ?? 'pending'}</p>
            <p>Navigation count: {diagnostic?.navigationRequestCount ?? 0} · Stale: {String(diagnostic?.stale ?? false)} · Cancelled: {String(diagnostic?.cancelled ?? false)}</p>
            <p>Stages: {diagnostic?.stageHistory.slice(-12).map(entry => entry.stage).join(' → ') ?? 'none'}</p>
          </div>
        ) : null}
        {sessionState.status === 'error' && sessionState.errorMessage ? (
          <ErrorBanner
            message={sessionState.errorMessage}
            onRetry={() => setRetryKey(value => value + 1)}
          />
        ) : null}
      </section>
    </LayoutShell>
  );
}
