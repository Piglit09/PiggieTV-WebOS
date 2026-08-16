import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardTile } from '../src/components/CardTile';
import { AppProvider } from '../src/state/appContext';
import type { PtvItem } from '../src/types/ptv';
import { ArtworkLoadScheduler } from '../src/utils/artworkLoadScheduler';

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

  it('exposes fade loading state and the subtle placeholder until artwork loads', () => {
    const onImageLoad = vi.fn();
    const view = render(
      <AppProvider>
        <CardTile
          item={movie}
          focusId="card-movie-1"
          posterUrl="https://images.example.test/movie-1.jpg"
          onOpen={() => undefined}
          fadeArtwork
          placeholderVariant="subtle"
          onImageLoad={onImageLoad}
        />
      </AppProvider>
    );

    const placeholder = view.container.querySelector('.ptv-card-placeholder');
    const image = view.container.querySelector<HTMLImageElement>('.ptv-card-art__image');
    expect(placeholder?.classList.contains('ptv-card-placeholder--subtle')).toBe(true);
    expect(image?.classList.contains('ptv-card-art__image--fade')).toBe(true);
    expect(image?.classList.contains('is-loaded')).toBe(false);
    expect(image?.getAttribute('data-image-state')).toBe('loading');

    if (!image) throw new Error('Expected CardTile artwork');
    fireEvent.load(image);

    expect(image.classList.contains('is-loaded')).toBe(true);
    expect(image.getAttribute('data-image-state')).toBe('loaded');
    expect(onImageLoad).toHaveBeenCalledOnce();
  });

  it('marks an artwork error, removes the failed image, and leaves the placeholder visible', () => {
    const onImageError = vi.fn();
    const view = render(
      <AppProvider>
        <CardTile
          item={movie}
          focusId="card-movie-1"
          posterUrl="https://images.example.test/movie-1.jpg"
          onOpen={() => undefined}
          fadeArtwork
          placeholderVariant="subtle"
          onImageError={onImageError}
        />
      </AppProvider>
    );

    const image = view.container.querySelector<HTMLImageElement>('.ptv-card-art__image');
    if (!image) throw new Error('Expected CardTile artwork');
    fireEvent.error(image);

    expect(image.getAttribute('data-image-state')).toBe('error');
    expect(view.container.querySelector('.ptv-card-art__image')).toBeNull();
    expect(view.container.querySelector('.ptv-card-placeholder--subtle')).not.toBeNull();
    expect(onImageError).toHaveBeenCalledOnce();
  });

  it('uses an injected scheduler to keep six artwork requests active while load and error advance the queue', async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      instance: IntersectionObserver;
      target?: Element;
    }> = [];
    class QueuedArtworkIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '320px 0px';
      readonly thresholds = [0];
      private readonly record: (typeof observers)[number];

      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, instance: this };
        observers.push(this.record);
      }

      disconnect() {}
      observe(target: Element) { this.record.target = target; }
      takeRecords() { return []; }
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', QueuedArtworkIntersectionObserver);
    const scheduler = new ArtworkLoadScheduler(6);
    const items = Array.from({ length: 8 }, (_, index): PtvItem => ({
      id: `movie-${index + 1}`,
      name: `Queued movie ${index + 1}`,
      type: 'Movie'
    }));
    const view = render(
      <AppProvider>
        <ul>
          {items.map((item, index) => (
            <CardTile
              key={item.id}
              item={item}
              focusId={`card-${item.id}`}
              posterUrl={`https://images.example.test/movie-${index + 1}.jpg`}
              onOpen={() => undefined}
              fadeArtwork
              lazy
              artworkLoadScheduler={scheduler}
            />
          ))}
        </ul>
      </AppProvider>
    );
    const loadingImages = () => Array.from(
      view.container.querySelectorAll<HTMLImageElement>('img[data-image-state="loading"]')
    );

    expect(observers).toHaveLength(8);
    act(() => {
      for (const observer of observers) {
        if (!observer.target) throw new Error('Expected an observed CardTile artwork element');
        observer.callback([{
          isIntersecting: true,
          intersectionRatio: 1,
          target: observer.target
        } as IntersectionObserverEntry], observer.instance);
      }
    });

    await waitFor(() => expect(loadingImages()).toHaveLength(6));
    expect(view.container.querySelector('img[src="https://images.example.test/movie-7.jpg"]')).toBeNull();
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(2);

    const firstImage = loadingImages()[0];
    if (!firstImage) throw new Error('Expected an active artwork request');
    fireEvent.load(firstImage);

    await waitFor(() => expect(
      view.container.querySelector('img[src="https://images.example.test/movie-7.jpg"]')
    ).not.toBeNull());
    expect(loadingImages()).toHaveLength(6);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(1);

    const errorImage = loadingImages()[0];
    if (!errorImage) throw new Error('Expected another active artwork request');
    fireEvent.error(errorImage);

    await waitFor(() => expect(
      view.container.querySelector('img[src="https://images.example.test/movie-8.jpg"]')
    ).not.toBeNull());
    expect(loadingImages()).toHaveLength(6);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('CardTile title metadata', () => {
  it.each([
    'An Exceptionally Long English Television Title That Must Stay Inside One Poster Column',
    'A Show: Part II — (2026) [Provider Metadata] / Special Edition?!',
    'これは非常に長い日本語のテレビ番組タイトルで隣の列にはみ出してはいけません'
  ])('keeps the exact media name separate from its year for %s', title => {
    const item: PtvItem = {
      id: 'series-long-title',
      name: title,
      productionYear: 2026,
      type: 'Series'
    };
    const view = render(
      <AppProvider>
        <CardTile
          item={item}
          focusId="card-series-long-title"
          meta={String(item.productionYear)}
          onOpen={() => undefined}
        />
      </AppProvider>
    );

    const titleNode = view.container.querySelector('.ptv-card-title');
    const yearNode = view.container.querySelector('.ptv-card-meta');
    expect(titleNode?.textContent).toBe(title);
    expect(yearNode?.textContent).toBe('2026');
    expect(titleNode?.nextElementSibling).toBe(yearNode);
  });
});
