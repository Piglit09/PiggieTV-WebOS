import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile } from '../../components/CardTile';
import { FocusableInput } from '../../components/FocusableInput';
import type { PtvItem } from '../../types/ptv';

export function ShowsScreen() {
  const { state, dispatch, services } = useApp();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PtvItem[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    if (!client || !userSession) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    client
      .getItems(userSession.userId, {
        IncludeItemTypes: 'Series',
        Recursive: true,
        Limit: 60,
        Fields: 'ImageTags,Overview,ProductionYear,RunTimeTicks,UserData',
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        SearchTerm: query || undefined
      }, controller.signal)
      .then(response => {
        if (!active) return;
        setItems(mapPtvItems(response));
        setError(null);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Failed to load shows');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      controller.abort('shows-route-hidden');
    };
  }, [client, userSession, query]);

  const openResult = (item: PtvItem) => {
    if (!canNavigateToDetails(item)) {
      return;
    }

    dispatch({ type: 'set_route', route: buildRoute('details', item.id) });
  };

  return (
    <LayoutShell title="Shows" onBack={() => dispatch({ type: 'go_back' })}>
      <section className="ptv-section">
        <label>
          Search
          <FocusableInput
            focusId="shows-query"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        {loading ? <p>Loading...</p> : null}
        {error ? <p className="ptv-error">{error}</p> : null}
        <ul className="ptv-grid">
          {items.slice(0, 21).map((item, index) => (
            <CardTile
              key={item.id}
              focusId={`show-${item.id}-${index}`}
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
