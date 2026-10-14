import React, { useEffect, useRef, useState } from 'react';
import { normalizeServerUrl } from '../../api/jellyfin/normalizeUrl';
import { LayoutShell } from '../../components/LayoutShell';
import { FocusableButton } from '../../components/FocusableButton';
import { FocusableInput } from '../../components/FocusableInput';
import { useApp } from '../../state/appContext';
import { buildRoute } from '../../navigation/router';
import { ErrorBanner } from '../../components/ErrorBanner';
import { getDefaultServerUrl } from '../../config/server';

export function ServerScreen() {
  const { state, dispatch, services } = useApp();
  const [url, setUrl] = useState(state.serverUrl ?? '');
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setUrl(state.serverUrl ?? '');
  }, [state.serverUrl]);

  useEffect(() => () => requestRef.current?.abort('server-screen-unmounted'), []);

  async function testConnection(urlOverride?: string) {
    const defaultServerUrl = getDefaultServerUrl();
    const baseUrl = typeof urlOverride === 'string' ? urlOverride : url;
    const targetUrl = baseUrl.trim() || defaultServerUrl;
    if (!baseUrl.trim()) {
      setUrl(targetUrl);
    }
    setError(null);
    setMessage('');
    dispatch({ type: 'set_startup', startupInProgress: false, startupMessage: 'Server setup', startupError: null });
    requestRef.current?.abort('superseded-server-attempt');
    const controller = new AbortController();
    requestRef.current = controller;
    const thisAttempt = ++attemptRef.current;
    setChecking(true);
    try {
      const normalized = normalizeServerUrl(targetUrl);
      const savedSessionServerUrl = services.storage.getStoredSessionServerUrl();
      if (savedSessionServerUrl && savedSessionServerUrl !== normalized) {
        await services.logout('server');
      }
      const identity = await services.validateServer(normalized, 10_000, {}, controller.signal);
      if (attemptRef.current !== thisAttempt) return;
      const serverSession = {
        serverId: identity.ServerId,
        baseUrl: normalized,
        serverName: identity.ServerName,
        serverVersion: identity.Version,
        connectedAt: Date.now(),
        lastValidatedAt: Date.now()
      };
      setMessage(`Connected to ${identity.ServerName} (${identity.Version})`);
      services.storage.upsertServer(serverSession);
      dispatch({ type: 'set_server_url', serverUrl: normalized });
      dispatch({ type: 'set_server_session', serverSession });
      dispatch({ type: 'reset_route', route: buildRoute('auth') });
    } catch (error) {
      if (attemptRef.current !== thisAttempt) return;
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : 'Could not connect to server');
    } finally {
      if (attemptRef.current === thisAttempt) {
        requestRef.current = null;
        setChecking(false);
      }
    }
  }

  return (
    <LayoutShell title="Server setup" onSettings={() => dispatch({ type: 'set_route', route: buildRoute('settings') })}>
      <section className="ptv-section">
        <h2>Server</h2>
        <p>Enter Jellyfin server URL, default is {getDefaultServerUrl()}</p>
        <FocusableInput
          focusId="server-url"
          value={url}
          onChange={event => setUrl(event.target.value)}
          placeholder={getDefaultServerUrl()}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              testConnection();
            }
          }}
        />
        <div className="ptv-row">
          <FocusableButton
            focusId="server-test"
            onClick={() => {
              void testConnection();
            }}
            disabled={checking}
          >
            {checking ? 'Checking...' : 'Continue'}
          </FocusableButton>
          <FocusableButton
            focusId="server-use-default"
            onClick={() => {
              if (checking) return;
              const defaultServerUrl = getDefaultServerUrl();
              setUrl(defaultServerUrl);
              setMessage('');
              setError(null);
              void testConnection(defaultServerUrl);
            }}
            disabled={checking}
            className="ptv-auth-card__button ptv-auth-card__button--secondary"
          >
            Use default server
          </FocusableButton>
          {message ? <p>{message}</p> : null}
        </div>
        {state.recentServers.length ? (
          <div className="ptv-recent-servers">
          <h3>Recent servers</h3>
          <ul>
            {state.recentServers.slice(0, 3).map(item => (
              <li key={item}>
                <FocusableButton
                  focusId={`recent-${item}`}
                  onClick={() => {
                    setUrl(item);
                  }}
                >
                  {item}
                </FocusableButton>
                <FocusableButton
                  focusId={`recent-remove-${item}`}
                  onClick={() => {
                    void services.storage.removeServerByUrl(item).then(() => {
                      dispatch({ type: 'set_recent_servers', recentServers: services.storage.getRecentServers() });
                    });
                  }}
                >
                  Remove
                </FocusableButton>
              </li>
            ))}
          </ul>
          </div>
        ) : null}
        {error || state.startupError ? (
          <ErrorBanner message={error ?? state.startupError ?? 'Could not connect to server'} onRetry={testConnection} />
        ) : null}
      </section>
    </LayoutShell>
  );
}
