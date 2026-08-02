import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { FocusableInput } from '../../components/FocusableInput';
import type { PtvItem } from '../../types/ptv';

export function SearchScreen() {
  const { state, dispatch, services } = useApp();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PtvItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const activeRequestRef = React.useRef<AbortController | null>(null);

  useEffect(() => {
    if (!client || !userSession) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setBusy(false);
      setItems([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const activeQuery = trimmed;
      setBusy(true);
      setError(null);
      activeRequestRef.current?.abort();
      const request = new AbortController();
      activeRequestRef.current = request;
      client
        .getSearch(userSession.userId, activeQuery, 'Movie,Series,MusicAlbum,Audio,Book', request.signal)
        .then(response => {
          if (cancelled) return;
          if (activeQuery !== query.trim()) return;
          setItems(mapPtvItems(response));
          setBusy(false);
        })
        .catch(cause => {
          if (cancelled || request.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : 'Search failed');
          setBusy(false);
        });
    }, 300);

  return () => {
      clearTimeout(timer);
      cancelled = true;
      activeRequestRef.current?.abort();
      setBusy(false);
    };
  }, [query, client, userSession]);

  const openResult = (item: PtvItem) => {
    if (canNavigateToDetails(item)) {
      dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
      return;
    }

    setError(`${item.name} cannot be opened`);
  };

  return (
    <LayoutShell title="Search" onBack={() => dispatch({ type: 'go_back' })}>
      <section className="ptv-section">
        <label>
          Search
          <FocusableInput
            focusId="search-query"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Type to search"
          />
        </label>
        {busy ? <p>Searching...</p> : null}
        {error ? <p className="ptv-error">{error}</p> : null}
        <ul className="ptv-grid">
          {items.slice(0, 21).map((item, index) => (
            <CardTile
              key={item.id}
              focusId={`search-${item.id}-${index}`}
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
