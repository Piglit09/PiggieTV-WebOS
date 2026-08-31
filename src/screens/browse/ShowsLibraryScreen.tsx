import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { CardTile } from '../../components/CardTile';
import { FocusableButton } from '../../components/FocusableButton';
import { buildRoute, toRouteString } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { artworkUrlForItem } from '../../utils/artwork';
import { ArtworkLoadScheduler } from '../../utils/artworkLoadScheduler';
import { redactSensitiveText } from '../../core/redaction';
import {
  clearBrowseWindows,
  createMediaCacheSessionKey,
  readBrowseWindow,
  readRememberedBrowseLocation,
  rememberBrowseLocation,
  writeBrowseWindow,
  type MediaBrowseFilter
} from '../../state/mediaCache';
import type { PtvItem } from '../../types/ptv';
import {
  calculateShowsRenderWindow,
  centeredShowsWindowStartRow,
  guardedShowsWindowStartRow,
  showsGridGeometryForWidth
} from './showsRenderWindow';

const SHOWS_BATCH_SIZE = 24;
const SHOWS_PREFETCH_MARGIN = '900px 0px';
const SHOWS_ARTWORK_PREFETCH_MARGIN = '720px 0px';
const SHOWS_MAX_CONCURRENT_ARTWORK_LOADS = 6;

const SHOW_FILTERS: ReadonlyArray<{ id: MediaBrowseFilter; label: string }> = [
  { id: 'recent', label: 'Recently Added' },
  { id: 'az', label: 'A–Z' },
  { id: 'favorites', label: 'Favorites' }
];

interface LoadRequest {
  filter: MediaBrowseFilter;
  generation: number;
  id: number;
  replace: boolean;
  startIndex: number;
}

interface InitialShowsSnapshot {
  filter: MediaBrowseFilter;
  request: LoadRequest | null;
  window: ReturnType<typeof readBrowseWindow>;
}

function appendUniqueItems(current: PtvItem[], incoming: PtvItem[]) {
  const seen = new Set(current.map(item => item.id));
  const combined = current.slice();
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    combined.push(item);
  }
  return combined;
}

