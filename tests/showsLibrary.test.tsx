import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { DiagnosticsService } from '../src/core/diagnostics';
import { RUNTIME_DIAGNOSTICS_ENABLED_KEY } from '../src/core/runtimeDiagnostics';
import { clearHomeCache } from '../src/state/homeCache';
import {
  clearMediaCache,
  createMediaCacheSessionKey,
  readBrowseWindow,
  synchronizeMediaCacheSession,
  writeBrowseWindow
} from '../src/state/mediaCache';
import { defaultStorageState, STORAGE_KEY } from '../src/storage/sessionStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type ItemsResponse = {
  Items: Array<Record<string, unknown>>;
  TotalRecordCount?: number;
};

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  disconnected: boolean;
  instance: TestIntersectionObserver;
  options: IntersectionObserverInit;
  targets: Set<Element>;
};

const mockValidateServer = vi.fn();
const mockValidateSession = vi.fn();
const mockDiscoverCapabilities = vi.fn();
const mockGetResume = vi.fn();
const mockGetNextUp = vi.fn();
const mockGetRecentlyAdded = vi.fn();
const mockGetItems = vi.fn();
const mockGetItem = vi.fn();
const mockGetSimilarItems = vi.fn();
const mockGetSeasons = vi.fn();
const mockGetEpisodes = vi.fn();
const mockSetAccessToken = vi.fn();
const observerRecords: ObserverRecord[] = [];

vi.mock('../src/api/jellyfin/client', () => ({
  JellyfinApiClient: vi.fn((config: { baseUrl: string }) => {
    let baseUrl = config.baseUrl;
    return {
      setAccessToken: (token?: string) => mockSetAccessToken(token),
      setServer: (next: string) => { baseUrl = next; },
      getServerUrl: () => baseUrl,
      validateServer: (...args: unknown[]) => mockValidateServer(...args),
      validateSession: (...args: unknown[]) => mockValidateSession(...args),
      discoverCapabilities: (...args: unknown[]) => mockDiscoverCapabilities(...args),
      getResume: (...args: unknown[]) => mockGetResume(...args),
      getNextUp: (...args: unknown[]) => mockGetNextUp(...args),
      getRecentlyAdded: (...args: unknown[]) => mockGetRecentlyAdded(...args),
      getItems: (...args: unknown[]) => mockGetItems(...args),
      getItem: (...args: unknown[]) => mockGetItem(...args),
      getSimilarItems: (...args: unknown[]) => mockGetSimilarItems(...args),
      getSeasons: (...args: unknown[]) => mockGetSeasons(...args),
      getEpisodes: (...args: unknown[]) => mockGetEpisodes(...args),
      getImageUrl: (itemId: string, imageType: string, tag?: string) =>
        `https://server.example.com/Items/${itemId}/Images/${imageType}?tag=${tag ?? ''}`
    };
  }),
  resolvePlaybackStreamUrl: vi.fn(() => 'https://server.example.com/Videos/item/stream?api_key=redacted'),
  createPlaybackStreamUrl: vi.fn(() => 'https://server.example.com/Videos/item/stream?api_key=redacted')
}));

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: ReadonlyArray<number>;
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold.slice()
      : [options.threshold ?? 0];
    this.record = {
      callback,
      disconnected: false,
      instance: this,
      options,
      targets: new Set()
    };
    observerRecords.push(this.record);
  }

  disconnect() {
    this.record.disconnected = true;
  }

  observe(target: Element) {
    this.record.targets.add(target);
  }

  takeRecords() {
    return [];
  }

  unobserve(target: Element) {
    this.record.targets.delete(target);
  }
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function seriesBatch(start: number, count: number, namePrefix = 'Library Show', idPrefix = 'show') {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return {
      Id: `${idPrefix}-${number}`,
      Name: `${namePrefix} ${number}`,
      Type: 'Series',
      ProductionYear: 2026,
      RecursiveItemCount: 1
    };
  });
}

function seedSession() {
  const now = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...defaultStorageState(),
    servers: [{
      serverId: 'server-demo',
      baseUrl: 'https://server.example.com',
      serverName: 'PiggieTV',
      serverVersion: '10.11.11',
      connectedAt: now
    }],
    session: {
      schemaVersion: 1,
      serverUrl: 'https://server.example.com',
      accessToken: 'stored-token',
      userId: 'user-1',
      userName: 'Stored User',
      deviceId: 'device-1',
      deviceName: 'LG webOS TV',
      applicationVersion: '0.1.0',
      savedAt: now
    },
    lastServerUrl: 'https://server.example.com',
    recentServers: ['https://server.example.com']
  }));
  return now;
}

