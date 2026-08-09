import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutShell } from '../../components/LayoutShell';
import { CardTile } from '../../components/CardTile';
import { FocusableButton } from '../../components/FocusableButton';
import { mapPtvItems, canNavigateToDetails } from '../../api/jellyfin/mappers';
import { buildRoute, toRouteString } from '../../navigation/router';
import { redactSensitiveText } from '../../core/redaction';
import { useApp } from '../../state/appContext';
import type { PtvItem } from '../../types/ptv';
import { artworkUrlForItem } from '../../utils/artwork';
import type { PtvSearchCategoryRoute } from './searchModel';
import { getPtvSearchItemTypeLabel } from './searchModel';

const CATEGORY_PAGE_SIZE = 16;

export function SearchCategoryCatalog({ category }: { category: PtvSearchCategoryRoute }) {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<PtvItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pendingPageFocus = useRef(true);
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [services.jellyfin, state.serverUrl, userSession]);

  useEffect(() => {
    if (!client || !userSession) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.getSearchCategoryItems(
      userSession.userId,
      category.id,
      category.kind,
      page * CATEGORY_PAGE_SIZE,
      CATEGORY_PAGE_SIZE,
      controller.signal,
      category.name
    )
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response, { excludeEmptyVideoContainers: true });
        setItems(mapped);
        setTotal(typeof response.TotalRecordCount === 'number' ? response.TotalRecordCount : null);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setItems([]);
        setError(redactSensitiveText(cause instanceof Error ? cause.message : 'This category could not be loaded.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort('search-category-hidden');
  }, [category.id, category.kind, category.name, client, page, userSession]);

  useEffect(() => {
    if (loading || !items.length) return undefined;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    const rememberedVisible = remembered?.startsWith('search-category-item-')
      && items.some(item => `search-category-item-${item.id}` === remembered);
    const target = rememberedVisible && remembered
      ? remembered
      : `search-category-item-${items[0]!.id}`;
    if (!pendingPageFocus.current && !rememberedVisible) return undefined;
    pendingPageFocus.current = false;
    const frame = window.requestAnimationFrame(() => {
      services.focusManager.focus(target, { routeId, reason: rememberedVisible ? 'route-restore' : 'direct' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items, loading, services.focusManager, state.route]);

  const changePage = (nextPage: number) => {
    if (nextPage < 0 || nextPage === page) return;
    pendingPageFocus.current = true;
    setPage(nextPage);
    setItems([]);
    setTotal(null);
  };
  const openItem = (item: PtvItem) => {
    if (!canNavigateToDetails(item)) return;
    dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
  };
  const goBack = () => dispatch({ type: 'go_back' });
  const hasNext = total === null
    ? items.length === CATEGORY_PAGE_SIZE
    : (page + 1) * CATEGORY_PAGE_SIZE < total;

  return (
    <LayoutShell title={category.name} currentSection="search" onBack={goBack}>
      <section className="ptv-search-category">
        <div className="ptv-browse__heading">
          <div>
            <span className="ptv-eyebrow">{getPtvSearchItemTypeLabel({ type: category.kind })}</span>
            <h2>{category.name}</h2>
          </div>
          <span className="ptv-browse__count">
            {total !== null ? `${total} titles` : loading ? 'Loading category' : `${items.length} on this page`}
          </span>
        </div>
        <div className="ptv-search-category__viewport">
          {loading && !items.length ? (
            <div className="ptv-browse-skeleton" aria-label={`Loading ${category.name}`}>
              {Array.from({ length: CATEGORY_PAGE_SIZE }, (_, index) => <span key={index} />)}
            </div>
          ) : null}
          {error ? <div className="ptv-browse__message ptv-error" role="alert">{error}</div> : null}
          {!loading && !error && !items.length ? (
            <div className="ptv-browse__message ptv-muted">No titles were found in this category.</div>
          ) : null}
          {items.length ? (
            <ul className="ptv-poster-grid">
              {items.map(item => (
                <CardTile
                  key={item.id}
                  focusId={`search-category-item-${item.id}`}
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
            focusId="search-category-previous"
            preferredRow="search-category-paging"
            disabled={page === 0 || loading}
            onClick={() => changePage(page - 1)}
          >
            Previous
          </FocusableButton>
          <span>Page {page + 1}</span>
          <FocusableButton
            focusId="search-category-next"
            preferredRow="search-category-paging"
            disabled={!hasNext || loading}
            onClick={() => changePage(page + 1)}
          >
            Next
          </FocusableButton>
        </div>
      </section>
    </LayoutShell>
  );
}
