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
          <FocusableButton focusId="qc-back" onClick={goBack}>Back</FocusableButton>
        </div>
        {sessionState.status === 'error' && sessionState.errorMessage ? (
          <ErrorBanner
            message={sessionState.errorMessage}
            onRetry={() => setRetryKey(value => value + 1)}
            onBack={goBack}
          />
        ) : null}
      </section>
    </LayoutShell>
  );
}