function installIntersectionObserver() {
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
}

function activeSentinelObserver() {
  return observerRecords.find(record => (
    !record.disconnected
    && record.options.rootMargin === '900px 0px'
    && Array.from(record.targets).some(target => target.classList.contains('ptv-shows-load-status'))
  ));
}

async function intersectNextSentinel(previous?: ObserverRecord) {
  let next: ObserverRecord | undefined;
  await waitFor(() => {
    next = activeSentinelObserver();
    expect(next).toBeDefined();
    if (previous) expect(next).not.toBe(previous);
  });
  if (!next) throw new Error('Shows sentinel observer was not created');
  act(() => { emitIntersection(next as ObserverRecord); });
  return next;
}

function showsCacheKey(updatedAt: number) {
  const cacheKey = createMediaCacheSessionKey('https://server.example.com', {
    serverId: 'server-demo',
    userId: 'user-1',
    updatedAt
  });
  if (!cacheKey) throw new Error('Expected a Shows media-cache key');
  return cacheKey;
}

function emitIntersection(record: ObserverRecord) {
  const target = Array.from(record.targets)[0];
  if (!target) throw new Error('Observer has no target');
  record.callback([{
    isIntersecting: true,
    intersectionRatio: 1,
    target
  } as IntersectionObserverEntry], record.instance);
}

function expectSingleFocusOwner(expected: HTMLElement) {
  const managedOwners = document.querySelectorAll<HTMLElement>('.ptv-focusable.is-focused');
  const allOwners = document.querySelectorAll<HTMLElement>(
    '[data-focus-id].is-focused, [data-focus-id]:focus'
  );
  expect(managedOwners).toHaveLength(1);
  expect(managedOwners[0]).toBe(expected);
  expect(document.activeElement).toBe(expected);
  expect(expected.isConnected).toBe(true);
  expect(allOwners).toHaveLength(1);
  expect(allOwners[0]).toBe(expected);
}

function gridRect(left: number, top: number, width: number, height: number) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}

async function openShows() {
  seedSession();
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Shows' }));
}

beforeEach(() => {
  observerRecords.length = 0;
  localStorage.clear();
  for (const mock of [
    mockValidateServer,
    mockValidateSession,
    mockDiscoverCapabilities,
    mockGetResume,
    mockGetNextUp,
    mockGetRecentlyAdded,
    mockGetItems,
    mockGetItem,
    mockGetSimilarItems,
    mockGetSeasons,
    mockGetEpisodes,
    mockSetAccessToken
  ]) mock.mockReset();

  mockValidateServer.mockResolvedValue({
    ServerId: 'server-demo',
    ServerName: 'PiggieTV',
    Version: '10.11.11'
  });
  mockValidateSession.mockResolvedValue({ Id: 'user-1', Name: 'Stored User' });
  mockDiscoverCapabilities.mockResolvedValue([]);
  mockGetResume.mockResolvedValue({ Items: [] });
  mockGetNextUp.mockResolvedValue({ Items: [] });
  mockGetRecentlyAdded.mockResolvedValue({ Items: [] });
  mockGetSimilarItems.mockResolvedValue({ Items: [] });
  mockGetSeasons.mockResolvedValue({ Items: [] });
  mockGetEpisodes.mockResolvedValue({ Items: [] });
});

