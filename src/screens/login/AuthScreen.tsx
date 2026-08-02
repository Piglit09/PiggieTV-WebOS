import React, { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { buildRoute } from '../../navigation/router';
import { LayoutShell } from '../../components/LayoutShell';
import { ErrorBanner } from '../../components/ErrorBanner';
import { FocusableButton } from '../../components/FocusableButton';
import { FocusableInput } from '../../components/FocusableInput';
import type { SessionControllerState } from '../../auth/sessionController';

type ServerTestState = {
  status: 'idle' | 'running' | 'success' | 'failed';
  durationMs: number;
  httpStatus: number | null;
  serverName?: string;
  serverVersion?: string;
  errorMessage?: string;
};

const SERVER_TEST_TIMEOUT_MS = 10_000;
const showDiagnostics = true;

function stageLabel(state: SessionControllerState) {
  if (state.workflow === 'quick-connect') return 'Waiting for Quick Connect…';
  if (state.stage === 'VALIDATING_INPUT') return 'Checking credentials…';
  if (state.stage === 'REQUEST_STARTED' || state.stage === 'RESPONSE_RECEIVED' || state.stage === 'AUTH_JSON_PARSED') {
    return 'Signing in…';
  }
  if (state.stage === 'AUTH_RESULT_VALIDATED' || state.stage === 'SESSION_PERSIST_STARTED') return 'Saving session…';
  if (state.stage === 'SESSION_PERSISTED' || state.stage === 'API_CONTEXT_UPDATED') return 'Preparing your session…';
  if (state.stage === 'AUTH_STATE_COMMITTED' || state.stage === 'NAVIGATION_REQUESTED') return 'Opening Home…';
  return '';
}

export function AuthScreen() {
  const { state, dispatch, services } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [controllerState, setControllerState] = useState(() => services.session.getState());
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [serverTest, setServerTest] = useState<ServerTestState>({
    status: 'idle',
    durationMs: 0,
    httpStatus: null
  });
  const serverTestRequest = useRef<AbortController | null>(null);

  useEffect(() => services.session.subscribe(setControllerState), [services.session]);
  useEffect(() => () => serverTestRequest.current?.abort('auth-screen-unmounted'), []);

  const diagnostic = services.session.getDiagnosticSnapshot();
  const busy = controllerState.status === 'pending';
  const error = controllerState.status === 'error'
    ? controllerState.errorMessage
    : state.startupError;
  const canRetrySavedSession = Boolean(state.startupError && services.storage.getState().session);
  const serverOrigin = useMemo(() => {
    try {
      return state.serverUrl ? new URL(state.serverUrl).origin : 'not configured';
    } catch {
      return 'invalid server';
    }
  }, [state.serverUrl]);

  const handleSignIn = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    dispatch({ type: 'set_startup', startupInProgress: false, startupMessage: 'Sign in', startupError: null });
    void services.session.authenticateByName({
      serverUrl: state.serverUrl ?? '',
      serverId: state.serverSession?.serverId,
      username,
      password
    });
  };

  const runServerTest = async () => {
    if (!state.serverUrl || busy || serverTest.status === 'running') return;
    serverTestRequest.current?.abort('superseded-server-test');
    const controller = new AbortController();
    serverTestRequest.current = controller;
    const startedAt = Date.now();
    let status = 0;
    setServerTest({ status: 'running', durationMs: 0, httpStatus: null });

    try {
      const response = await services.jellyfin.configureServer(state.serverUrl).validateServer(
        SERVER_TEST_TIMEOUT_MS,
        { onResponseReceived: payload => { status = payload.status; } },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setServerTest({
        status: 'success',
        durationMs: Date.now() - startedAt,
        httpStatus: status || 200,
        serverName: response.ServerName,
        serverVersion: response.Version
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setServerTest({
        status: 'failed',
        durationMs: Date.now() - startedAt,
        httpStatus: status || null,
        errorMessage: cause instanceof Error ? cause.message : 'Server test failed'
      });
    } finally {
      if (serverTestRequest.current === controller) serverTestRequest.current = null;
    }
  };

  const goBack = () => {
    services.session.cancelCurrentAttempt();
    dispatch({ type: 'reset_route', route: buildRoute('server') });
  };

  return (
    <LayoutShell title="Sign in">
      <section className="ptv-auth-card">
        <h1 className="ptv-auth-card__title">Sign in to PTV</h1>
        <p className="ptv-auth-card__server">Server: {serverOrigin}</p>
        <form className="ptv-auth-card__form" onSubmit={handleSignIn}>
          <label className="ptv-auth-card__field">
            Username
            <FocusableInput
              focusId="auth-username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              className="ptv-auth-card__input"
            />
          </label>
          <label className="ptv-auth-card__field">
            Password
            <FocusableInput
              focusId="auth-password"
              value={password}
              type="password"
              autoComplete="current-password"
              onChange={event => setPassword(event.target.value)}
              className="ptv-auth-card__input"
            />
          </label>
          {busy ? <p className="ptv-auth-card__status" role="status">{stageLabel(controllerState)}</p> : null}
          <div className="ptv-row ptv-auth-card__actions">
            <FocusableButton
              focusId="auth-login"
              type="button"
              onClick={handleSignIn}
              disabled={busy}
              className="ptv-auth-card__button"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </FocusableButton>
            {busy ? (
              <FocusableButton
                focusId="auth-cancel"
                type="button"
                onClick={() => services.session.cancelCurrentAttempt()}
                className="ptv-auth-card__button ptv-auth-card__button--secondary"
              >
                Cancel
              </FocusableButton>
            ) : null}
            <FocusableButton
              focusId="auth-quick-connect"
              type="button"
              onClick={() => dispatch({ type: 'set_route', route: buildRoute('quick-connect') })}
              disabled={busy}
              className="ptv-auth-card__button"
            >
              Quick Connect
            </FocusableButton>
            <FocusableButton
              focusId="auth-server-test"
              type="button"
              onClick={() => void runServerTest()}
              disabled={busy || !state.serverUrl || serverTest.status === 'running'}
              className="ptv-auth-card__button ptv-auth-card__button--secondary"
            >
              {serverTest.status === 'running' ? 'Testing…' : 'Test server'}
            </FocusableButton>
            <FocusableButton focusId="auth-change-server" type="button" onClick={goBack} className="ptv-auth-card__button ptv-auth-card__button--secondary">
              Change server
            </FocusableButton>
            <FocusableButton
              focusId="auth-settings"
              type="button"
              onClick={() => dispatch({ type: 'set_route', route: buildRoute('settings') })}
              disabled={busy}
              className="ptv-auth-card__button ptv-auth-card__button--secondary"
            >
              Settings
            </FocusableButton>
            {showDiagnostics ? (
              <FocusableButton
                focusId="auth-diagnostics-toggle"
                type="button"
                onClick={() => setDiagnosticsOpen(open => !open)}
                className="ptv-auth-card__button ptv-auth-card__button--secondary"
              >
                {diagnosticsOpen ? 'Hide diagnostics' : 'Show diagnostics'}
              </FocusableButton>
            ) : null}
          </div>
          <button className="ptv-auth-card__hidden-submit" type="submit" aria-hidden="true" tabIndex={-1} />
        </form>

        {showDiagnostics && diagnosticsOpen ? (
          <div className="ptv-auth-diagnostics">
            <p>Attempt: {diagnostic?.attemptId ?? 'none'} · Stage: {diagnostic?.stage ?? 'IDLE'} · Status: {diagnostic?.status ?? 'idle'}</p>
            <p>Origin: {diagnostic?.serverOrigin ?? serverOrigin} · HTTP: {diagnostic?.httpStatus ?? 'n/a'} · Duration: {diagnostic?.durationMs ?? 0} ms</p>
            <p>Result: {diagnostic?.resultClassification ?? 'pending'} · User: {diagnostic?.userIdSuffix ?? 'n/a'}</p>
            <p>
              Persisted: {String(diagnostic?.persistenceSucceeded ?? false)} · API: {String(diagnostic?.apiContextUpdated ?? false)} · State: {String(diagnostic?.authStateCommitted ?? false)} · Navigation count: {diagnostic?.navigationRequestCount ?? 0}
            </p>
            <p>Stages: {diagnostic?.stageHistory.map(entry => entry.stage).join(' → ') ?? 'none'}</p>
            <p>Stale: {String(diagnostic?.stale ?? false)} · Cancelled: {String(diagnostic?.cancelled ?? false)}</p>
            {serverTest.status !== 'idle' ? (
              <p>Server test: {serverTest.status} · HTTP: {serverTest.httpStatus ?? 'n/a'} · {serverTest.durationMs} ms · {serverTest.serverName ?? serverTest.errorMessage ?? ''} {serverTest.serverVersion ?? ''}</p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <ErrorBanner
            message={error}
            onRetry={canRetrySavedSession
              ? () => dispatch({ type: 'retry_bootstrap' })
              : handleSignIn}
            onBack={goBack}
          />
        ) : null}
      </section>
    </LayoutShell>
  );
}
