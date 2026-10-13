import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { FocusableButton } from '../../components/FocusableButton';
import { FocusableInput } from '../../components/FocusableInput';
import type { PtvItem } from '../../types/ptv';
import { artworkUrlForItem } from '../../utils/artwork';
import { redactSensitiveText } from '../../core/redaction';
import {
  createMediaCacheSessionKey,
  readSearchSnapshot,
  writeSearchSnapshot
} from '../../state/mediaCache';
import { SearchCategoryCatalog } from './SearchCategoryCatalog';
import {
  buildPtvSearchCategorySection,
  getPtvSearchFilterConfig,
  getPtvSearchItemTypeLabel,
  isPtvSearchCategoryItem,
  mergePtvSearchResults,
  normalizePtvSearchFilter,
  parsePtvSearchCategoryRoute,
  PTV_SEARCH_FILTERS,
  type PtvSearchCategoryKind,
  type PtvSearchFilterId
} from './searchModel';
import { runPtvSearchTasks, type PtvSearchTask } from './searchCoordinator';

function getSearchResultFocusId(item: PtvItem) {
  return `search-${item.type}-${item.id}`;
}

export function SearchScreen() {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const cachedSearch = readSearchSnapshot(cacheKey);
  const [query, setQuery] = useState(() => cachedSearch?.query ?? '');
  const [filter, setFilter] = useState<PtvSearchFilterId>(() => normalizePtvSearchFilter(cachedSearch?.filter));
  const [items, setItems] = useState<PtvItem[]>(() => cachedSearch?.items ?? []);
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returnFocusRefreshPending, setReturnFocusRefreshPending] = useState(false);
  const filterStripRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const categoryReturnFocusRef = useRef<string | null>(null);
  const visibleItemsRef = useRef(items);
  const categoryRoute = useMemo(
    () => parsePtvSearchCategoryRoute(state.route.itemId, state.route.sectionId),
    [state.route.itemId, state.route.sectionId]
  );
  const filterConfig = useMemo(() => getPtvSearchFilterConfig(filter), [filter]);
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  useEffect(() => {
    if (categoryRoute) return undefined;
    const target = categoryReturnFocusRef.current;
    if (!target) return undefined;

    const targetIsVisible = items.some(item => getSearchResultFocusId(item) === target);
    if (!targetIsVisible) {
      if (!returnFocusRefreshPending) categoryReturnFocusRef.current = null;
      return undefined;
    }

    const currentFocus = services.focusManager.focusId;
    const transition = services.focusManager.lastTransition;
    const userMovedFocus = currentFocus !== target
      && transition?.nextFocusId === currentFocus
      && (
        transition.reason === 'pointer'
        || transition.reason === 'directional'
        || transition.reason === 'directional-fallback'
        || transition.reason === 'directional-boundary'
        || transition.reason === 'activate'
      );
    if (userMovedFocus) {
      categoryReturnFocusRef.current = null;
      if (returnFocusRefreshPending) setReturnFocusRefreshPending(false);
      return undefined;
    }

    if (currentFocus === target) {
      if (!returnFocusRefreshPending) categoryReturnFocusRef.current = null;
      return undefined;
    }

    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const restore = () => {
      if (cancelled) return;
      attempts += 1;
      const result = services.focusManager.focus(target, {
        routeId: 'search',
        reason: 'route-restore'
      });
      if (result.current === target) {
        if (!returnFocusRefreshPending) categoryReturnFocusRef.current = null;
        return;
      }
      if (attempts < 12) frame = window.requestAnimationFrame(restore);
    };
    frame = window.requestAnimationFrame(restore);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [categoryRoute, items, returnFocusRefreshPending, services.focusManager]);

  useEffect(() => {
    visibleItemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (categoryRoute || !client || !userSession) return undefined;
    const trimmed = query.trim();
    if (!trimmed) {
      setBusy(false);
      setRefining(false);
      setItems([]);
      visibleItemsRef.current = [];
      setError(null);
      categoryReturnFocusRef.current = null;
      setReturnFocusRefreshPending(false);
      if (cacheKey) writeSearchSnapshot(cacheKey, { filter, query: '', items: [] });
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const activeQuery = trimmed;
      setBusy(true);
      setRefining(false);
      setError(null);
      activeRequestRef.current?.abort();
      const request = new AbortController();
      activeRequestRef.current = request;
      const searches: Array<PtvSearchTask<unknown>> = [];

      if (filterConfig.includeItemTypes) {
        searches.push({
          id: 'content',
          run: signal => client.getSearch(
            userSession.userId,
            activeQuery,
            filterConfig.includeItemTypes,
            signal
          )
        });
      }
      if (filterConfig.categoryKinds?.length) {
        const priority: readonly PtvSearchCategoryKind[] = filter === 'all'
          ? ['MusicGenre', 'Genre', 'Studio']
          : filterConfig.categoryKinds;
        for (const kind of priority) {
          if (kind === 'Genre') {
            searches.push({
              id: 'genre',
              run: signal => client.getSearchGenres(userSession.userId, activeQuery, signal)
            });
          } else if (kind === 'MusicGenre') {
            searches.push({
              id: 'music-genre',
              run: signal => client.getSearchMusicGenres(userSession.userId, activeQuery, signal)
            });
          } else if (kind === 'Studio') {
            searches.push({
              id: 'studio',
              run: signal => client.getSearchStudios(userSession.userId, activeQuery, signal)
            });
          }
        }
      }

      void runPtvSearchTasks(searches, {
        signal: request.signal,
        maxConcurrency: 2,
        budgetMs: 7_000,
        onProgress: progress => {
          if (cancelled || request.signal.aborted || activeQuery !== query.trim()) return;
          const mapped = mergePtvSearchResults(
            progress.responses.map(response => mapPtvItems(response, { excludeEmptyVideoContainers: true })),
            activeQuery,
            filter
          );
          if (mapped.length || !progress.pending || progress.timedOut) {
            const target = categoryReturnFocusRef.current;
            const visibleItems = visibleItemsRef.current;
            const targetItem = target
              ? visibleItems.find(item => getSearchResultFocusId(item) === target)
              : undefined;
            const nextItems = progress.pending > 0
              && targetItem
              && !mapped.some(item => getSearchResultFocusId(item) === target)
              ? mergePtvSearchResults([[targetItem], mapped, visibleItems], activeQuery, filter)
              : mapped;
            visibleItemsRef.current = nextItems;
            setItems(nextItems);
            if (cacheKey) writeSearchSnapshot(cacheKey, { filter, query: activeQuery, items: nextItems });
          }
          if (mapped.length) {
            setBusy(false);
            setRefining(progress.pending > 0 && !progress.timedOut);
          } else if (!progress.pending || progress.timedOut) {
            setBusy(false);
            setRefining(false);
          }
        }
      }).then(summary => {
        if (cancelled || request.signal.aborted || activeQuery !== query.trim()) return;
        const mapped = mergePtvSearchResults(
          summary.responses.map(response => mapPtvItems(response, { excludeEmptyVideoContainers: true })),
          activeQuery,
          filter
        );
        visibleItemsRef.current = mapped;
        setItems(mapped);
        if (cacheKey) writeSearchSnapshot(cacheKey, { filter, query: activeQuery, items: mapped });
        setBusy(false);
        setRefining(false);
        setReturnFocusRefreshPending(false);
        if (!summary.responses.length && (summary.errors.length || summary.timedOut)) {
          const cause = summary.errors[0];
          setError(summary.timedOut
            ? 'The server is still working. Try the search again.'
            : redactSensitiveText(cause instanceof Error ? cause.message : 'Search failed'));
        }
      }).catch(cause => {
          if (cancelled || request.signal.aborted) return;
          visibleItemsRef.current = [];
          setItems([]);
          setError(redactSensitiveText(cause instanceof Error ? cause.message : 'Search failed'));
          setBusy(false);
          setRefining(false);
          setReturnFocusRefreshPending(false);
      });
    }, 300);

    return () => {
      clearTimeout(timer);
      cancelled = true;
      activeRequestRef.current?.abort();
    };
  }, [cacheKey, categoryRoute, client, filter, filterConfig, query, userSession]);

  const updateQuery = (nextQuery: string) => {
    categoryReturnFocusRef.current = null;
    setReturnFocusRefreshPending(false);
    setQuery(nextQuery);
    visibleItemsRef.current = [];
    setItems([]);
    setRefining(false);
    setError(null);
    if (cacheKey) writeSearchSnapshot(cacheKey, { filter, query: nextQuery, items: [] });
  };

  const updateFilter = (nextFilter: PtvSearchFilterId) => {
    if (nextFilter === filter) return;
    categoryReturnFocusRef.current = null;
    setReturnFocusRefreshPending(false);
    setFilter(nextFilter);
    visibleItemsRef.current = [];
    setItems([]);
    setRefining(false);
    setError(null);
    if (cacheKey) writeSearchSnapshot(cacheKey, { filter: nextFilter, query, items: [] });
  };

  const revealFilter = (button: HTMLButtonElement) => {
    const strip = filterStripRef.current;
    if (!strip) return;
    const stripBounds = strip.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const edgePadding = 12;
    if (buttonBounds.left < stripBounds.left + edgePadding) {
      strip.scrollLeft -= stripBounds.left + edgePadding - buttonBounds.left;
    } else if (buttonBounds.right > stripBounds.right - edgePadding) {
      strip.scrollLeft += buttonBounds.right - stripBounds.right + edgePadding;
    }
  };

  const openResult = (item: PtvItem) => {
    if (isPtvSearchCategoryItem(item)) {
      const returnFocusId = getSearchResultFocusId(item);
      categoryReturnFocusRef.current = returnFocusId;
      setReturnFocusRefreshPending(true);
      services.focusManager.rememberRouteFocus('search', returnFocusId);
      dispatch({
        type: 'set_route',
        route: buildRoute('search', item.id, buildPtvSearchCategorySection(item.type, item.name))
      });
      return;
    }
    if (canNavigateToDetails(item)) {
      dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
      return;
    }

    setError(`${item.name} cannot be opened`);
  };

  if (categoryRoute) return <SearchCategoryCatalog category={categoryRoute} />;

  return (
    <LayoutShell title="Search" currentSection="search">
      <section className="ptv-search">
        <div className="ptv-search__heading">
          <span className="ptv-eyebrow">Find something great</span>
          <h2>Search PTV</h2>
        </div>
        <label className="ptv-search__field">
          <span className="ptv-visually-hidden">Search</span>
          <FocusableInput
            focusId="search-query"
            value={query}
            onChange={event => updateQuery(event.target.value)}
            placeholder="Titles, people, music, genres, and studios"
            className="ptv-search__input"
          />
        </label>
        <div ref={filterStripRef} className="ptv-search__filters" role="toolbar" aria-label="Search filters">
          {PTV_SEARCH_FILTERS.map(candidate => (
            <FocusableButton
              key={candidate.id}
              focusId={`search-filter-${candidate.id}`}
              preferredRow="search-filters"
              aria-pressed={filter === candidate.id}
              className={filter === candidate.id ? 'is-selected' : ''}
              onFocus={event => revealFilter(event.currentTarget)}
              onClick={() => updateFilter(candidate.id)}
            >
              {candidate.label}
            </FocusableButton>
          ))}
        </div>
        <div className="ptv-search__status" aria-live="polite">
          {busy ? <p className="ptv-muted">Searching…</p> : null}
          {!busy && refining ? <p className="ptv-muted">Adding related matches…</p> : null}
          {error ? <p className="ptv-error" role="alert">{error}</p> : null}
        </div>
        <div className="ptv-search__viewport">
          {!query.trim() ? <p className="ptv-search__hint">Start typing to explore your library.</p> : null}
          {query.trim() && !busy && !error && !items.length ? (
            <p className="ptv-search__hint">No {filterConfig.label.toLocaleLowerCase()} matched your search.</p>
          ) : null}
          <ul className="ptv-poster-grid ptv-search__results">
            {items.map(item => (
              <CardTile
                key={`${item.type}-${item.id}`}
                focusId={getSearchResultFocusId(item)}
                item={item}
                variant="poster"
                posterUrl={artworkUrlForItem(client, item, 'poster')}
                lazy
                meta={isPtvSearchCategoryItem(item)
                  ? getPtvSearchItemTypeLabel(item)
                  : item.productionYear ? String(item.productionYear) : null}
                onOpen={() => openResult(item)}
              />
            ))}
          </ul>
        </div>
      </section>
    </LayoutShell>
  );
}
