import React from 'react';
import { useApp } from '../state/appContext';
import { buildRoute, type PtvScreen } from '../navigation/router';
import { FocusableButton } from './FocusableButton';

type ShellSection = 'home' | 'movies' | 'shows' | 'music' | 'reading' | 'search' | 'settings';

const PRIMARY_NAV: ReadonlyArray<{ section: Exclude<ShellSection, 'settings'>; label: string; screen: PtvScreen }> = [
  { section: 'home', label: 'Home', screen: 'home' },
  { section: 'movies', label: 'Movies', screen: 'movies' },
  { section: 'shows', label: 'Shows', screen: 'shows' },
  { section: 'music', label: 'Music', screen: 'music' },
  { section: 'reading', label: 'Reading', screen: 'reading' },
  { section: 'search', label: 'Search', screen: 'search' }
];

function routeSection(screen: PtvScreen): ShellSection | null {
  if (screen === 'settings' || screen === 'diagnostics') return 'settings';
  return PRIMARY_NAV.some(item => item.screen === screen) ? screen as ShellSection : null;
}

function profileInitial(name: string | null) {
  const candidate = name?.trim();
  return candidate ? candidate.slice(0, 1).toUpperCase() : 'P';
}

export function LayoutShell({ children, title, onSettings, onBack, currentSection }: {
  children: React.ReactNode;
  title: string;
  onSettings?: () => void;
  onBack?: () => void;
  currentSection?: ShellSection | null;
}) {
  const { state, dispatch } = useApp();
  const authenticated = Boolean(state.userSession);
  const historySection = state.routeHistory
    .slice()
    .reverse()
    .map(route => routeSection(route.screen))
    .find((section): section is ShellSection => Boolean(section));
  const selectedSection = currentSection ?? routeSection(state.route.screen) ?? historySection ?? null;

  const openSettings = () => {
    if (onSettings) {
      onSettings();
      return;
    }
    dispatch({ type: 'set_route', route: buildRoute('settings') });
  };

  return (
    <div className="ptv-shell">
      <header className="ptv-topbar" aria-label="PTV application navigation">
        <div className="ptv-brand" aria-label="PiggieTV">
          <img className="ptv-brand__logo" src="icon-phase2.png" alt="" aria-hidden="true" draggable={false} />
          <h1 aria-label="PiggieTV">PiggieTV</h1>
        </div>

        {authenticated ? (
          <nav className="ptv-topbar__nav" aria-label="Primary">
            {PRIMARY_NAV.map(item => {
              const selected = selectedSection === item.section;
              return (
                <FocusableButton
                  key={item.section}
                  focusId={`shell-${item.section}`}
                  preferredRow="shell-primary"
                  className={`ptv-nav-item ${selected ? 'is-current' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => dispatch({ type: 'reset_route', route: buildRoute(item.screen) })}
                >
                  {item.label}
                </FocusableButton>
              );
            })}
          </nav>
        ) : <div className="ptv-topbar__nav-placeholder" />}

        <div className="ptv-topbar__utilities">
          {authenticated ? (
            <FocusableButton
              focusId="shell-profile"
              preferredRow="shell-primary"
              className={`ptv-profile ${selectedSection === 'settings' ? 'is-current' : ''}`}
              aria-label={`Profile: ${state.userName || 'PTV user'}`}
              onClick={openSettings}
            >
              <span aria-hidden="true">{profileInitial(state.userName)}</span>
            </FocusableButton>
          ) : null}
          {authenticated || onSettings ? (
            <FocusableButton
              focusId="shell-settings"
              preferredRow="shell-primary"
              className={`ptv-utility ${selectedSection === 'settings' ? 'is-current' : ''}`}
              aria-current={selectedSection === 'settings' ? 'page' : undefined}
              onClick={openSettings}
            >
              Settings
            </FocusableButton>
          ) : null}
          {onBack ? (
            <FocusableButton
              focusId={`shell-back-${state.route.screen}`}
              preferredRow="shell-primary"
              onClick={onBack}
              className="ptv-back-action"
              aria-label="Back"
            >
              <span aria-hidden="true">←</span>
              <span>Back</span>
            </FocusableButton>
          ) : null}
        </div>
        <span className="ptv-visually-hidden">{title}</span>
      </header>
      <main className="ptv-content" aria-label={title}>{children}</main>
    </div>
  );
}
