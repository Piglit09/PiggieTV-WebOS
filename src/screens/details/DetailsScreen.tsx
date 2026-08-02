import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { playbackRouteFromIntent, toRouteString } from '../../navigation/router';
import { mapPtvItem, mapPtvItems } from '../../api/jellyfin/mappers';
import type { PtvItem, PtvPlaybackIntent } from '../../types/ptv';
import { FocusableButton } from '../../components/FocusableButton';
import { CardTile } from '../../components/CardTile';
import { toHms } from '../../utils/format';
import { artworkUrlForItem } from '../../utils/artwork';
import { redactSensitiveText } from '../../core/redaction';
import {
  createMediaCacheSessionKey,
  readMediaMetadata,
  readSelectedSeriesSeason,
  readSeriesEpisodes,
  readSeriesSeasons,
  writeMediaMetadata,
  writeSelectedSeriesSeason,
  writeSeriesEpisodes,
  writeSeriesSeasons
} from '../../state/mediaCache';

const DETAIL_FIELDS = [
  'Overview',
  'ImageTags',
  'BackdropImageTags',
  'RunTimeTicks',
  'ProductionYear',
  'PremiereDate',
  'EndDate',
  'Status',
  'MediaType',
  'OfficialRating',
  'CommunityRating',
  'Genres',
  'UserData',
  'SeriesName',
  'SeasonName',
  'IndexNumber',
  'ParentIndexNumber'
];
const EPISODE_PAGE_SIZE = 8;

function cleanOverview(value?: string) {
  return value?.replace(/<br\s*\/?\s*>/gi, ' ').replace(/\s+/g, ' ').trim() ?? '';
}

function episodeLabel(item: PtvItem) {
  if (item.parentIndexNumber && item.indexNumber) return `S${item.parentIndexNumber} E${item.indexNumber}`;
  if (item.indexNumber) return `Episode ${item.indexNumber}`;
  return item.seasonName ?? null;
}

function itemProgress(item: PtvItem) {
  if (!item.playbackPositionTicks || !item.runTimeTicks || item.runTimeTicks <= 0) return null;
  return Math.max(0, Math.min(100, (item.playbackPositionTicks / item.runTimeTicks) * 100));
}

function isPlayable(item: PtvItem) {
  return item.type === 'Movie' || item.type === 'Episode' || item.type === 'Audio' || item.type === 'Book';
}

function playbackKind(item: PtvItem): PtvPlaybackIntent['kind'] {
  if (item.type === 'Episode') return 'episode';
  if (item.type === 'Audio') return 'audio';
  if (item.type === 'Book') return 'book';
  return 'movie';
}

