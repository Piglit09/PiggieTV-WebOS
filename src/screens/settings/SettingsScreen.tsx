import React, { useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { FocusableButton } from '../../components/FocusableButton';
import { redactSensitiveText } from '../../core/redaction';

type SettingsCategory = 'server' | 'account' | 'playback' | 'appearance' | 'diagnostics' | 'signout';

const CATEGORIES: ReadonlyArray<{ id: SettingsCategory; label: string; description: string }> = [
  { id: 'server', label: 'Server', description: 'Connection and server identity' },
  { id: 'account', label: 'Account', description: 'Signed-in profile' },
  { id: 'playback', label: 'Playback', description: 'Playback preferences' },
  { id: 'appearance', label: 'Appearance', description: 'Motion and display preferences' },
  { id: 'diagnostics', label: 'Diagnostics', description: 'Support and performance evidence' },
  { id: 'signout', label: 'Sign out', description: 'End this TV session' }
];

function safeServerOrigin(value: string | null) {
  if (!value) return 'Not configured';
  try {
    return new URL(value).origin;
  } catch {
    return 'Configured server';
  }
}

export function SettingsScreen() {
  const { state, dispatch, services } = useApp();
  const [category, setCategory] = useState<SettingsCategory>('server');
  const [error, setError] = useState<string | null>(null);
  const appVersion = import.meta.env.VITE_PTV_VERSION ?? '0.1.0';

  const leaveSession = async (target: 'auth' | 'server') => {
    services.session.cancelCurrentAttempt();
    await services.playback.stop();
    try {
      services.storage.clearSession();
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : 'Could not clear the saved session'));
      return;
    }
    services.jellyfin.reset();
    dispatch({ type: 'logout' });
    dispatch({ type: 'set_capabilities', capabilities: [], ptvCapabilities: [] });
    dispatch({ type: 'reset_route', route: buildRoute(target) });
  };

  return (
    <LayoutShell title="Settings" onBack={() => dispatch({ type: 'go_back' })} currentSection="settings">
      <section className="ptv-settings">
        <div className="ptv-settings__heading">
          <span className="ptv-eyebrow">PTV preferences</span>
          <h2>Settings</h2>
          <p>Version {appVersion}</p>
        </div>

        <div className="ptv-settings__layout">
          <nav className="ptv-settings__categories" aria-label="Settings categories">
            {CATEGORIES.map(item => (
              <FocusableButton
                key={item.id}
                focusId={`settings-category-${item.id}`}
                preferredRow="settings-categories"
                className={category === item.id ? 'is-selected' : ''}
                aria-current={category === item.id ? 'page' : undefined}
                onClick={() => setCategory(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </FocusableButton>
            ))}
          </nav>

          <div className="ptv-settings__panel">
            {category === 'server' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Connection</span>
                <h3>Server</h3>
                <dl className="ptv-setting-facts">
                  <div><dt>Address</dt><dd>{safeServerOrigin(state.serverUrl)}</dd></div>
                  <div><dt>Name</dt><dd>{state.serverSession?.serverName || 'PTV server'}</dd></div>
                  <div><dt>Version</dt><dd>{state.serverSession?.serverVersion || 'Unavailable'}</dd></div>
                </dl>
                <FocusableButton focusId="settings-switch-server" className="ptv-secondary-action" onClick={() => void leaveSession('server')}>
                  Change server
                </FocusableButton>
              </div>
            ) : null}

            {category === 'account' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Profile</span>
                <h3>Account</h3>
                <div className="ptv-account-card">
                  <span className="ptv-account-card__avatar" aria-hidden="true">{state.userName?.slice(0, 1).toUpperCase() || 'P'}</span>
                  <div><strong>{state.userName || 'Not signed in'}</strong><span>Active on this TV</span></div>
                </div>
              </div>
            ) : null}

            {category === 'playback' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Player</span>
                <h3>Playback</h3>
                <div className="ptv-setting-controls">
                  <FocusableButton
                    focusId="settings-autoplay"
                    onClick={() => dispatch({ type: 'update_settings', settings: { autoPlayNext: !state.settings.autoPlayNext } })}
                  >
                    <span>Auto-play next episode</span><strong>{state.settings.autoPlayNext ? 'On' : 'Off'}</strong>
                  </FocusableButton>
                  <FocusableButton
                    focusId="settings-subtitles"
                    onClick={() => dispatch({ type: 'update_settings', settings: { subtitleDefaultOff: !state.settings.subtitleDefaultOff } })}
                  >
                    <span>Subtitles by default</span><strong>{state.settings.subtitleDefaultOff ? 'Off' : 'On'}</strong>
                  </FocusableButton>
                  <div className="ptv-setting-note">Direct play, direct stream, and transcoding remain enabled under the proven PTV playback policy.</div>
                </div>
              </div>
            ) : null}

            {category === 'appearance' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Display</span>
                <h3>Appearance</h3>
                <div className="ptv-setting-controls">
                  <FocusableButton
                    focusId="settings-motion"
                    onClick={() => dispatch({ type: 'update_settings', settings: { reducedMotion: !state.settings.reducedMotion } })}
                  >
                    <span>Reduced motion</span><strong>{state.settings.reducedMotion ? 'On' : 'Off'}</strong>
                  </FocusableButton>
                  <div className="ptv-setting-note">PTV uses only short opacity and position transitions on this TV.</div>
                </div>
              </div>
            ) : null}

            {category === 'diagnostics' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Support</span>
                <h3>Diagnostics</h3>
                <p>Review redacted app, Home, network, playback, input, focus, and lifecycle evidence.</p>
                <FocusableButton
                  focusId="settings-diagnostics"
                  className="ptv-primary-action"
                  onClick={() => dispatch({ type: 'set_route', route: buildRoute('diagnostics') })}
                >
                  Open diagnostics
                </FocusableButton>
              </div>
            ) : null}

            {category === 'signout' ? (
              <div className="ptv-setting-page">
                <span className="ptv-eyebrow">Session</span>
                <h3>Sign out</h3>
                <p>This removes the saved PTV session and clears cached media from this TV.</p>
                <FocusableButton
                  focusId="settings-sign-out"
                  className="ptv-danger-action"
                  onClick={() => void leaveSession('auth')}
                  disabled={!state.userSession}
                >
                  Sign out of PTV
                </FocusableButton>
              </div>
            ) : null}

            {error ? <p className="ptv-error" role="alert">{error}</p> : null}
          </div>
        </div>
      </section>
    </LayoutShell>
  );
}