function formatCount(value: number) {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rawItemCount(response: { Items?: unknown[] }) {
  return Array.isArray(response.Items) ? response.Items.length : 0;
}

function revealFocusedCard(viewport: HTMLDivElement | null, target: HTMLElement) {
  if (!viewport) return;
  const viewportBounds = viewport.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  const revealPadding = 18;
  let nextScrollTop = viewport.scrollTop;

  if (targetBounds.top < viewportBounds.top + revealPadding) {
    nextScrollTop -= viewportBounds.top + revealPadding - targetBounds.top;
  } else if (targetBounds.bottom > viewportBounds.bottom - revealPadding) {
    nextScrollTop += targetBounds.bottom - (viewportBounds.bottom - revealPadding);
  }

  if (nextScrollTop === viewport.scrollTop) return;
  const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTop = Math.max(0, Math.min(maximumScrollTop, nextScrollTop));
}

export function ShowsLibraryScreen() {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const [initialSnapshot] = useState<InitialShowsSnapshot>(() => {
    const remembered = readRememberedBrowseLocation(cacheKey, 'shows');
    const initialFilter = remembered?.filter ?? 'recent';
    const initialWindow = readBrowseWindow(cacheKey, 'shows', initialFilter);
    return {
      filter: initialFilter,
      request: initialWindow || !cacheKey || !userSession
        ? null
        : { filter: initialFilter, generation: 0, id: 0, replace: true, startIndex: 0 },
      window: initialWindow
    };
  });
  const [filter, setFilter] = useState<MediaBrowseFilter>(initialSnapshot.filter);
  const [items, setItems] = useState<PtvItem[]>(initialSnapshot.window?.items ?? []);
  const [nextStartIndex, setNextStartIndex] = useState(initialSnapshot.window?.nextStartIndex ?? 0);
  const [total, setTotal] = useState<number | null>(initialSnapshot.window?.totalRecordCount ?? null);
  const [hasMore, setHasMore] = useState(initialSnapshot.window?.hasMore ?? true);
  const [request, setRequest] = useState<LoadRequest | null>(initialSnapshot.request);
  const [error, setError] = useState<string | null>(null);
  const [observerFailed, setObserverFailed] = useState(false);
  const [manualLoaderMode, setManualLoaderMode] = useState(false);
  const [focusCommitEpoch, setFocusCommitEpoch] = useState(0);
  const [gridGeometry, setGridGeometry] = useState(() => showsGridGeometryForWidth(
    typeof window === 'undefined' ? 1920 : window.innerWidth
  ));
  const [windowStartRow, setWindowStartRow] = useState(() => {
    const initialItems = initialSnapshot.window?.items ?? [];
    const focusedItemId = initialSnapshot.window?.focusedItemId;
    const focusedIndex = focusedItemId
      ? initialItems.findIndex(item => item.id === focusedItemId)
      : -1;
    return focusedIndex >= 0
      ? centeredShowsWindowStartRow(initialItems.length, gridGeometry.columns, focusedIndex)
      : 0;
  });
  const viewportRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollWindowFrameRef = useRef<number | null>(null);
  const scrollItemsRef = useRef(items);
  const scrollFilterRef = useRef(filter);
  const scrollFocusIndexRef = useRef<Map<string, number>>(new Map());
  const scrollGeometryRef = useRef(gridGeometry);
  const scrollRenderWindowRef = useRef<ReturnType<typeof calculateShowsRenderWindow> | null>(null);
  const scrollRouteIdRef = useRef(toRouteString(state.route));
  const restoreItemIdRef = useRef(initialSnapshot.window?.focusedItemId ?? null);
  const generationRef = useRef(0);
  const nextRequestIdRef = useRef(1);
  const activeRequestIdRef = useRef(initialSnapshot.request?.id ?? null);
  const initialLoadQueuedRef = useRef(Boolean(initialSnapshot.window || initialSnapshot.request));
  const loadingRef = useRef(Boolean(initialSnapshot.request));
  const hasMoreRef = useRef(hasMore);
  const gridColumnsRef = useRef(gridGeometry.columns);
  gridColumnsRef.current = gridGeometry.columns;
  const artworkLoadScheduler = React.useMemo(
    () => new ArtworkLoadScheduler(SHOWS_MAX_CONCURRENT_ARTWORK_LOADS),
    []
  );

  const client = React.useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.getAuthenticatedClient();
  }, [state.serverUrl, userSession, services.jellyfin]);

  const supportsAutomaticLoading = typeof window !== 'undefined'
    && 'IntersectionObserver' in window
    && typeof window.IntersectionObserver === 'function';
  const automaticLoadingAvailable = supportsAutomaticLoading && !observerFailed;
  const loading = request !== null;
  const focusIndexById = React.useMemo(() => {
    const indexById = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
      indexById.set(`browse-shows-${items[index]?.id}`, index);
    }
    return indexById;
  }, [items]);
  const requestedRenderWindow = calculateShowsRenderWindow(items.length, gridGeometry, windowStartRow);
  const activeFocusIndex = services.focusManager.focusId
    ? focusIndexById.get(services.focusManager.focusId)
    : undefined;
  const activeFocusWouldBePruned = activeFocusIndex !== undefined && (
    activeFocusIndex < requestedRenderWindow.startIndex
    || activeFocusIndex >= requestedRenderWindow.endIndex
  );
  const renderWindow = activeFocusWouldBePruned
    ? calculateShowsRenderWindow(
      items.length,
      gridGeometry,
      centeredShowsWindowStartRow(items.length, gridGeometry.columns, activeFocusIndex)
    )
    : requestedRenderWindow;
  const renderedItems = items.slice(renderWindow.startIndex, renderWindow.endIndex);
  const diagnosticStateRef = useRef({
    artworkActive: artworkLoadScheduler.activeCount,
    artworkQueued: artworkLoadScheduler.pendingCount,
    focusedIndex: activeFocusIndex ?? null,
    focusedItemId: activeFocusIndex === undefined ? null : items[activeFocusIndex]?.id ?? null,
    hasMore,
    loadingNextBatch: loading
  });
  diagnosticStateRef.current = {
    artworkActive: artworkLoadScheduler.activeCount,
    artworkQueued: artworkLoadScheduler.pendingCount,
    focusedIndex: activeFocusIndex ?? null,
    focusedItemId: activeFocusIndex === undefined ? null : items[activeFocusIndex]?.id ?? null,
    hasMore,
    loadingNextBatch: loading
  };
  scrollItemsRef.current = items;
  scrollFilterRef.current = filter;
  scrollFocusIndexRef.current = focusIndexById;
  scrollGeometryRef.current = gridGeometry;
  scrollRenderWindowRef.current = renderWindow;
  scrollRouteIdRef.current = toRouteString(state.route);

  const keepFocusedItemBuffered = useCallback((focusId: string, forceCenter = false) => {
    const itemIndex = focusIndexById.get(focusId);
    if (itemIndex === undefined) return;
    setWindowStartRow(current => forceCenter
      ? centeredShowsWindowStartRow(items.length, gridGeometry.columns, itemIndex)
      : guardedShowsWindowStartRow(items.length, gridGeometry.columns, current, itemIndex));
  }, [focusIndexById, gridGeometry.columns, items.length]);

  const updateWindowForScroll = useCallback(() => {
    if (scrollWindowFrameRef.current !== null) return;
    scrollWindowFrameRef.current = window.requestAnimationFrame(() => {
      scrollWindowFrameRef.current = null;
      const viewport = viewportRef.current;
      const currentItems = scrollItemsRef.current;
      const currentGeometry = scrollGeometryRef.current;
      const currentRenderWindow = scrollRenderWindowRef.current;
      if (!viewport || !currentRenderWindow || currentItems.length === 0) return;

      const firstVisibleRow = Math.max(
        0,
        Math.floor(Math.max(0, viewport.scrollTop - 16) / currentGeometry.rowPitch)
      );
      const targetIndex = Math.min(currentItems.length - 1, firstVisibleRow * currentGeometry.columns);
      const desiredStartRow = centeredShowsWindowStartRow(
        currentItems.length,
        currentGeometry.columns,
        targetIndex
      );
      if (desiredStartRow === currentRenderWindow.startRow) return;

      const proposedWindow = calculateShowsRenderWindow(currentItems.length, currentGeometry, desiredStartRow);
      const focusId = services.focusManager.focusId;
      const focusedIndex = focusId ? scrollFocusIndexRef.current.get(focusId) : undefined;
      const focusedItemWouldBePruned = focusedIndex !== undefined && (
        focusedIndex < proposedWindow.startIndex
        || focusedIndex >= proposedWindow.endIndex
      );

      if (focusedItemWouldBePruned && focusId) {
        const focusedNode = document.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`);
        const viewportBounds = viewport.getBoundingClientRect();
        const focusedBounds = focusedNode?.getBoundingClientRect();
        const focusedItemIsVisible = Boolean(focusedBounds) && (
          (focusedBounds?.bottom ?? 0) > viewportBounds.top
          && (focusedBounds?.top ?? 0) < viewportBounds.bottom
        );
        if (focusedItemIsVisible) return;

        const targetItem = currentItems[targetIndex];
        if (targetItem) {
          services.focusManager.focus(`browse-filter-${scrollFilterRef.current}`, {
            routeId: scrollRouteIdRef.current,
            reason: 'direct'
          });
          restoreItemIdRef.current = targetItem.id;
        }
      }

      setWindowStartRow(desiredStartRow);
    });
  }, [services.focusManager]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => services.focusManager.subscribeTransitions(transition => {
    if (
      transition.routeId === toRouteString(state.route)
      && (transition.reason === 'directional' || transition.reason === 'directional-fallback')
    ) {
      setFocusCommitEpoch(current => current + 1);
    }
  }), [services.focusManager, state.route]);

  useEffect(() => () => {
    artworkLoadScheduler.clear();
    if (scrollWindowFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollWindowFrameRef.current);
      scrollWindowFrameRef.current = null;
    }
  }, [artworkLoadScheduler]);

  useEffect(() => {
    const syncGeometry = () => {
      const next = showsGridGeometryForWidth(window.innerWidth);
      setGridGeometry(current => (
        current.columns === next.columns && current.rowPitch === next.rowPitch
          ? current
          : next
      ));
    };
    window.addEventListener('resize', syncGeometry);
    return () => window.removeEventListener('resize', syncGeometry);
  }, []);

  useEffect(() => {
    const focusId = services.focusManager.focusId;
    if (focusId && focusIndexById.has(focusId)) {
      keepFocusedItemBuffered(focusId, true);
      const frame = window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`);
        if (target) revealFocusedCard(viewportRef.current, target);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    setWindowStartRow(current => calculateShowsRenderWindow(
      items.length,
      gridGeometry,
      current
    ).startRow);
    return undefined;
  }, [gridGeometry, focusIndexById, items.length, keepFocusedItemBuffered, services.focusManager]);

  useEffect(() => {
    const focusId = services.focusManager.focusId;
    if (focusId) keepFocusedItemBuffered(focusId);
  }, [items.length, keepFocusedItemBuffered, services.focusManager]);

  useEffect(() => {
    if (
      initialLoadQueuedRef.current
      || request
      || !client
      || !userSession
      || !cacheKey
      || items.length
      || nextStartIndex > 0
    ) return;
    initialLoadQueuedRef.current = true;
    const id = nextRequestIdRef.current;
    nextRequestIdRef.current += 1;
    activeRequestIdRef.current = id;
    loadingRef.current = true;
    setRequest({ filter, generation: generationRef.current, id, replace: true, startIndex: 0 });
  }, [cacheKey, client, filter, items.length, nextStartIndex, request, userSession]);

  useEffect(() => {
    if (!request || !client || !userSession || !cacheKey) return undefined;
    const controller = new AbortController();
    setError(null);

    void client.getItems(userSession.userId, {
      IncludeItemTypes: 'Series',
      Recursive: true,
      StartIndex: request.startIndex,
      Limit: SHOWS_BATCH_SIZE,
      SortBy: request.filter === 'recent' ? 'DateCreated' : 'SortName',
      SortOrder: request.filter === 'recent' ? 'Descending' : 'Ascending',
      Filters: request.filter === 'favorites' ? 'IsFavorite' : undefined,
      Fields: 'ImageTags,BackdropImageTags,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres,UserData,ChildCount,RecursiveItemCount',
      EnableUserData: true,
      EnableTotalRecordCount: true
    }, controller.signal)
      .then(response => {
        if (
          controller.signal.aborted
          || generationRef.current !== request.generation
          || activeRequestIdRef.current !== request.id
        ) return;

        const mapped = mapPtvItems(response);
        const sourceCount = rawItemCount(response);
        const resolvedTotal = typeof response.TotalRecordCount === 'number'
          ? response.TotalRecordCount
          : total;
        const resolvedNextStartIndex = request.startIndex + sourceCount;
        const resolvedHasMore = sourceCount > 0 && (
          resolvedTotal !== null
            ? resolvedNextStartIndex < resolvedTotal
            : sourceCount === SHOWS_BATCH_SIZE
        );
        const resolvedItems = request.replace ? appendUniqueItems([], mapped) : appendUniqueItems(items, mapped);

        if (
          !resolvedHasMore
          && services.focusManager.focusId === 'browse-shows-load-more'
          && resolvedItems.length > 0
        ) {
          const finalItem = resolvedItems[resolvedItems.length - 1];
          if (finalItem) {
            restoreItemIdRef.current = finalItem.id;
            setWindowStartRow(centeredShowsWindowStartRow(
              resolvedItems.length,
              gridColumnsRef.current,
              resolvedItems.length - 1
            ));
          }
        }

        setItems(resolvedItems);
        setNextStartIndex(resolvedNextStartIndex);
        setTotal(resolvedTotal);
        setHasMore(resolvedHasMore);
        writeBrowseWindow(cacheKey, {
          screen: 'shows',
          filter: request.filter,
          items: resolvedItems,
          nextStartIndex: resolvedNextStartIndex,
          totalRecordCount: resolvedTotal ?? undefined,
          hasMore: resolvedHasMore
        });
        rememberBrowseLocation(cacheKey, 'shows', { filter: request.filter, page: 0 });
        loadingRef.current = false;
        activeRequestIdRef.current = null;
        setRequest(current => current?.id === request.id ? null : current);
      })
      .catch(cause => {
        if (
          controller.signal.aborted
          || generationRef.current !== request.generation
          || activeRequestIdRef.current !== request.id
        ) return;
        loadingRef.current = false;
        activeRequestIdRef.current = null;
        setError(redactSensitiveText(cause instanceof Error ? cause.message : 'This library view could not be loaded.'));
        setRequest(current => current?.id === request.id ? null : current);
      });

    return () => controller.abort('shows-library-request-replaced');
  }, [cacheKey, client, items, request, services.focusManager, total, userSession]);

  useEffect(() => {
    if (loading || nextStartIndex === 0) return;
    const routeId = toRouteString(state.route);
    const rememberedFocus = services.focusManager.getRememberedRouteFocus(routeId);
    if (!rememberedFocus?.startsWith('browse-shows-')) return;
    if (items.some(item => `browse-shows-${item.id}` === rememberedFocus)) return;
    services.focusManager.restoreRouteFocus(routeId, `browse-filter-${filter}`);
  }, [filter, items, loading, nextStartIndex, services.focusManager, state.route]);

  useEffect(() => {
    const itemId = restoreItemIdRef.current;
    const focusId = itemId ? `browse-shows-${itemId}` : null;
    const itemIndex = focusId ? focusIndexById.get(focusId) : undefined;
    if (
      !itemId
      || !focusId
      || itemIndex === undefined
      || itemIndex < renderWindow.startIndex
      || itemIndex >= renderWindow.endIndex
    ) return undefined;
    const routeId = toRouteString(state.route);
    const frame = window.requestAnimationFrame(() => {
      const result = services.focusManager.focus(focusId, {
        routeId,
        reason: 'direct'
      });
      if (result.current === focusId) restoreItemIdRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusIndexById, renderWindow.endIndex, renderWindow.startIndex, services.focusManager, state.route]);

  useLayoutEffect(() => {
    // This is the render-completion boundary for virtualized focus handoffs.
    // It verifies native/logical agreement without a delay or scroll polling.
    const reconciled = services.focusManager.reconcileCurrentFocus(
      'render-window-commit',
      renderWindow.startIndex
    );
    if (reconciled && services.diagnostics.runtimeDiagnosticsActive) {
      services.diagnostics.recordRuntimeHeartbeat({
        currentFocusId: services.focusManager.focusId,
        focusedIndex: activeFocusIndex ?? null,
        renderWindowStart: renderWindow.startIndex,
        renderedCardCount: renderedItems.length,
        scrollTop: viewportRef.current?.scrollTop ?? 0
      });
    }
  }, [
    activeFocusIndex,
    focusCommitEpoch,
    renderWindow.endIndex,
    renderWindow.startIndex,
    renderedItems.length,
    services.diagnostics,
    services.focusManager
  ]);

  useEffect(() => {
    if (!services.diagnostics.runtimeDiagnosticsActive || renderedItems.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const current = diagnosticStateRef.current;
      services.diagnostics.recordShowsLibraryEvent({
        type: 'render-window-change',
        filter,
        metadataCount: items.length,
        renderWindowStart: renderWindow.startIndex,
        renderWindowEnd: renderWindow.endIndex,
        renderedCardCount: gridRef.current?.children.length ?? renderedItems.length,
        currentColumns: gridGeometry.columns,
        focusedItemId: current.focusedItemId,
        focusedIndex: current.focusedIndex,
        scrollTop: Math.round(viewportRef.current?.scrollTop ?? 0),
        topSpacerHeight: renderWindow.topSpacerHeight,
        bottomSpacerHeight: renderWindow.bottomSpacerHeight,
        artworkActive: current.artworkActive,
        artworkQueued: current.artworkQueued,
        loadingNextBatch: current.loadingNextBatch,
        hasMore: current.hasMore,
        documentVisibility: document.visibilityState
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    filter,
    gridGeometry.columns,
    items.length,
    renderWindow.bottomSpacerHeight,
    renderWindow.endIndex,
    renderWindow.startIndex,
    renderWindow.topSpacerHeight,
    renderedItems.length,
    services.diagnostics
  ]);

  const queueNextBatch = useCallback(() => {
    if (loadingRef.current || !hasMoreRef.current) return;
    const id = nextRequestIdRef.current;
    nextRequestIdRef.current += 1;
    activeRequestIdRef.current = id;
    loadingRef.current = true;
    setError(null);
    setRequest({
      filter,
      generation: generationRef.current,
      id,
      replace: items.length === 0 && nextStartIndex === 0,
      startIndex: nextStartIndex
    });
  }, [filter, items.length, nextStartIndex]);

  const queueManualBatch = useCallback(() => {
    setManualLoaderMode(true);
    queueNextBatch();
  }, [queueNextBatch]);

  useEffect(() => {
    if (!automaticLoadingAvailable || loading || error || !hasMore) return undefined;
    const sentinel = sentinelRef.current;
    const viewport = viewportRef.current;
    if (!sentinel || !viewport) return undefined;

    let observer: IntersectionObserver;
    try {
      observer = new window.IntersectionObserver(entries => {
        if (entries[0]?.isIntersecting && !loadingRef.current && hasMoreRef.current) {
          queueNextBatch();
        }
      }, {
        root: viewport,
        rootMargin: SHOWS_PREFETCH_MARGIN,
        threshold: 0
      });
    } catch {
      setObserverFailed(true);
      return undefined;
    }

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [automaticLoadingAvailable, error, hasMore, loading, queueNextBatch]);

  const selectFilter = (nextFilter: MediaBrowseFilter) => {
    if (nextFilter === filter) return;
    generationRef.current += 1;
    const id = nextRequestIdRef.current;
    nextRequestIdRef.current += 1;
    activeRequestIdRef.current = id;
    loadingRef.current = true;
    clearBrowseWindows(cacheKey, 'shows');
    if (cacheKey) rememberBrowseLocation(cacheKey, 'shows', { filter: nextFilter, page: 0 });
    if (scrollWindowFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollWindowFrameRef.current);
      scrollWindowFrameRef.current = null;
    }
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setFilter(nextFilter);
    setItems([]);
    setWindowStartRow(0);
    setNextStartIndex(0);
    setTotal(null);
    setHasMore(true);
    hasMoreRef.current = true;
    setError(null);
    setObserverFailed(false);
    setManualLoaderMode(false);
    restoreItemIdRef.current = null;
    setRequest({
      filter: nextFilter,
      generation: generationRef.current,
      id,
      replace: true,
      startIndex: 0
    });
  };

  const openItem = (item: PtvItem) => {
    if (!canNavigateToDetails(item)) return;
    if (cacheKey) {
      writeBrowseWindow(cacheKey, {
        screen: 'shows',
        filter,
        items,
        nextStartIndex,
        totalRecordCount: total ?? undefined,
        hasMore,
        focusedItemId: item.id
      });
    }
    dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
  };

  const countLabel = total !== null
    ? `${formatCount(total)} titles`
    : loading && items.length === 0
      ? 'Loading library'
      : `${formatCount(items.length)} titles`;
  const completionCount = total ?? items.length;

  return (
    <LayoutShell title="Shows" currentSection="shows">
      <section className="ptv-browse ptv-browse--shows">
        <div className="ptv-browse__heading ptv-shows-heading">
          <div>
            <span className="ptv-eyebrow">Your library</span>
            <div className="ptv-shows-heading__title-row">
              <h2>Shows</h2>
              <span className="ptv-browse__count">{countLabel}</span>
            </div>
          </div>
        </div>

        <div className="ptv-filter-bar" role="list" aria-label="Shows filters">
          {SHOW_FILTERS.map(option => (
            <FocusableButton
              key={option.id}
              focusId={`browse-filter-${option.id}`}
              preferredRow="browse-filters"
              className={filter === option.id ? 'is-selected' : ''}
              aria-current={filter === option.id ? 'true' : undefined}
              onClick={() => selectFilter(option.id)}
            >
              {option.label}
            </FocusableButton>
          ))}
        </div>

        <div
          ref={viewportRef}
          className="ptv-browse__viewport"
          aria-busy={loading}
          onScroll={updateWindowForScroll}
          onFocusCapture={event => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || !target.classList.contains('ptv-card-btn')) return;
            const focusId = target.getAttribute('data-focus-id');
            if (focusId) keepFocusedItemBuffered(focusId);
            revealFocusedCard(viewportRef.current, target);
          }}
        >
          {loading && items.length === 0 ? (
            <div className="ptv-browse-skeleton ptv-shows-skeleton" aria-label="Loading Shows">
              {Array.from({ length: SHOWS_BATCH_SIZE }, (_, index) => <span key={index} />)}
            </div>
          ) : null}

          {error && items.length === 0 ? (
            <div className="ptv-browse__message ptv-shows-error" role="alert">
              <span>{error}</span>
              <FocusableButton
                focusId="browse-shows-retry"
                preferredRow="browse-shows-status"
                onClick={queueNextBatch}
              >
                Try again
              </FocusableButton>
            </div>
          ) : null}

          {!loading && !error && items.length === 0 && !hasMore ? (
            <div className="ptv-browse__message ptv-muted">No shows match this view.</div>
          ) : null}

          {items.length && renderWindow.topSpacerHeight > 0 ? (
            <div
              key="shows-window-top"
              className="ptv-shows-window-spacer"
              style={{ height: `${renderWindow.topSpacerHeight}px` }}
              aria-hidden="true"
            />
          ) : null}

          {renderedItems.length ? (
            <ul ref={gridRef} key="shows-window-grid" className="ptv-poster-grid" aria-label="Shows library">
              {renderedItems.map(item => (
                <CardTile
                  key={item.id}
                  focusId={`browse-shows-${item.id}`}
                  item={item}
                  variant="poster"
                  posterUrl={artworkUrlForItem(client, item, 'libraryPoster')}
                  lazy
                  lazyRootRef={viewportRef}
                  lazyRootMargin={SHOWS_ARTWORK_PREFETCH_MARGIN}
                  fadeArtwork
                  placeholderVariant="subtle"
                  artworkLoadScheduler={artworkLoadScheduler}
                  meta={item.productionYear ? String(item.productionYear) : null}
                  watched={Boolean(item.played)}
                  onOpen={() => openItem(item)}
                />
              ))}
            </ul>
          ) : null}

          {items.length && renderWindow.bottomSpacerHeight > 0 ? (
            <div
              key="shows-window-bottom"
              className="ptv-shows-window-spacer"
              style={{ height: `${renderWindow.bottomSpacerHeight}px` }}
              aria-hidden="true"
            />
          ) : null}

          <div
            key="shows-load-status"
            ref={sentinelRef}
            className="ptv-shows-load-status"
            role="status"
            aria-live="polite"
          >
            {loading && items.length > 0 && automaticLoadingAvailable && !manualLoaderMode ? (
              <span className="ptv-shows-load-status__message">
                <span className="ptv-shows-load-status__spinner" aria-hidden="true" />
                <span>Loading more shows…</span>
              </span>
            ) : null}
            {!loading && !error && items.length > 0 && !hasMore ? (
              <span>All {formatCount(completionCount)} shows loaded</span>
            ) : null}
            {items.length > 0 && hasMore && (
              !automaticLoadingAvailable
              || Boolean(error)
              || manualLoaderMode
            ) ? (
              <FocusableButton
                focusId="browse-shows-load-more"
                preferredRow="browse-shows-status"
                className="ptv-shows-load-status__button"
                aria-disabled={loading ? 'true' : undefined}
                onClick={queueManualBatch}
              >
                {loading
                  ? 'Loading more shows…'
                  : error
                    ? 'Try loading more shows'
                    : 'Load more shows'}
              </FocusableButton>
            ) : null}
          </div>
        </div>
      </section>
    </LayoutShell>
  );
}
