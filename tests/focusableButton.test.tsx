import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusableButton } from '../src/components/FocusableButton';
import { FocusManager } from '../src/focus/FocusManager';
import { AppProvider, useApp } from '../src/state/appContext';

let capturedManager: FocusManager | null = null;

function FocusManagerCapture() {
  capturedManager = useApp().services.focusManager;
  return null;
}

function manager() {
  if (!capturedManager) throw new Error('FocusManager was not captured');
  return capturedManager;
}

function expectOnlyOwner(expected: HTMLElement) {
  const managed = document.querySelectorAll<HTMLElement>('.ptv-focusable.is-focused');
  const union = document.querySelectorAll<HTMLElement>(
    '[data-focus-id].is-focused, [data-focus-id]:focus'
  );
  expect(managed).toHaveLength(1);
  expect(managed[0]).toBe(expected);
  expect(document.activeElement).toBe(expected);
  expect(union).toHaveLength(1);
  expect(union[0]).toBe(expected);
}

afterEach(() => {
  capturedManager = null;
  cleanup();
});

describe('FocusableButton interaction ownership', () => {
  it('ignores stationary mouseenter and repeatedly switches pointer to remote only on real input intent', async () => {
    render(
      <AppProvider>
        <FocusManagerCapture />
        <FocusableButton focusId="first" preferredRow="test-row">First</FocusableButton>
        <FocusableButton focusId="second" preferredRow="test-row">Second</FocusableButton>
      </AppProvider>
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    await waitFor(() => expectOnlyOwner(first));

    fireEvent.mouseEnter(second, { clientX: 300, clientY: 180 });
    expectOnlyOwner(first);
    expect(manager().interactionMode).toBe('remote');

    fireEvent.mouseMove(second, { clientX: 299, clientY: 180 });
    expectOnlyOwner(first);
    expect(manager().interactionMode).toBe('remote');
    fireEvent.mouseMove(second, { clientX: 300, clientY: 180 });
    await waitFor(() => expectOnlyOwner(second));
    expect(manager().interactionMode).toBe('pointer');

    expect(manager().move('left', { inputKey: 'ArrowLeft' }).current).toBe('first');
    await waitFor(() => expectOnlyOwner(first));
    expect(manager().interactionMode).toBe('remote');

    fireEvent.mouseEnter(second, { clientX: 300, clientY: 180 });
    fireEvent.mouseMove(second, { clientX: 300, clientY: 180 });
    expectOnlyOwner(first);
    expect(manager().interactionMode).toBe('remote');

    fireEvent.mouseMove(second, { clientX: 301, clientY: 180 });
    expectOnlyOwner(first);
    expect(manager().interactionMode).toBe('remote');

    fireEvent.mouseMove(second, { clientX: 302, clientY: 180 });
    await waitFor(() => expectOnlyOwner(second));
    expect(manager().interactionMode).toBe('pointer');

    expect(manager().move('left', { inputKey: 'ArrowLeft' }).current).toBe('first');
    await waitFor(() => expectOnlyOwner(first));
    expect(manager().interactionMode).toBe('remote');

    fireEvent.mouseMove(second, { clientX: 303, clientY: 180 });
    expectOnlyOwner(first);
    fireEvent.mouseMove(second, { clientX: 304, clientY: 180 });
    await waitFor(() => expectOnlyOwner(second));
    expect(manager().interactionMode).toBe('pointer');
  });

  it('distinguishes real mouse activation from remote programmatic activation', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <AppProvider>
        <FocusManagerCapture />
        <FocusableButton focusId="first" preferredRow="test-row" onClick={onFirst}>First</FocusableButton>
        <FocusableButton focusId="second" preferredRow="test-row" onClick={onSecond}>Second</FocusableButton>
      </AppProvider>
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    await waitFor(() => expectOnlyOwner(first));

    manager().recordPointerMovement(279, 160);
    manager().recordPointerMovement(280, 160);
    expect(manager().interactionMode).toBe('pointer');
    expect(manager().activateCurrent({ inputKey: 'Enter', reason: 'activate' })).toBe(true);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(manager().interactionMode).toBe('remote');
    expectOnlyOwner(first);

    fireEvent.mouseDown(second, { clientX: 420, clientY: 220, detail: 1 });
    fireEvent.click(second, { clientX: 420, clientY: 220, detail: 1 });
    await waitFor(() => expectOnlyOwner(second));
    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(manager().interactionMode).toBe('pointer');
    expect(manager().interactionState).toMatchObject({
      lastPointerX: 420,
      lastPointerY: 220
    });
  });
});