export function DetailsScreen() {
  const { state, dispatch, services } = useApp();
  const itemId = state.route.itemId;
  const userSession = state.userSession;
  const cacheKey = createMediaCacheSessionKey(state.serverUrl, userSession);
  const cachedItem = itemId ? readMediaMetadata(cacheKey, itemId) : undefined;
  const [item, setItem] = useState<PtvItem | null>(cachedItem ?? null);
  const [loading, setLoading] = useState(!cachedItem);
  const [error, setError] = useState<string | null>(null);
  const [detailsRetryNonce, setDetailsRetryNonce] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const [seasons, setSeasons] = useState<PtvItem[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);
  const [seasonsRetryNonce, setSeasonsRetryNonce] = useState(0);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<PtvItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [episodesRetryNonce, setEpisodesRetryNonce] = useState(0);
  const [episodeStart, setEpisodeStart] = useState(0);
  const [episodePage, setEpisodePage] = useState(0);
  const seasonSelectorRef = useRef<HTMLDivElement>(null);
  const pendingEpisodeFocus = useRef(false);
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.configureSession(state.serverUrl, userSession.accessToken);
  }, [state.serverUrl, userSession, services.jellyfin]);

  useEffect(() => {
    if (!itemId || !client || !userSession || !cacheKey) return;
    const controller = new AbortController();
    const cached = readMediaMetadata(cacheKey, itemId);
    setItem(cached ?? null);
    setLoading(!cached);
    setError(null);
    setPosterFailed(false);
    setBackdropFailed(false);
    if (seasonSelectorRef.current) seasonSelectorRef.current.scrollLeft = 0;

    void client.getItem(userSession.userId, itemId, DETAIL_FIELDS, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItem(response);
        setItem(mapped);
        writeMediaMetadata(cacheKey, mapped);
        setLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(redactSensitiveText(cause instanceof Error ? cause.message : 'Details are unavailable.'));
      });

    return () => controller.abort('details-route-hidden');
  }, [cacheKey, client, detailsRetryNonce, itemId, userSession]);

  useEffect(() => {
    if (!item || item.type !== 'Series' || !client || !userSession || !cacheKey) {
      setSeasons([]);
      setSelectedSeasonId(null);
      setEpisodes([]);
      return;
    }

    const cachedSeasons = readSeriesSeasons(cacheKey, item.id);
    const rememberedSeason = readSelectedSeriesSeason(cacheKey, item.id);
    if (cachedSeasons) {
      setSeasons(cachedSeasons);
      const selected = rememberedSeason && cachedSeasons.some(season => season.id === rememberedSeason)
        ? rememberedSeason
        : cachedSeasons[0]?.id ?? null;
      setSelectedSeasonId(selected);
      setSeasonsLoading(false);
      setSeasonsError(null);
      return;
    }

    const controller = new AbortController();
    setSeasonsLoading(true);
    setSeasonsError(null);
    void client.getSeasons(userSession.userId, item.id, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response).filter(season => season.type === 'Season');
        setSeasons(mapped);
        writeSeriesSeasons(cacheKey, item.id, mapped);
        const selected = rememberedSeason && mapped.some(season => season.id === rememberedSeason)
          ? rememberedSeason
          : mapped[0]?.id ?? null;
        setSelectedSeasonId(selected);
        if (selected) writeSelectedSeriesSeason(cacheKey, item.id, selected);
        setSeasonsLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setSeasonsLoading(false);
        setSeasonsError(redactSensitiveText(cause instanceof Error ? cause.message : 'Seasons could not be loaded.'));
      });
    return () => controller.abort('series-seasons-hidden');
  }, [cacheKey, client, item, seasonsRetryNonce, userSession]);

  useEffect(() => {
    if (!item || item.type !== 'Series' || !selectedSeasonId || !client || !userSession || !cacheKey) {
      if (!selectedSeasonId) setEpisodes([]);
      return;
    }

    const cached = readSeriesEpisodes(cacheKey, item.id);
    if (cached?.seasonId === selectedSeasonId) {
      setEpisodes(cached.items);
      setEpisodesLoading(false);
      setEpisodesError(null);
      return;
    }

    const controller = new AbortController();
    setEpisodes([]);
    setEpisodeStart(0);
    setEpisodePage(0);
    setEpisodesLoading(true);
    setEpisodesError(null);
    void client.getEpisodes(userSession.userId, item.id, selectedSeasonId, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        const mapped = mapPtvItems(response).filter(episode => episode.type === 'Episode');
        setEpisodes(mapped);
        writeSeriesEpisodes(cacheKey, item.id, selectedSeasonId, mapped);
        setEpisodesLoading(false);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setEpisodesLoading(false);
        setEpisodesError(redactSensitiveText(cause instanceof Error ? cause.message : 'Episodes could not be loaded.'));
      });
    return () => controller.abort('series-episodes-hidden');
  }, [cacheKey, client, episodesRetryNonce, item, selectedSeasonId, userSession]);

  useEffect(() => {
    if (!episodes.length) return;
    const routeId = toRouteString(state.route);
    if (pendingEpisodeFocus.current) {
      pendingEpisodeFocus.current = false;
      const firstOnPage = episodes[episodePage * EPISODE_PAGE_SIZE];
      if (!firstOnPage) return;
      window.requestAnimationFrame(() => {
        services.focusManager.focus(`details-episode-${firstOnPage.id}`, {
          routeId,
          reason: 'direct'
        });
      });
      return;
    }

    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered?.startsWith('details-episode-')) return;
    const rememberedId = remembered.slice('details-episode-'.length);
    const rememberedIndex = episodes.findIndex(episode => episode.id === rememberedId);
    if (rememberedIndex < 0) return;
    const rememberedPage = Math.floor(rememberedIndex / EPISODE_PAGE_SIZE);
    if (rememberedPage !== episodePage) {
      setEpisodePage(rememberedPage);
      setEpisodeStart(Math.max(0, (rememberedIndex % EPISODE_PAGE_SIZE) - 3));
      return;
    }
    services.focusManager.restoreRouteFocus(routeId);
  }, [episodePage, episodes, services.focusManager, state.route]);

  useEffect(() => {
    if (item?.type !== 'Series' || seasons.length === 0) return undefined;
    const routeId = toRouteString(state.route);
    const remembered = services.focusManager.getRememberedRouteFocus(routeId);
    if (!remembered?.startsWith('details-') || remembered.startsWith('details-episode-')) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const currentRemembered = services.focusManager.getRememberedRouteFocus(routeId);
      if (!currentRemembered?.startsWith('details-') || currentRemembered.startsWith('details-episode-')) return;
      services.focusManager.restoreRouteFocus(routeId, 'details-primary');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item, seasons, services.focusManager, state.route]);

  const startPlayback = (playable: PtvItem, restart = false) => {
    if (!isPlayable(playable) || !state.userSession || !state.serverSession) return;
    const intent: PtvPlaybackIntent = {
      kind: playbackKind(playable),
      itemId: playable.id,
      seriesId: playable.type === 'Episode'
        ? playable.seriesId ?? (item?.type === 'Series' ? item.id : undefined)
        : undefined,
      serverId: state.userSession.serverId,
      userId: state.userSession.userId,
      title: playable.name,
      context: playable.type === 'Episode'
        ? [playable.seriesName, episodeLabel(playable)].filter(Boolean).join(' · ')
        : undefined,
      startPositionTicks: restart ? 0 : playable.playbackPositionTicks
    };
    dispatch({ type: 'set_playback_intent', playbackIntent: intent });
    dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent) });
  };

  const selectSeason = (season: PtvItem) => {
    if (!item || item.type !== 'Series' || !cacheKey || season.id === selectedSeasonId) return;
    writeSelectedSeriesSeason(cacheKey, item.id, season.id);
    setSelectedSeasonId(season.id);
    setEpisodeStart(0);
    setEpisodePage(0);
    setEpisodesRetryNonce(0);
    pendingEpisodeFocus.current = true;
  };

  const revealSeason = (button: HTMLButtonElement) => {
    const selector = seasonSelectorRef.current;
    if (!selector) return;
    const safeGutter = 12;
    const buttonLeft = button.offsetLeft;
    const buttonRight = buttonLeft + button.offsetWidth;
    const visibleLeft = selector.scrollLeft;
    const visibleRight = visibleLeft + selector.clientWidth;
    if (buttonLeft < visibleLeft + safeGutter) {
      selector.scrollLeft = Math.max(0, buttonLeft - safeGutter);
    } else if (buttonRight > visibleRight - safeGutter) {
      selector.scrollLeft = Math.max(0, buttonRight - selector.clientWidth + safeGutter);
    }
  };

  const revealEpisode = (index: number) => {
    setEpisodeStart(current => {
      if (index < current) return index;
      if (index >= current + 4) return index - 3;
      return current;
    });
  };

  const changeEpisodePage = (nextPage: number) => {
    const pageCount = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
    if (nextPage < 0 || nextPage >= pageCount || nextPage === episodePage) return;
    pendingEpisodeFocus.current = true;
    setEpisodeStart(0);
    setEpisodePage(nextPage);
  };

  const posterUrl = artworkUrlForItem(client, item, 'poster');
  const backdropUrl = artworkUrlForItem(client, item, 'hero');
  const meta = item ? [
    item.productionYear,
    item.runTimeTicks ? toHms(item.runTimeTicks) : null,
    item.officialRating,
    item.communityRating ? `★ ${item.communityRating.toFixed(1)}` : null
  ].filter(Boolean) : [];
  const episodePageCount = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
  const visibleEpisodes = episodes.slice(
    episodePage * EPISODE_PAGE_SIZE,
    (episodePage + 1) * EPISODE_PAGE_SIZE
  );

  return (
    <LayoutShell title={item?.type === 'Series' ? 'Series details' : 'Movie details'} onBack={() => dispatch({ type: 'go_back' })}>
      <section className={`ptv-details ${item?.type === 'Series' ? 'ptv-details--series' : ''}`}>
        {backdropUrl && !backdropFailed ? (
          <img
            src={backdropUrl}
            alt=""
            className="ptv-details__backdrop"
            onError={() => setBackdropFailed(true)}
          />
        ) : <div className="ptv-details__backdrop ptv-details__backdrop--fallback" aria-hidden="true" />}
        <div className="ptv-details__scrim" aria-hidden="true" />

        <div className="ptv-details__content">
          <div className="ptv-details__summary">
            <div className="ptv-details__poster-wrap">
              {posterUrl && !posterFailed ? (
                <img src={posterUrl} alt="" className="ptv-details-image" onError={() => setPosterFailed(true)} />
              ) : (
                <div className="ptv-details-image ptv-image-placeholder" aria-hidden="true">
                  <span>PTV</span>
                </div>
              )}
            </div>
            <div className="ptv-details__copy">
              <span className="ptv-eyebrow">{item?.type === 'Series' ? 'Series' : item?.type === 'Episode' ? 'Episode' : 'Movie'}</span>
              <h2>{item?.name ?? (loading ? 'Loading…' : 'Unavailable')}</h2>
              {error ? <p className="ptv-error">{error}</p> : null}
              {error && !item ? (
                <FocusableButton
                  focusId="details-primary"
                  preferredRow="details-actions"
                  className="ptv-secondary-action"
                  onClick={() => setDetailsRetryNonce(value => value + 1)}
                >
                  Retry details
                </FocusableButton>
              ) : null}
              {item ? <p className="ptv-details__meta">{meta.join(' · ')}</p> : null}
              {item?.genres?.length ? <p className="ptv-details__genres">{item.genres.slice(0, 4).join('  /  ')}</p> : null}
              <p className="ptv-details__overview">
                {cleanOverview(item?.overview) || (item ? 'No overview available.' : '')}
              </p>

              {item && item.type !== 'Series' && isPlayable(item) ? (
                <div className="ptv-details__actions">
                  <FocusableButton
                    focusId="details-primary"
                    preferredRow="details-actions"
                    className="ptv-primary-action"
                    onClick={() => startPlayback(item)}
                  >
                    {item.playbackPositionTicks ? 'Resume' : 'Play'}
                  </FocusableButton>
                  {item.playbackPositionTicks ? (
                    <FocusableButton
                      focusId="details-restart"
                      preferredRow="details-actions"
                      className="ptv-secondary-action"
                      onClick={() => startPlayback(item, true)}
                    >
                      Restart
                    </FocusableButton>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {item?.type === 'Series' ? (
            <div className="ptv-series-browser">
              <div className="ptv-season-line">
                <h3>Seasons</h3>
                <div ref={seasonSelectorRef} className="ptv-season-selector" role="list" aria-label="Seasons">
                  {seasons.map((season, index) => (
                    <FocusableButton
                      key={season.id}
                      focusId={index === 0 ? 'details-primary' : `details-season-${season.id}`}
                      preferredRow="details-seasons"
                      className={season.id === selectedSeasonId ? 'is-selected' : ''}
                      aria-current={season.id === selectedSeasonId ? 'true' : undefined}
                      onFocus={event => revealSeason(event.currentTarget)}
                      onClick={() => selectSeason(season)}
                    >
                      {season.name}
                    </FocusableButton>
                  ))}
                  {!seasonsLoading && seasons.length === 0 ? (
                    <FocusableButton focusId="details-primary" preferredRow="details-seasons" onClick={() => setSeasonsRetryNonce(value => value + 1)}>
                      Retry seasons
                    </FocusableButton>
                  ) : null}
                </div>
                {seasonsLoading ? <span className="ptv-muted">Loading seasons…</span> : null}
                {seasonsError ? <span className="ptv-error">{seasonsError}</span> : null}
              </div>

              <div className="ptv-episode-line">
                <div className="ptv-episode-line__heading">
                  <h3>Episodes</h3>
                  {episodesLoading ? <span className="ptv-muted">Loading selected season…</span> : null}
                  {episodesError ? <span className="ptv-error">{episodesError}</span> : null}
                  {episodesError ? (
                    <FocusableButton focusId="details-episodes-retry" preferredRow="details-episodes" onClick={() => setEpisodesRetryNonce(value => value + 1)}>
                      Retry
                    </FocusableButton>
                  ) : null}
                  {episodes.length > EPISODE_PAGE_SIZE ? (
                    <div className="ptv-episode-paging" aria-label="Episode pages">
                      <FocusableButton
                        focusId="details-episodes-previous"
                        preferredRow="details-episode-paging"
                        onClick={() => changeEpisodePage(episodePage - 1)}
                        disabled={episodePage === 0}
                      >
                        Previous
                      </FocusableButton>
                      <span>{episodePage + 1} / {episodePageCount}</span>
                      <FocusableButton
                        focusId="details-episodes-next"
                        preferredRow="details-episode-paging"
                        onClick={() => changeEpisodePage(episodePage + 1)}
                        disabled={episodePage + 1 >= episodePageCount}
                      >
                        Next
                      </FocusableButton>
                    </div>
                  ) : null}
                </div>
                <div className="ptv-episode-viewport">
                  <ul className="ptv-episode-grid" style={{ transform: `translate3d(${-episodeStart * 428}px, 0, 0)` }}>
                    {visibleEpisodes.map((episode, index) => (
                      <CardTile
                        key={episode.id}
                        focusId={`details-episode-${episode.id}`}
                        preferredRow="details-episodes"
                        item={episode}
                        variant="episode"
                        posterUrl={artworkUrlForItem(client, episode, 'landscape')}
                        context={episodeLabel(episode)}
                        meta={episode.runTimeTicks ? toHms(episode.runTimeTicks) : null}
                        progressPercent={itemProgress(episode)}
                        watched={Boolean(episode.played)}
                        onFocus={() => revealEpisode(index)}
                        onOpen={() => startPlayback(episode)}
                        lazy
                      />
                    ))}
                  </ul>
                </div>
                {!episodesLoading && !episodesError && episodes.length === 0 ? (
                  <p className="ptv-muted">No episodes are available for this season.</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </LayoutShell>
  );
}
