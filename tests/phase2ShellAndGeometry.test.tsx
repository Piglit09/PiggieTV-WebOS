import React, { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LayoutShell } from '../src/components/LayoutShell';
import {
  calculateHomeVerticalOffset,
  calculateShelfStartIndex
} from '../src/screens/home/HomeScreen';
import { AppProvider, useApp } from '../src/state/appContext';
import { buildRoute, type PtvScreen } from '../src/navigation/router';
import type { PtvUserSession } from '../src/types/ptv';

const authenticatedSession: PtvUserSession = {
  userId: 'shell-user',
  userName: 'Viewer',
  accessToken: 'test-token',
  serverId: 'shell-server',
  serverUrl: 'https://server.example.com',
  deviceId: 'shell-device',
  createdAt: 1,
  updatedAt: 1
};

function ShellHarness() {
  const { state, dispatch } = useApp();

  useEffect(() => {
    dispatch({ type: 'set_user_session', userSession: authenticatedSession });
    dispatch({ type: 'reset_route', route: buildRoute('home') });
  }, [dispatch]);

  return (
    <LayoutShell title="Phase 2 shell">
      <output data-testid="current-route">{state.route.screen}</output>
    </LayoutShell>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Phase 2 Home geometry', () => {
  it.each([
    { visibleCards: 5, expectedFinalStart: 11 },
    { visibleCards: 8, expectedFinalStart: 8 }
  ])('keeps every focused card inside a $visibleCards-card window', ({ visibleCards, expectedFinalStart }) => {
    let startIndex = 0;
    for (let focusedIndex = 0; focusedIndex < 16; focusedIndex += 1) {
      startIndex = calculateShelfStartIndex(focusedIndex, startIndex, visibleCards);
      const focusedSlot = focusedIndex - startIndex;
      expect(focusedSlot).toBeGreaterThanOrEqual(0);
      expect(focusedSlot).toBeLessThan(visibleCards);
    }

    expect(startIndex).toBe(expectedFinalStart);
    expect(15 - startIndex).toBe(visibleCards - 1);

    for (let focusedIndex = 14; focusedIndex >= 0; focusedIndex -= 1) {
      startIndex = calculateShelfStartIndex(focusedIndex, startIndex, visibleCards);
      const focusedSlot = focusedIndex - startIndex;
      expect(focusedSlot).toBeGreaterThanOrEqual(0);
      expect(focusedSlot).toBeLessThan(visibleCards);
    }
    expect(startIndex).toBe(0);
  });

  it('keeps the first and final Home rows within the controlled 900px viewport', () => {
    const rowTops = [388, 710, 1032, 1434];
    const rowHeights = [322, 322, 402, 402];
    const offsets = rowTops.map((_, rowIndex) => calculateHomeVerticalOffset(rowIndex, 900));

    expect(calculateHomeVerticalOffset(-1, 900)).toBe(0);
    expect(offsets).toEqual([300, 622, 936, 936]);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));

    for (let rowIndex = 0; rowIndex < rowTops.length; rowIndex += 1) {
      const translatedTop = (rowTops[rowIndex] ?? 0) - (offsets[rowIndex] ?? 0);
      const translatedBottom = translatedTop + (rowHeights[rowIndex] ?? 0);
      expect(translatedTop).toBeGreaterThanOrEqual(0);
      expect(translatedBottom).toBeLessThanOrEqual(900);
    }

    const finalBottom = (rowTops[3] ?? 0) - (offsets[3] ?? 0) + (rowHeights[3] ?? 0);
    expect(finalBottom).toBe(900);
  });
});

describe('Phase 2 authenticated shell contract', () => {
  it('renders the PTV brand, routes every primary destination, and exposes no Home Diagnostics shortcut', async () => {
    render(<AppProvider><ShellHarness /></AppProvider>);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'PiggieTV' }).textContent).toBe('PiggieTV');
    expect(document.querySelector('.ptv-brand__logo')?.getAttribute('src')).toBe('icon-phase2.png');
    expect(screen.queryByRole('button', { name: /diagnostics/i })).toBeNull();

    const home = screen.getByRole('button', { name: 'Home' });
    expect(home.getAttribute('aria-current')).toBe('page');

    const destinations: ReadonlyArray<[string, PtvScreen]> = [
      ['Movies', 'movies'],
      ['Shows', 'shows'],
      ['Music', 'music'],
      ['Reading', 'reading'],
      ['Search', 'search']
    ];
    for (const [label, destination] of destinations) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(screen.getByTestId('current-route').textContent).toBe(destination));
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-current')).toBe('page');
    }

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByTestId('current-route').textContent).toBe('settings'));
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Search' }).hasAttribute('aria-current')).toBe(false);
  });
});