afterEach(() => {
  cleanup();
  clearHomeCache();
  clearMediaCache();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ShowsLibraryScreen bounded incremental loading', () => {
  it('requests and renders 24 shows initially without pagination controls', async () => {
    installIntersectionObserver();
    mockGetItems.mockResolvedValueOnce({
      Items: seriesBatch(1, 24),
      TotalRecordCount: 1048
    });

    await openShows();
    await screen.findByRole('button', { name: 'Library Show 24, 2026' });

    expect(mockGetItems).toHaveBeenCalledTimes(1);
    expect(mockGetItems.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      IncludeItemTypes: 'Series',
      StartIndex: 0,
      Limit: 24,
      SortBy: 'DateCreated',
      SortOrder: 'Descending'
    }));
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(24);
    expect(screen.getByText('1,048 titles')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByText(/^Page \d+$/)).toBeNull();

    await waitFor(() => expect(activeSentinelObserver()?.instance.root).toBe(
      document.querySelector('.ptv-browse__viewport')
    ));
  });

  it('appends one guarded batch without moving focus from an existing card', async () => {
    installIntersectionObserver();
    const nextBatch = defer<ItemsResponse>();
    mockGetItems
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24), TotalRecordCount: 48 })
      .mockReturnValueOnce(nextBatch.promise);

    await openShows();
    const focusedCard = await screen.findByRole('button', { name: 'Library Show 20, 2026' });
    act(() => { focusedCard.focus(); });
    expect(document.activeElement).toBe(focusedCard);

    await waitFor(() => expect(activeSentinelObserver()).toBeDefined());
    const sentinelObserver = activeSentinelObserver();
    if (!sentinelObserver) throw new Error('Shows sentinel observer was not created');
    act(() => {
      emitIntersection(sentinelObserver);
      emitIntersection(sentinelObserver);
    });

    await waitFor(() => expect(mockGetItems).toHaveBeenCalledTimes(2));
    expect(mockGetItems.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      StartIndex: 24,
      Limit: 24
    }));
    expect(screen.getByText(/Loading more shows/)).toBeTruthy();
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(24);
    expect(document.activeElement).toBe(focusedCard);

    await act(async () => {
      nextBatch.resolve({ Items: seriesBatch(25, 24), TotalRecordCount: 48 });
      await nextBatch.promise;
    });

    await screen.findByRole('button', { name: 'Library Show 48, 2026' });
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(48);
    expect(screen.queryByText(/Loading more shows/)).toBeNull();
    expect(document.activeElement).toBe(focusedCard);
    expect(mockGetItems).toHaveBeenCalledTimes(2);
  });

  it('does not let a layout-generated mouseenter under a stationary pointer steal remote focus', async () => {
    installIntersectionObserver();
    mockGetItems.mockResolvedValueOnce({
      Items: seriesBatch(1, 24),
      TotalRecordCount: 24
    });

    await openShows();
    const remoteCard = await screen.findByRole('button', { name: 'Library Show 1, 2026' });
    const parkedPointerCard = screen.getByRole('button', { name: 'Library Show 3, 2026' });
    act(() => { remoteCard.focus(); });

    expect(remoteCard.classList.contains('is-focused')).toBe(true);
    fireEvent.mouseEnter(parkedPointerCard, { clientX: 520, clientY: 220 });

    await waitFor(() => {
      expect(remoteCard.classList.contains('is-focused')).toBe(true);
      expect(parkedPointerCard.classList.contains('is-focused')).toBe(false);
      expectSingleFocusOwner(remoteCard);
    });

    fireEvent.mouseMove(parkedPointerCard, { clientX: 519, clientY: 220 });
    expectSingleFocusOwner(remoteCard);
    fireEvent.mouseMove(parkedPointerCard, { clientX: 520, clientY: 220 });
    await waitFor(() => {
      expect(parkedPointerCard.classList.contains('is-focused')).toBe(true);
      expectSingleFocusOwner(parkedPointerCard);
    });

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
    const remoteOwnerAfterDown = document.querySelector<HTMLElement>('.ptv-focusable.is-focused');
    expect(remoteOwnerAfterDown).toBeTruthy();
    fireEvent.mouseEnter(remoteCard, { clientX: 520, clientY: 220 });
    fireEvent.mouseMove(remoteCard, { clientX: 520, clientY: 220 });
    expect(document.querySelector<HTMLElement>('.ptv-focusable.is-focused')).toBe(remoteOwnerAfterDown);
    if (!remoteOwnerAfterDown) throw new Error('Expected a remote focus owner after ArrowDown');
    expectSingleFocusOwner(remoteOwnerAfterDown);

    fireEvent.mouseMove(remoteCard, { clientX: 521, clientY: 220 });
    expectSingleFocusOwner(remoteOwnerAfterDown);
    fireEvent.mouseMove(remoteCard, { clientX: 522, clientY: 220 });
    await waitFor(() => {
      expect(remoteCard.classList.contains('is-focused')).toBe(true);
      expectSingleFocusOwner(remoteCard);
    });

    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp' });
    const remoteOwnerAfterUp = document.querySelector<HTMLElement>('.ptv-focusable.is-focused');
    fireEvent.mouseEnter(parkedPointerCard, { clientX: 522, clientY: 220 });
    expect(document.querySelector<HTMLElement>('.ptv-focusable.is-focused')).toBe(remoteOwnerAfterUp);
    fireEvent.mouseMove(parkedPointerCard, { clientX: 523, clientY: 220 });
    expectSingleFocusOwner(remoteOwnerAfterUp as HTMLElement);
    fireEvent.mouseMove(parkedPointerCard, { clientX: 524, clientY: 220 });
    await waitFor(() => {
      expect(parkedPointerCard.classList.contains('is-focused')).toBe(true);
      expectSingleFocusOwner(parkedPointerCard);
    });
    expect(screen.getByRole('heading', { name: 'Shows' })).toBeTruthy();
  });

  it('keeps 120 loaded shows cached while rendering at most 96 cards and shifting focus safely at 1920px', async () => {
    installIntersectionObserver();
    vi.stubGlobal('innerWidth', 1920);
    localStorage.setItem(RUNTIME_DIAGNOSTICS_ENABLED_KEY, '1');
    const diagnosticSpy = vi.spyOn(DiagnosticsService.prototype, 'recordShowsLibraryEvent');
    const now = 1_725_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cacheKey = showsCacheKey(now);
    mockGetItems.mockImplementation((_userId: string, options: { StartIndex?: number }) => {
      const startIndex = options.StartIndex ?? 0;
      return Promise.resolve({
        Items: seriesBatch(startIndex + 1, 24),
        TotalRecordCount: 120
      });
    });

    await openShows();
    await screen.findByRole('button', { name: 'Library Show 24, 2026' });

    let previousObserver: ObserverRecord | undefined;
    for (const expectedItemCount of [48, 72, 96, 120]) {
      previousObserver = await intersectNextSentinel(previousObserver);
      await waitFor(() => expect(
        readBrowseWindow(cacheKey, 'shows', 'recent')?.items
      ).toHaveLength(expectedItemCount));
    }

    expect(mockGetItems.mock.calls.map(call => (
      call[1] as { StartIndex: number }
    ).StartIndex)).toEqual([0, 24, 48, 72, 96]);
    expect(await screen.findByText('All 120 shows loaded')).toBeTruthy();
    expect(readBrowseWindow(cacheKey, 'shows', 'recent')).toMatchObject({
      hasMore: false,
      nextStartIndex: 120,
      totalRecordCount: 120,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'show-1' }),
        expect.objectContaining({ id: 'show-120' })
      ])
    });
    expect(readBrowseWindow(cacheKey, 'shows', 'recent')?.items).toHaveLength(120);
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(96);

    const focusedCard = screen.getByRole('button', { name: 'Library Show 96, 2026' });
    const focusId = focusedCard.getAttribute('data-focus-id');
    act(() => { focusedCard.focus(); });

    await waitFor(() => {
      expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(96);
      expect(screen.queryByRole('button', { name: 'Library Show 1, 2026' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Library Show 120, 2026' })).toBeTruthy();
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe(focusId);
    });
    await waitFor(() => expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'render-window-change',
      metadataCount: 120,
      renderWindowStart: 24,
      renderWindowEnd: 120,
      renderedCardCount: 96,
      currentColumns: 8,
      focusedItemId: 'show-96',
      focusedIndex: 95,
      topSpacerHeight: 1_056
    })));
    expect(readBrowseWindow(cacheKey, 'shows', 'recent')?.items).toHaveLength(120);
    expect(mockGetItems).toHaveBeenCalledTimes(5);
  });

  it('reconciles rendered native displacement on retained deep Shows cards', async () => {
    installIntersectionObserver();
    vi.stubGlobal('innerWidth', 1920);
    localStorage.setItem(RUNTIME_DIAGNOSTICS_ENABLED_KEY, '1');
    const heartbeatSpy = vi.spyOn(DiagnosticsService.prototype, 'recordRuntimeHeartbeat');
    const sessionTimestamp = seedSession();
    vi.spyOn(Date, 'now').mockReturnValue(sessionTimestamp);
    const cacheKey = showsCacheKey(sessionTimestamp);
    const cachedWindow = {
      screen: 'shows',
      filter: 'recent',
      items: Array.from({ length: 600 }, (_, index) => ({
        id: `show-${index + 1}`,
        name: `Library Show ${index + 1}`,
        type: 'Series' as const,
        productionYear: 2026,
        recursiveItemCount: 1
      })),
      nextStartIndex: 600,
      totalRecordCount: 600,
      hasMore: false,
      focusedItemId: 'show-569'
    } as const;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('ptv-browse__viewport')) {
        return gridRect(48, 190, 1824, 820);
      }
      const focusId = this.getAttribute('data-focus-id') ?? '';
      const itemNumber = Number(focusId.match(/^browse-shows-show-(\d+)$/)?.[1] ?? 0);
      if (itemNumber > 0) {
        const viewport = document.querySelector<HTMLElement>('.ptv-browse__viewport');
        const index = itemNumber - 1;
        return gridRect(
          64 + (index % 8) * 216,
          220 + Math.floor(index / 8) * 352 - (viewport?.scrollTop ?? 0),
          180,
          322
        );
      }
      return gridRect(0, 0, 180, 60);
    });

    render(<App />);
    const showsNavigation = await screen.findByRole('button', { name: 'Shows' });
    // Startup intentionally clears cache state while the saved session is
    // being restored. Seed this deep deterministic window only after restore.
    synchronizeMediaCacheSession(cacheKey);
    expect(writeBrowseWindow(cacheKey, cachedWindow)).toBe(true);
    fireEvent.click(showsNavigation);
    const viewport = await waitFor(() => {
      const candidate = document.querySelector<HTMLDivElement>('.ptv-browse__viewport');
      expect(candidate).toBeTruthy();
      return candidate as HTMLDivElement;
    });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 820 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 26_400 });
    await screen.findByText('All 600 shows loaded');
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(96);

    const liveWindowStart = () => {
      const spacer = document.querySelector<HTMLElement>(
        '.ptv-browse__viewport > .ptv-shows-window-spacer'
      );
      return spacer ? Math.round(Number.parseInt(spacer.style.height, 10) / 352) * 8 : 0;
    };
    await act(async () => {
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    viewport.scrollTop = 24_542;
    fireEvent.scroll(viewport);
    await waitFor(() => expect({
      start: liveWindowStart(),
      owner: document.querySelector<HTMLElement>('.ptv-focusable.is-focused')?.dataset.focusId ?? null
    }).toEqual({ start: 504, owner: 'browse-shows-show-569' }));
    const source = await screen.findByRole('button', { name: 'Library Show 569, 2026' });
    const targetBefore = screen.getByRole('button', { name: 'Library Show 577, 2026' });

    fireEvent.mouseDown(source, { clientX: 100, clientY: 100 });
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.scroll(viewport);

    await waitFor(() => {
      const target = screen.getByRole('button', { name: 'Library Show 577, 2026' });
      expect(target).toBe(targetBefore);
      expectSingleFocusOwner(target);
    });
    expect(heartbeatSpy).toHaveBeenCalledWith(expect.objectContaining({
      currentFocusId: 'browse-shows-show-577',
      focusedIndex: 576,
      renderedCardCount: 96,
      scrollTop: expect.any(Number)
    }));

    // Reproduce the observed one-owner filter signature without pretending the
    // retained card was unregistered. A native focus displacement fires the
    // filter's onFocus path; remote reconciliation must restore card 576.
    const filter = screen.getByRole('button', { name: 'Recently Added' });
    act(() => { filter.focus(); });
    await waitFor(() => {
      expectSingleFocusOwner(targetBefore);
      expect(filter.classList.contains('is-focused')).toBe(false);
    });
    expect(mockGetItems).not.toHaveBeenCalled();
  });

  it('preserves exact remote columns while appends and pruning move several windows beneath a parked pointer', async () => {
    installIntersectionObserver();
    vi.stubGlobal('innerWidth', 1920);
    localStorage.setItem(RUNTIME_DIAGNOSTICS_ENABLED_KEY, '1');
    const diagnosticSpy = vi.spyOn(DiagnosticsService.prototype, 'recordShowsLibraryEvent');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      const focusId = this.getAttribute('data-focus-id') ?? '';
      const itemNumber = Number(focusId.match(/^browse-shows-show-(\d+)$/)?.[1] ?? 0);
      if (itemNumber > 0) {
        const index = itemNumber - 1;
        return gridRect(64 + (index % 8) * 216, 220 + Math.floor(index / 8) * 352, 180, 322);
      }
      if (this.classList.contains('ptv-browse__viewport')) {
        return gridRect(48, 190, 1824, 820);
      }
      return gridRect(0, 0, 1, 1);
    });
    mockGetItems.mockImplementation((_userId: string, options: { StartIndex?: number }) => {
      const startIndex = options.StartIndex ?? 0;
      return Promise.resolve({
        Items: seriesBatch(startIndex + 1, Math.min(24, 216 - startIndex)),
        TotalRecordCount: 216
      });
    });

    await openShows();
    await screen.findByRole('button', { name: 'Library Show 24, 2026' });
    let previousObserver: ObserverRecord | undefined;
    for (const expectedCount of [48, 72, 96, 120]) {
      previousObserver = await intersectNextSentinel(previousObserver);
      await waitFor(() => expect(mockGetItems).toHaveBeenCalledTimes(expectedCount / 24));
    }

    const topSpacerHeights = new Set<number>();
    const domRenderWindowStarts = new Set<number>([0]);
    const recordLiveWindow = async () => {
      await act(async () => {
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      const topSpacer = document.querySelector<HTMLElement>(
        '.ptv-browse__viewport > .ptv-shows-window-spacer'
      );
      const height = topSpacer ? Number.parseInt(topSpacer.style.height, 10) : 0;
      topSpacerHeights.add(height);
      domRenderWindowStarts.add(Math.round(height / 352) * 8);
    };
    let pointerParked = false;
    let activationJumpX = 542;
    const runRemoteCycle = async (anchor: number) => {
      const anchorCard = await screen.findByRole('button', { name: `Library Show ${anchor}, 2026` });
      fireEvent.mouseDown(anchorCard, { clientX: 154, clientY: 310 });
      await waitFor(() => expectSingleFocusOwner(anchorCard));
      // A reversible DPAD pair returns ownership to remote and preserves the
      // first-motion baseline contract without relying on test-only focus.
      fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
      await waitFor(() => expectSingleFocusOwner(screen.getByRole('button', {
        name: `Library Show ${anchor + 8}, 2026`
      })));
      fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp' });
      await waitFor(() => expectSingleFocusOwner(anchorCard));

      if (!pointerParked) {
        const pointerCard = screen.getByRole('button', { name: `Library Show ${anchor + 2}, 2026` });
        fireEvent.mouseMove(pointerCard, { clientX: 540, clientY: 310 });
        expectSingleFocusOwner(anchorCard);
        fireEvent.mouseMove(pointerCard, { clientX: 544, clientY: 310 });
        await waitFor(() => expectSingleFocusOwner(pointerCard));
        fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft' });
        await waitFor(() => expectSingleFocusOwner(
          screen.getByRole('button', { name: `Library Show ${anchor + 1}, 2026` })
        ));
        fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft' });
        await waitFor(() => expectSingleFocusOwner(anchorCard));
        pointerParked = true;
      }

      const steps: Array<[string, number, number]> = [
        ['ArrowDown', anchor + 8, 0],
        ['ArrowDown', anchor + 16, 0],
        ['ArrowRight', anchor + 17, 1],
        ['ArrowLeft', anchor + 16, 0],
        ['ArrowUp', anchor + 8, 0],
        ['ArrowUp', anchor, 0]
      ];
      for (const [key, expectedItemNumber, expectedColumn] of steps) {
        fireEvent.keyDown(window, { key, code: key });
        const expectedCard = await screen.findByRole('button', {
          name: `Library Show ${expectedItemNumber}, 2026`
        });
        await waitFor(() => {
          expectSingleFocusOwner(expectedCard);
          expect((expectedItemNumber - 1) % 8).toBe(expectedColumn);
        });
        await recordLiveWindow();

        const rowFirstItem = expectedItemNumber - ((expectedItemNumber - 1) % 8);
        const parkedPointerCard = screen.getByRole('button', {
          name: `Library Show ${rowFirstItem + 2}, 2026`
        });
        fireEvent.mouseEnter(parkedPointerCard, { clientX: 544, clientY: 310 });
        fireEvent.mouseMove(parkedPointerCard, { clientX: activationJumpX, clientY: 310 });
        activationJumpX = activationJumpX === 542 ? 544 : 542;
        expectSingleFocusOwner(expectedCard);
        expect(screen.getByRole('heading', { name: 'Shows' })).toBeTruthy();

      }
    };

    const appendWhilePointerIsParked = async (
      expectedRequestCount: number,
      currentOwnerNumber: number,
      newColumnTwoNumber: number
    ) => {
      const currentOwner = screen.getByRole('button', {
        name: `Library Show ${currentOwnerNumber}, 2026`
      });
      expectSingleFocusOwner(currentOwner);
      previousObserver = await intersectNextSentinel(previousObserver);
      await waitFor(() => expect(mockGetItems).toHaveBeenCalledTimes(expectedRequestCount));
      const cardMovedUnderPointer = await screen.findByRole('button', {
        name: `Library Show ${newColumnTwoNumber}, 2026`
      });
      fireEvent.mouseEnter(cardMovedUnderPointer, { clientX: 544, clientY: 310 });
      expectSingleFocusOwner(currentOwner);
      await recordLiveWindow();
    };

    await runRemoteCycle(89);
    await appendWhilePointerIsParked(6, 89, 123);
    await runRemoteCycle(113);
    await appendWhilePointerIsParked(7, 113, 147);
    await runRemoteCycle(137);
    await appendWhilePointerIsParked(8, 137, 171);
    await runRemoteCycle(161);
    await appendWhilePointerIsParked(9, 161, 195);
    await screen.findByText('All 216 shows loaded');
    await runRemoteCycle(185);

    const renderWindowStarts = new Set<number>();
    for (const [event] of diagnosticSpy.mock.calls) {
      if (event.type === 'render-window-change') renderWindowStarts.add(event.renderWindowStart);
    }
    expect(domRenderWindowStarts.size).toBeGreaterThanOrEqual(6);
    expect(renderWindowStarts.size).toBeGreaterThanOrEqual(6);
    expect(topSpacerHeights.size).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole('button', { name: 'Library Show 1, 2026' })).toBeNull();
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn').length).toBeLessThanOrEqual(96);
    expect(mockGetItems.mock.calls.map(call => (
      call[1] as { StartIndex: number }
    ).StartIndex)).toEqual([0, 24, 48, 72, 96, 120, 144, 168, 192]);
  }, 15_000);

  it('stops observing and reports completion after the final batch', async () => {
    installIntersectionObserver();
    mockGetItems
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24), TotalRecordCount: 25 })
      .mockResolvedValueOnce({ Items: seriesBatch(25, 1), TotalRecordCount: 25 });

    await openShows();
    await screen.findByRole('button', { name: 'Library Show 24, 2026' });
    await waitFor(() => expect(activeSentinelObserver()).toBeDefined());
    const sentinelObserver = activeSentinelObserver();
    if (!sentinelObserver) throw new Error('Shows sentinel observer was not created');

    act(() => { emitIntersection(sentinelObserver); });

    expect(await screen.findByText('All 25 shows loaded')).toBeTruthy();
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(25);
    expect(sentinelObserver.disconnected).toBe(true);

    act(() => { emitIntersection(sentinelObserver); });
    await act(async () => { await Promise.resolve(); });
    expect(mockGetItems).toHaveBeenCalledTimes(2);
  });

  it('resets to index zero for A-Z and ignores a stale prior-filter response', async () => {
    installIntersectionObserver();
    const staleRecentBatch = defer<ItemsResponse>();
    mockGetItems
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24, 'Recent Show', 'recent'), TotalRecordCount: 48 })
      .mockReturnValueOnce(staleRecentBatch.promise)
      .mockResolvedValueOnce({ Items: seriesBatch(1, 2, 'Alpha Show', 'alpha'), TotalRecordCount: 2 });

    await openShows();
    await screen.findByRole('button', { name: 'Recent Show 24, 2026' });
    await waitFor(() => expect(activeSentinelObserver()).toBeDefined());
    const sentinelObserver = activeSentinelObserver();
    if (!sentinelObserver) throw new Error('Shows sentinel observer was not created');
    act(() => { emitIntersection(sentinelObserver); });
    await waitFor(() => expect(mockGetItems).toHaveBeenCalledTimes(2));

    const azFilter = screen.getByRole('button', { name: /A.*Z/ });
    fireEvent.click(azFilter);

    await screen.findByRole('button', { name: 'Alpha Show 2, 2026' });
    expect(mockGetItems).toHaveBeenCalledTimes(3);
    expect(mockGetItems.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      StartIndex: 0,
      Limit: 24,
      SortBy: 'SortName',
      SortOrder: 'Ascending'
    }));
    expect((mockGetItems.mock.calls[1]?.[2] as AbortSignal | undefined)?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Recent Show 1, 2026' })).toBeNull();
    expect(document.activeElement).toBe(azFilter);

    await act(async () => {
      staleRecentBatch.resolve({ Items: seriesBatch(25, 24, 'Stale Show', 'stale'), TotalRecordCount: 48 });
      await staleRecentBatch.promise;
    });
    expect(screen.queryByRole('button', { name: 'Stale Show 25, 2026' })).toBeNull();
    expect(document.activeElement).toBe(azFilter);
  });

  it('offers a manual load-more fallback when IntersectionObserver is unavailable', async () => {
    Reflect.deleteProperty(window, 'IntersectionObserver');
    mockGetItems
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24), TotalRecordCount: 48 })
      .mockResolvedValueOnce({ Items: seriesBatch(25, 24), TotalRecordCount: 48 });

    await openShows();
    await screen.findByRole('button', { name: 'Library Show 24, 2026' });
    expect(mockGetItems).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load more shows' }));

    await screen.findByRole('button', { name: 'Library Show 48, 2026' });
    expect(mockGetItems.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      StartIndex: 24,
      Limit: 24
    }));
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(48);
    expect(screen.getByText('All 48 shows loaded')).toBeTruthy();
  });

  it('restores a deep A-Z card focus after opening Details and returning Back', async () => {
    installIntersectionObserver();
    vi.stubGlobal('innerWidth', 1920);
    const now = 1_725_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cacheKey = showsCacheKey(now);
    mockGetItems
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24, 'Recent Show', 'recent'), TotalRecordCount: 24 })
      .mockResolvedValueOnce({ Items: seriesBatch(1, 24, 'Alphabet Show', 'az'), TotalRecordCount: 120 })
      .mockResolvedValueOnce({ Items: seriesBatch(25, 24, 'Alphabet Show', 'az'), TotalRecordCount: 120 })
      .mockResolvedValueOnce({ Items: seriesBatch(49, 24, 'Alphabet Show', 'az'), TotalRecordCount: 120 })
      .mockResolvedValueOnce({ Items: seriesBatch(73, 24, 'Alphabet Show', 'az'), TotalRecordCount: 120 })
      .mockResolvedValueOnce({ Items: seriesBatch(97, 24, 'Alphabet Show', 'az'), TotalRecordCount: 120 });
    mockGetItem.mockResolvedValue({
      Id: 'az-112',
      Name: 'Alphabet Show 112',
      Type: 'Series',
      ProductionYear: 2026,
      Overview: 'Deep A-Z series details.',
      RecursiveItemCount: 1
    });
    const focusCalls: string[] = [];
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focus(options?: FocusOptions) {
      focusCalls.push(this.getAttribute('data-focus-id') ?? this.tagName.toLowerCase());
      nativeFocus.call(this, options);
    });

    await openShows();
    await screen.findByRole('button', { name: 'Recent Show 24, 2026' });
    fireEvent.click(screen.getByRole('button', { name: /A.*Z/ }));
    await screen.findByRole('button', { name: 'Alphabet Show 24, 2026' });
    let previousObserver: ObserverRecord | undefined;
    for (const expectedItemCount of [48, 72, 96, 120]) {
      previousObserver = await intersectNextSentinel(previousObserver);
      await waitFor(() => expect(
        readBrowseWindow(cacheKey, 'shows', 'az')?.items
      ).toHaveLength(expectedItemCount));
    }

    expect(await screen.findByText('All 120 shows loaded')).toBeTruthy();
    const shiftCard = screen.getByRole('button', { name: 'Alphabet Show 96, 2026' });
    act(() => { shiftCard.focus(); });
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Alphabet Show 112, 2026' })
    ).toBeTruthy());

    const deepCard = screen.getByRole('button', { name: 'Alphabet Show 112, 2026' });
    act(() => { deepCard.focus(); });
    expect(document.activeElement).toBe(deepCard);
    fireEvent.click(deepCard);

    await screen.findByText('Deep A-Z series details.');
    const backButton = screen.getByRole('button', { name: 'Back' });
    fireEvent.mouseEnter(backButton);
    fireEvent.click(backButton);

    const restoredCard = await screen.findByRole('button', { name: 'Alphabet Show 112, 2026' });
    expect(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn')).toHaveLength(96);
    expect(readBrowseWindow(cacheKey, 'shows', 'az')?.items).toHaveLength(120);
    expect(mockGetItems).toHaveBeenCalledTimes(6);
    await waitFor(() => {
      const activeFocusId = document.activeElement?.getAttribute('data-focus-id');
      expect(
        activeFocusId,
        `focus calls: ${focusCalls.slice(-8).join(' -> ')}`
      ).toBe(restoredCard.getAttribute('data-focus-id'));
    });
    expect(focusCalls.at(-1)).toBe('browse-shows-az-112');
  });
});
