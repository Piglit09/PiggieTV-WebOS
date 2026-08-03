import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardTile } from '../src/components/CardTile';
import { AppProvider } from '../src/state/appContext';
import type { PtvItem } from '../src/types/ptv';

const movie: PtvItem = {
  id: 'movie-1',
  name: 'Deferred artwork movie',
  type: 'Movie'
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CardTile artwork loading', () => {
  it('defers a lazy image until its card approaches the viewport', () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '320px 0px';
      thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);

    const view = render(
      <AppProvider>
        <CardTile
          item={movie}
          focusId="card-movie-1"
          posterUrl="https://images.example.test/movie-1.jpg"
          onOpen={() => undefined}
          lazy
        />
      </AppProvider>
    );

    expect(view.container.querySelector('img')).toBeNull();
    expect(intersectionCallback).not.toBeNull();

    act(() => {
      intersectionCallback?.([{
        isIntersecting: true,
        intersectionRatio: 1
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://images.example.test/movie-1.jpg');
  });
});
