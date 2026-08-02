import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { FocusableInput } from '../../components/FocusableInput';
import type { PtvItem } from '../../types/ptv';

interface LibraryFilterState {
  items: PtvItem[];
  loading: boolean;
  error: string | null;
}

export function MoviesScreen() {
  const { state, dispatch, services } = useApp();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LibraryFilterState>({ items: [], loading: true, error: null });
  const userSession = state.userSession;
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  const getPosterUrl = (item: PtvItem) => {
    if (!client || !item.imageTags) return null;
    if (item.imageTags.Primary) return client.getImageUrl(item.id, 'Primary', item.imageTags.Primary);
    if (item.imageTags.Poster) return client.getImageUrl(item.id, 'Poster', item.imageTags.Poster);
    if (item.imageTags.Thumb) return client.getImageUrl(item.id, 'Thumb', item.imageTags.Thumb);
    if (item.imageTags.Backdrop) return client.getImageUrl(item.id, 'Backdrop', item.imageTags.Backdrop);
    return null;
  };

  useEffect(() => {
    if (!client || !userSession) return;
    let active = true;
    const controller = new AbortController();
    (async () => {
      setResults(prev => ({ ...prev, loading: true, error: null }));
      try {
        const response = await client.getItems(userSession.userId, {
          IncludeItemTypes: 'Movie',
          Recursive: true,
          Limit: 60,
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          SearchTerm: query || undefined,
          Fields: 'ImageTags,ProductionYear,RunTimeTicks,SeriesName,Genres'
        }, controller.signal);
        if (!active) return;
        setResults({ items: mapPtvItems(response), loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setResults({ items: [], loading: false, error: error instanceof Error ? error.message : 'Failed to load movies' });
      }
    })();
    return () => {
      active = false;
      controller.abort('movies-route-hidden');
    };
  }, [client, userSession, query]);

  const openResult = (item: PtvItem) => {
    if (!canNavigateToDetails(item)) {
      return;
    }

    dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
  };

  return (
    <LayoutShell title="Movies" onBack={() => dispatch({ type: 'go_back' })}>
      <section className="ptv-section">
        <div className="ptv-row">
          <label>
            Search
            <FocusableInput
              focusId="movies-query"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        </div>
        {results.loading ? <p>Loading...</p> : null}
        {results.error ? <p className="ptv-error">{results.error}</p> : null}
        <ul className="ptv-grid">
          {results.items.slice(0, 21).map((item, index) => (
            <CardTile
              key={item.id}
              focusId={`movie-${item.id}-${index}`}
              item={item}
              posterUrl={getPosterUrl(item)}
              onOpen={() => openResult(item)}
            />
          ))}
        </ul>
      </section>
    </LayoutShell>
  );
}
