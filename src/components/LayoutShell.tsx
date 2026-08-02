import React from 'react';
import { useApp } from '../state/appContext';
import { FocusableButton } from './FocusableButton';

export function LayoutShell({ children, title, onDiagnostics, onSettings, onBack }: {
  children: React.ReactNode;
  title: string;
  onDiagnostics?: () => void;
  onSettings?: () => void;
  onBack?: () => void;
}) {
  const { state } = useApp();
  const focusPrefix = `layout-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <div className="ptv-shell">
      <div className="ptv-topbar">
        <h1 className="ptv-topbar__title">{title}</h1>
        <div className="ptv-topbar__meta">{state.userName || 'Not signed in'}</div>
        <div className="ptv-topbar__actions">
          {onDiagnostics ? (
            <FocusableButton focusId={`${focusPrefix}-diagnostics`} onClick={onDiagnostics}>Diagnostics</FocusableButton>
          ) : null}
          {onSettings ? (
            <FocusableButton focusId={`${focusPrefix}-settings`} onClick={onSettings}>Settings</FocusableButton>
          ) : null}
          {onBack ? (
            <FocusableButton focusId={`${focusPrefix}-back`} onClick={onBack} className="ptv-back-action">← Back</FocusableButton>
          ) : null}
        </div>
      </div>
      <main className="ptv-content">{children}</main>
    </div>
  );
}
