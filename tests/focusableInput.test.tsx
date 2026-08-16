import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FocusableButton } from '../src/components/FocusableButton';
import { FocusableInput } from '../src/components/FocusableInput';
import { AppProvider } from '../src/state/appContext';

afterEach(() => cleanup());

describe('FocusableInput', () => {
  it('registers an input in the current route focus graph', async () => {
    render(
      <AppProvider>
        <FocusableInput focusId="login-username" aria-label="Username" />
      </AppProvider>
    );

    const input = screen.getByLabelText('Username');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('data-focus-id')).toBe('login-username');
    expect(input.getAttribute('data-focus-route')).toBe('startup');
    expect(input.getAttribute('tabindex')).toBe('-1');
    expect(input.classList.contains('is-focused')).toBe(true);
  });

  it('does not natively focus an input on pointer hover but does on genuine mouse-down', async () => {
    render(
      <AppProvider>
        <FocusableButton focusId="login-before-input">Before input</FocusableButton>
        <FocusableInput focusId="login-username" aria-label="Username" />
      </AppProvider>
    );

    const beforeInput = screen.getByRole('button', { name: 'Before input' });
    const input = screen.getByLabelText('Username');
    await waitFor(() => expect(document.activeElement).toBe(beforeInput));

    fireEvent.mouseMove(input, { clientX: 419, clientY: 260 });
    fireEvent.mouseMove(input, { clientX: 420, clientY: 260 });
    expect(document.activeElement).toBe(beforeInput);
    expect(beforeInput.classList.contains('is-focused')).toBe(true);
    expect(input.classList.contains('is-focused')).toBe(false);

    fireEvent.mouseDown(input, { clientX: 420, clientY: 260, detail: 1 });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
      expect(input.classList.contains('is-focused')).toBe(true);
      expect(beforeInput.classList.contains('is-focused')).toBe(false);
    });
  });
});
