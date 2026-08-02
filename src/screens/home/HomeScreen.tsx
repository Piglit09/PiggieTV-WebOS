import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute, toRouteString } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { redactSensitiveText } from '../../core/redaction';
import type { PtvItem } from '../../types/ptv';

interface HomeSectionState {
  id: string;
  title: string;
  items: PtvItem[];
  loading: boolean;
  error: string | null;
}

function HomeShelf({
  row,
  rowIndex,
  loadArtwork,
  getPosterUrl,
  onOpen,
  onActive
}: {
  row: HomeSectionState;
  rowIndex: number;
  loadArtwork: boolean;
  getPosterUrl: (item: PtvItem) => string | null;
  onOpen: (item: PtvItem, rowId: string) => void;
  onActive: (rowIndex: number) => void;
}) {
  const [startIndex, setStartIndex] = useState(0);
  const visibleCards = 7;

  const reveal = (index: number) => {
    onActive(rowIndex);
    setStartIndex(current => {
      if (index < current) return index;
      if (index >= current + visibleCards) return index - visibleCards + 1;
      return current;
    });
  };

  return (
    <section className="ptv-home-row" aria-label={row.title}>
      <h2>{row.title}</h2>
      {row.loading ? <p className="ptv-home-row__status">Loading…</p> : null}
      {row.error ? <p className="ptv-error ptv-home-row__status">{row.error}</p> : null}
      {!row.loading && !row.error && row.items.length === 0 ? (
        <p className="ptv-home-row__status ptv-muted">Nothing to show yet.</p>
      ) : null}
      <div className="ptv-shelf-viewport">
        <ul
          className="ptv-row-grid"
          style={{ transform: `translate3d(${-startIndex * 238}px, 0, 0)` }}
        >
          {row.items.slice(0, 12).map((item, index) => (
            <CardTile
              key={`${row.id}-${item.id}`}
              focusId={`home-${row.id}-${item.id}`}
              preferredRow={`home-${row.id}`}
              item={item}
              onFocus={() => reveal(index)}
              onOpen={() => onOpen(item, row.id)}
              posterUrl={
                loadArtwork && index >= Math.max(0, startIndex - 1) && index <= startIndex + visibleCards
                  ? getPosterUrl(item)
                  : null
              }
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

export function HomeScreen() {
  const { state, dispatch, services } = useApp();
  const [sections, setSections] = useState<HomeSectionState[]>([]);
  const [activeRow, setActiveRow] = useState(0);
  const userSession = state.userSession;
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  const getPosterUrl = (item: PtvItem) => {
    if (!client || !item.imageTags) return null;
    const options = { maxWidth: 320, quality: 80 };
    if (item.imageTags.Primary) return client.getImageUrl(item.id, 'Primary', item.imageTags.Primary, options);
    if (item.imageTags.Poster) return client.getImageUrl(item.id, 'Poster', item.imageTags.Poster, options);
    if (item.imageTags.Thumb) return client.getImageUrl(item.id, 'Thumb', item.imageTags.Thumb, options);
    if (item.imageTags.Backdrop) return client.getImageUrl(item.id, 'Backdrop', item.imageTags.Backdrop, options);
    return null;
  };

  const headers = useMemo(
    () => ({
      continue: 'Continue Watching',
      nextup: 'Next Up',
      movies: 'Movies',
      shows: 'Shows',
      recent: 'Recently Added'
    }),
    []
  );

  useEffect(() => {
    if (!client || !userSession) return;
    let active = true;
    const controller = new AbortController();

    setSections([
      { id: 'continue', title: headers.continue, items: [], loading: true, error: null },
      { id: 'nextup', title: headers.nextup, items: [], loading: true, error: null },
      { id: 'movies', title: headers.movies, items: [], loading: true, error: null },
      { id: 'shows', title: headers.shows, items: [], loading: true, error: null },
      { id: 'recent', title: headers.recent, items: [], loading: true, error: null }
    ]);

    const load = async (section: HomeSectionState) => {
      try {
        if (section.id === 'continue') {
          const response = await client.getResume(userSession.userId, 'Movie,Series,Episode', 10, controller.signal);
          section.items = mapPtvItems(response);
        } else if (section.id === 'nextup') {
          const response = await client.getNextUp(userSession.userId, 10, controller.signal);
          section.items = mapPtvItems(response);
        } else if (section.id === 'movies') {
          const response = await client.getItems(userSession.userId, {
            IncludeItemTypes: 'Movie',
            Limit: 12,
            Recursive: true,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'ImageTags',
            EnableUserData: false,
            EnableTotalRecordCount: false
          }, controller.signal);
          section.items = mapPtvItems(response);
        } else if (section.id === 'shows') {
          const response = await client.getItems(userSession.userId, {
            IncludeItemTypes: 'Series',
            Limit: 12,
            Recursive: true,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'ImageTags',
            EnableUserData: false,
            EnableTotalRecordCount: false
          }, controller.signal);
          section.items = mapPtvItems(response);
        } else {
          const response = await client.getRecentlyAdded(userSession.userId, 'Movie,Series', 12, controller.signal);
          section.items = mapPtvItems(response);
        }

        section.loading = false;
        section.error = null;
      } catch (cause) {
        if (controller.signal.aborted) return;
        section.loading = false;
        const message = cause instanceof Error
          ? cause.message
          : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
            ? cause.message
            : 'Failed to load row';
        section.error = redactSensitiveText(message);
      }

      if (!active) return;
      setSections(previous => previous.map(entry => (entry.id === section.id ? { ...entry, ...section } : entry)));
    };

    const queue: HomeSectionState[] = [
      { id: 'continue', title: headers.continue, items: [], loading: true, error: null },
      { id: 'nextup', title: headers.nextup, items: [], loading: true, error: null },
      { id: 'movies', title: headers.movies, items: [], loading: true, error: null },
      { id: 'shows', title: headers.shows, items: [], loading: true, error: null },
      { id: 'recent', title: headers.recent, items: [], loading: true, error: null }
    ];

    const worker = async () => {
      while (active && !controller.signal.aborted) {
        const section = queue.shift();
        if (!section) return;
        await load(section);
      }
    };

    void Promise.allSettled([worker(), worker(), worker()]);

    return () => {
      active = false;
      controller.abort('home-route-hidden');
    };
  }, [headers, client, userSession]);

  useEffect(() => {
    if (!sections.length) return;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered) return;
    const rememberedRow = sections.find(row => remembered.startsWith(`home-${row.id}-`));
    if (rememberedRow?.loading === false || sections.every(row => !row.loading)) {
      services.focusManager.restoreRouteFocus(routeId);
    }
  }, [sections, services.focusManager, state.route]);

  const openItem = (item: PtvItem, rowId: string) => {
    if (!canNavigateToDetails(item)) {
      return;
    }

    dispatch({ type: 'set_route', route: buildRoute('details', item.id, rowId) });
  };

  return (
    <LayoutShell
      title="PiggieTV"
      onSettings={() => dispatch({ type: 'set_route', route: buildRoute('settings') })}
      onDiagnostics={() => dispatch({ type: 'set_route', route: buildRoute('diagnostics') })}
    >
      <section className="ptv-home">
        <div
          className="ptv-home__rows"
          style={{ transform: `translate3d(0, ${-Math.max(0, activeRow - 2) * 286}px, 0)` }}
        >
          {sections.map((row, rowIndex) => (
            <HomeShelf
              key={row.id}
              row={row}
              rowIndex={rowIndex}
              loadArtwork={rowIndex >= Math.max(0, activeRow - 2) && rowIndex <= activeRow + 2}
              getPosterUrl={getPosterUrl}
              onOpen={openItem}
              onActive={setActiveRow}
            />
          ))}
        </div>
      </section>
    </LayoutShell>
  );
}
