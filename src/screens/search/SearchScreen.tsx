import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { FocusableInput } from '../../components/FocusableInput';
import type { PtvItem } from '../../types/ptv';
import { artworkUrlForItem } from '../../utils/artwork';
import { redactSensitiveText } from '../../core/redaction';
import {
  createMediaCacheSessionKey,
  readSearchSnapshot,
  writeSearchSnapshot
} from '../../state/mediaCache';

export function SearchScreen() {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const cachedSearch = readSearchSnapshot(cacheKey);
  const [query, setQuery] = useState(() => cachedSearch?.query ?? '');
  const [items, setItems] = useState<PtvItem[]>(() => cachedSearch?.items ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  const activeRequestRef = React.useRef<AbortController | null>(null);

  useEffect(() => {
    if (!client || !userSession) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setBusy(false);
      setItems([]);
      if (cacheKey) writeSearchSnapshot(cacheKey, { query: '', items: [] });
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
          const mapped = mapPtvItems(response).slice(0, 16);
          setItems(mapped);
          if (cacheKey) writeSearchSnapshot(cacheKey, { query: activeQuery, items: mapped });
          setBusy(false);
        })
        .catch(cause => {
          if (cancelled || request.signal.aborted) return;
          setError(redactSensitiveText(cause instanceof Error ? cause.message : 'Search failed'));
          setBusy(false);
        });
    }, 300);

  return () => {
      clearTimeout(timer);
      cancelled = true;
      activeRequestRef.current?.abort();
      setBusy(false);
    };
  }, [cacheKey, query, client, userSession]);

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setItems([]);
    setError(null);
    if (cacheKey) writeSearchSnapshot(cacheKey, { query: nextQuery, items: [] });
  };

  const openResult = (item: PtvItem) => {
    if (canNavigateToDetails(item)) {
      dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
      return;
    }

    setError(`${item.name} cannot be opened`);
  };

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
            placeholder="Movies, shows, music, and books"
            className="ptv-search__input"
          />
        </label>
        <div className="ptv-search__status" aria-live="polite">
          {busy ? <p className="ptv-muted">Searching…</p> : null}
          {error ? <p className="ptv-error" role="alert">{error}</p> : null}
        </div>
        {!query.trim() ? <p className="ptv-search__hint">Start typing to explore your library.</p> : null}
        <ul className="ptv-poster-grid ptv-search__results">
          {items.slice(0, 16).map((item, index) => (
            <CardTile
              key={item.id}
              focusId={`search-${item.id}-${index}`}
              item={item}
              variant="poster"
              posterUrl={artworkUrlForItem(client, item, 'poster')}
              lazy
              meta={item.productionYear ? String(item.productionYear) : null}
              onOpen={() => openResult(item)}
            />
          ))}
        </ul>
      </section>
    </LayoutShell>
  );
}
