import React, { useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { FocusableButton } from '../../components/FocusableButton';

export function SettingsScreen() {
  const { state, dispatch, services } = useApp();
  const [error, setError] = useState<string | null>(null);
  const appVersion = import.meta.env.VITE_PTV_VERSION ?? '0.1.0';

  const leaveSession = async (target: 'auth' | 'server') => {
    services.session.cancelCurrentAttempt();
    await services.playback.stop();
    try {
      services.storage.clearSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear the saved session');
      return;
    }
    services.jellyfin.reset();
    dispatch({ type: 'logout' });
    dispatch({ type: 'set_capabilities', capabilities: [], ptvCapabilities: [] });
    dispatch({ type: 'reset_route', route: buildRoute(target) });
  };

  return (
    <LayoutShell title="Settings" onBack={() => dispatch({ type: 'go_back' })}>
      <section className="ptv-section">
        <h2>Application</h2>
        <p>Version {appVersion}</p>
        <p>Server: {state.serverUrl || 'Not configured'}</p>
        <p>User: {state.userName || 'Not signed in'}</p>

        <h3>Playback options</h3>
        <div className="ptv-row">
          <FocusableButton
            focusId="settings-autoplay"
            onClick={() => dispatch({ type: 'update_settings', settings: { autoPlayNext: !state.settings.autoPlayNext } })}
          >
            Auto-play next: {state.settings.autoPlayNext ? 'On' : 'Off'}
          </FocusableButton>
          <FocusableButton
            focusId="settings-subtitles"
            onClick={() => dispatch({ type: 'update_settings', settings: { subtitleDefaultOff: !state.settings.subtitleDefaultOff } })}
          >
            Subtitles by default: {state.settings.subtitleDefaultOff ? 'Off' : 'On'}
          </FocusableButton>
        </div>

        <h3>Session</h3>
        <div className="ptv-row">
          <FocusableButton focusId="settings-sign-out" onClick={() => void leaveSession('auth')} disabled={!state.userSession}>
            Sign out
          </FocusableButton>
          <FocusableButton focusId="settings-switch-server" onClick={() => void leaveSession('server')}>
            Change server
          </FocusableButton>
        </div>

        <h3>Diagnostics</h3>
        <FocusableButton
          focusId="settings-diagnostics"
          onClick={() => dispatch({ type: 'set_route', route: buildRoute('diagnostics') })}
        >
          Open diagnostics
        </FocusableButton>
        {error ? <p className="ptv-error">{error}</p> : null}
      </section>
    </LayoutShell>
  );
}
