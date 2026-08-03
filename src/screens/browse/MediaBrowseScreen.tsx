import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { CardTile } from '../../components/CardTile';
import { FocusableButton } from '../../components/FocusableButton';
import { buildRoute, toRouteString } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { artworkUrlForItem } from '../../utils/artwork';
import { redactSensitiveText } from '../../core/redaction';
import {
  createMediaCacheSessionKey,
  readBrowsePage,
  readRememberedBrowseLocation,
  rememberBrowseLocation,
  writeBrowsePage,
  type MediaBrowseFilter,
  type MediaBrowseScreen as BrowseScreenId
} from '../../state/mediaCache';
import type { PtvItem } from '../../types/ptv';

const PAGE_SIZE = 16;

const FILTERS: ReadonlyArray<{ id: MediaBrowseFilter; label: string }> = [
  { id: 'recent', label: 'Recently Added' },
  { id: 'az', label: 'A–Z' },
  { id: 'favorites', label: 'Favorites' }
];

const BROWSE_CONFIG: Record<BrowseScreenId, { title: string; itemType: string; empty: string }> = {
  movies: { title: 'Movies', itemType: 'Movie', empty: 'No movies match this view.' },
  shows: { title: 'Shows', itemType: 'Series', empty: 'No shows match this view.' },
  music: { title: 'Music', itemType: 'MusicAlbum', empty: 'No albums match this view.' },
  reading: { title: 'Reading', itemType: 'Book', empty: 'No books match this view.' }
};

export function MediaBrowseScreen({ screenId }: { screenId: BrowseScreenId }) {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const remembered = readRememberedBrowseLocation(cacheKey, screenId);
  const [filter, setFilter] = useState<MediaBrowseFilter>(remembered?.filter ?? 'recent');
  const [page, setPage] = useState(remembered?.page ?? 0);
  const initialCachedPage = readBrowsePage(cacheKey, screenId, remembered?.filter ?? 'recent', remembered?.page ?? 0);
  const [items, setItems] = useState<PtvItem[]>(initialCachedPage?.items ?? []);
  const [total, setTotal] = useState<number | null>(initialCachedPage?.totalRecordCount ?? null);
  const [loading, setLoading] = useState(!initialCachedPage);
  const [error, setError] = useState<string | null>(null);
  const pendingPageFocus = useRef(false);
  const config = BROWSE_CONFIG[screenId];
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  useEffect(() => {
    if (!client || !userSession || !cacheKey) return;
    rememberBrowseLocation(cacheKey, screenId, { filter, page });
    const cached = readBrowsePage(cacheKey, screenId, filter, page);
    if (cached) {
      setItems(cached.items);
      setTotal(cached.totalRecordCount ?? null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.getItems(userSession.userId, {
      IncludeItemTypes: config.itemType,
      Recursive: true,
      StartIndex: page * PAGE_SIZE,
      Limit: PAGE_SIZE,
      SortBy: filter === 'recent' ? 'DateCreated' : 'SortName',
      SortOrder: filter === 'recent' ? 'Descending' : 'Ascending',
      Filters: filter === 'favorites' ? 'IsFavorite' : undefined,
      Fields: 'ImageTags,BackdropImageTags,Overview,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,Genres,UserData',
      EnableUserData: true,
      EnableTotalRecordCount: true
    }, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response);
        const totalRecordCount = typeof response.TotalRecordCount === 'number'
          ? response.TotalRecordCount
          : undefined;
        setItems(mapped);
        setTotal(totalRecordCount ?? null);
        setLoading(false);
        writeBrowsePage(cacheKey, {
          screen: screenId,
          filter,
          page,
          items: mapped,
          totalRecordCount
        });
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(redactSensitiveText(cause instanceof Error ? cause.message : 'This library view could not be loaded.'));
      });

    return () => controller.abort(`${screenId}-browse-hidden`);
  }, [cacheKey, client, config.itemType, filter, page, screenId, userSession]);

  useEffect(() => {
    if (!pendingPageFocus.current || !items.length) return;
    pendingPageFocus.current = false;
    const first = items[0];
    if (!first) return;
    window.requestAnimationFrame(() => services.focusManager.focus(`browse-${screenId}-${first.id}`, {
      routeId: toRouteString(state.route),
      reason: 'direct'
    }));
  }, [items, screenId, services.focusManager, state.route]);

  useEffect(() => {
    if (loading) return;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered?.startsWith(`browse-${screenId}-`)) return;
    if (items.some(item => `browse-${screenId}-${item.id}` === remembered)) return;
    services.focusManager.restoreRouteFocus(routeId, 'browse-filter-recent');
  }, [items, loading, screenId, services.focusManager, state.route]);

  const selectFilter = (nextFilter: MediaBrowseFilter) => {
    if (nextFilter === filter) return;
    setFilter(nextFilter);
    setPage(0);
    setItems([]);
    setTotal(null);
    pendingPageFocus.current = false;
  };

  const changePage = (nextPage: number) => {
    if (nextPage < 0 || nextPage === page) return;
    setPage(nextPage);
    setItems([]);
    setTotal(null);
    pendingPageFocus.current = true;
  };

  const openItem = (item: PtvItem) => {
    if (!canNavigateToDetails(item)) return;
    dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
  };

  const hasNext = total === null ? items.length === PAGE_SIZE : (page + 1) * PAGE_SIZE < total;

  return (
    <LayoutShell title={config.title} currentSection={screenId}>
      <section className="ptv-browse">
        <div className="ptv-browse__heading">
          <div>
            <span className="ptv-eyebrow">Your library</span>
            <h2>{config.title}</h2>
          </div>
          <span className="ptv-browse__count">
            {total !== null ? `${total} titles` : loading ? 'Loading library' : `${items.length} on this page`}
          </span>
        </div>

        <div className="ptv-filter-bar" role="list" aria-label={`${config.title} filters`}>
          {FILTERS.map(option => (
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

        <div className="ptv-browse__viewport">
          {loading && items.length === 0 ? (
            <div className="ptv-browse-skeleton" aria-label={`Loading ${config.title}`}>
              {Array.from({ length: PAGE_SIZE }, (_, index) => <span key={index} />)}
            </div>
          ) : null}
          {error ? (
            <div className="ptv-browse__message ptv-error" role="alert">{error}</div>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <div className="ptv-browse__message ptv-muted">{config.empty}</div>
          ) : null}
          {items.length ? (
            <ul className="ptv-poster-grid">
              {items.slice(0, PAGE_SIZE).map(item => (
                <CardTile
                  key={item.id}
                  focusId={`browse-${screenId}-${item.id}`}
                  item={item}
                  variant="poster"
                  posterUrl={artworkUrlForItem(client, item, 'poster')}
                  lazy
                  meta={item.productionYear ? String(item.productionYear) : null}
                  watched={Boolean(item.played)}
                  onOpen={() => openItem(item)}
                />
              ))}
            </ul>
          ) : null}
        </div>

        <div className="ptv-browse__paging">
          <FocusableButton
            focusId="browse-page-previous"
            preferredRow="browse-paging"
            onClick={() => changePage(page - 1)}
            disabled={page === 0 || loading}
          >
            Previous
          </FocusableButton>
          <span>Page {page + 1}</span>
          <FocusableButton
            focusId="browse-page-next"
            preferredRow="browse-paging"
            onClick={() => changePage(page + 1)}
            disabled={!hasNext || loading}
          >
            Next
          </FocusableButton>
        </div>
      </section>
    </LayoutShell>
  );
}
