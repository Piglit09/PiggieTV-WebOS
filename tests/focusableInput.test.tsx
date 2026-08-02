import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
});
