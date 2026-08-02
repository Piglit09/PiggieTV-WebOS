import React from 'react';
import { useApp } from '../state/appContext';

export function StartupScreen() {
  const { state } = useApp();
  return (
    <div className="ptv-startup">
      <h1>PiggieTV</h1>
      <p>{state.startupMessage}</p>
      {state.startupError ? <p className="ptv-startup__error">{state.startupError}</p> : null}
    </div>
  );
}
