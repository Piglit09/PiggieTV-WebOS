import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { playbackRouteFromIntent } from '../../navigation/router';
import { mapPtvItem } from '../../api/jellyfin/mappers';
import type { PtvItem, PtvPlaybackIntent } from '../../types/ptv';
import { FocusableButton } from '../../components/FocusableButton';
import { toHms } from '../../utils/format';

export function DetailsScreen() {
  const { state, dispatch, services } = useApp();
  const [item, setItem] = useState<PtvItem | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userSession = state.userSession;
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  useEffect(() => {
    if (!state.route.itemId || !client || !userSession) return;
    const controller = new AbortController();
    setItem(null);
    setPosterUrl(null);
    setBackdropUrl(null);
    setError(null);

    void client
      .getItem(
        userSession.userId,
        state.route.itemId,
        ['Overview', 'ImageTags', 'BackdropImageTags', 'RunTimeTicks', 'ProductionYear', 'MediaType'],
        controller.signal
      )
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItem(response);
        const primaryTag = mapped.imageTags?.Primary ?? mapped.imageTags?.Poster;
        const backdropTag = mapped.backdropImageTags?.[0] ?? mapped.imageTags?.Backdrop;
        setItem(mapped);
        setPosterUrl(primaryTag ? client.getImageUrl(mapped.id, 'Primary', primaryTag) : null);
        setBackdropUrl(backdropTag ? client.getImageUrl(mapped.id, 'Backdrop', backdropTag) : null);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Details unavailable');
      });

    return () => controller.abort('details-route-hidden');
  }, [client, state.route.itemId, userSession]);

  function play() {
    if (!state.route.itemId || !state.userSession || !state.serverSession) return;
    const intent: PtvPlaybackIntent = {
      kind: 'movie',
      itemId: state.route.itemId,
      serverId: state.userSession.serverId,
      userId: state.userSession.userId,
      startPositionTicks: item?.playbackPositionTicks
    };
    dispatch({ type: 'set_playback_intent', playbackIntent: intent });
    dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent) });
  }

  return (
    <LayoutShell title="Details" onBack={() => dispatch({ type: 'go_back' })}>
      <section className="ptv-details">
        {backdropUrl ? (
          <div className="ptv-details__backdrop" style={{ backgroundImage: `url(${backdropUrl})` }} aria-hidden="true" />
        ) : null}
        <div className="ptv-details__scrim" aria-hidden="true" />
        <div className="ptv-details__content">
          <div className="ptv-details__poster-wrap">
            {posterUrl ? <img src={posterUrl} alt="" className="ptv-details-image" /> : <div className="ptv-details-image ptv-image-placeholder" />}
          </div>
          <div className="ptv-details__copy">
            <h1>{item?.name ?? 'Loading…'}</h1>
            {error ? <p className="ptv-error">{error}</p> : null}
            {item ? (
              <p className="ptv-details__meta">
                {[item.productionYear, item.runTimeTicks ? toHms(item.runTimeTicks) : null, item.type]
                  .filter(Boolean)
                  .join(' • ')}
              </p>
            ) : null}
            <p className="ptv-details__overview">{item?.overview || (item ? 'No overview available.' : '')}</p>
            <div className="ptv-row ptv-details__actions">
              <FocusableButton focusId="details-play" onClick={play} disabled={!item || Boolean(error)}>
                {item?.playbackPositionTicks ? 'Resume' : 'Play'}
              </FocusableButton>
              <FocusableButton focusId="details-back" onClick={() => dispatch({ type: 'go_back' })}>
                Back
              </FocusableButton>
            </div>
          </div>
        </div>
      </section>
    </LayoutShell>
  );
}
