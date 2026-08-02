import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { AppProvider } from '../src/state/appContext';

function BrokenRoute() {
  throw new Error('render failed at /stream?api_key=boundary-secret');
}

function RecoveryHarness() {
  const [route, setRoute] = useState<'broken' | 'diagnostics'>('broken');
  return (
    <ErrorBoundary onOpenDiagnostics={() => setRoute('diagnostics')}>
      {route === 'broken' ? <BrokenRoute /> : <h1>Diagnostics recovered</h1>}
    </ErrorBoundary>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error boundary recovery', () => {
  it('redacts the fallback and resets it before opening Diagnostics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<AppProvider><RecoveryHarness /></AppProvider>);

    expect(await screen.findByText('Application Error')).toBeTruthy();
    expect(document.body.textContent).not.toContain('boundary-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));

    expect(await screen.findByRole('heading', { name: 'Diagnostics recovered' })).toBeTruthy();
    expect(screen.queryByText('Application Error')).toBeNull();
  });
});
