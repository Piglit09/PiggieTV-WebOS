import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/appContext';
import { LayoutShell } from '../../components/LayoutShell';
import { buildRoute, playbackRouteFromIntent, toRouteString } from '../../navigation/router';
import { canNavigateToDetails, mapPtvItems } from '../../api/jellyfin/mappers';
import { CardTile, type CardVariant } from '../../components/CardTile';
import { FocusableButton } from '../../components/FocusableButton';
import { redactSensitiveText } from '../../core/redaction';
import { artworkUrlForItem } from '../../utils/artwork';
import {
  createHomeCacheSessionKey,
  readHomeCacheSection,
  writeHomeCacheSection,
  type HomeSectionId
} from '../../state/homeCache';
import type { PtvItem, PtvPlaybackIntent } from '../../types/ptv';

interface HomeSectionState {
  id: HomeSectionId;
  title: string;
  variant: CardVariant;
  items: PtvItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  cacheHit: boolean;
}

const HOME_SECTION_DEFINITIONS: ReadonlyArray<{
  id: HomeSectionId;
  title: string;
  variant: CardVariant;
}> = [
  { id: 'continue', title: 'Continue Watching', variant: 'landscape' },
  { id: 'nextup', title: 'Next Up', variant: 'landscape' },
  { id: 'movies', title: 'Recently Added Movies', variant: 'poster' },
  { id: 'shows', title: 'Recently Added Shows', variant: 'poster' }
];

const HOME_MAX_REQUESTS = 3;
const LANDSCAPE_STEP = 354;
const POSTER_STEP = 206;

export function calculateShelfStartIndex(index: number, current: number, visibleCards: number) {
  if (index < current) return index;
  if (index >= current + visibleCards) return index - visibleCards + 1;
  return current;
}

export function calculateHomeVerticalOffset(activeRow: number, viewportHeight = 900) {
  if (activeRow < 0) return 0;
  const rowTops = [388, 710, 1032, 1434];
  const rowHeights = [322, 322, 402, 402];
  const contentHeight = 1836;
  const targetTop = rowTops[activeRow] ?? rowTops[rowTops.length - 1] ?? 0;
  const targetHeight = rowHeights[activeRow] ?? 388;
  const preferredTop = Math.max(0, targetTop - 88);
  const keepBottomVisible = Math.max(0, targetTop + targetHeight - viewportHeight + 28);
  return Math.min(contentHeight - viewportHeight, Math.max(preferredTop, keepBottomVisible));
}

function createHomeSections(key: string | null): HomeSectionState[] {
  return HOME_SECTION_DEFINITIONS.map(definition => {
    const cachedItems = readHomeCacheSection(key, definition.id);
    return {
      ...definition,
      items: cachedItems ?? [],
      loading: cachedItems === undefined,
      refreshing: true,
      error: null,
      cacheHit: cachedItems !== undefined
    };
  });
}

function progressPercent(item: PtvItem) {
  if (!item.playbackPositionTicks || !item.runTimeTicks || item.runTimeTicks <= 0) return null;
  return Math.max(0, Math.min(100, (item.playbackPositionTicks / item.runTimeTicks) * 100));
}

function episodeContext(item: PtvItem) {
  const number = item.parentIndexNumber && item.indexNumber
    ? `S${item.parentIndexNumber} E${item.indexNumber}`
    : item.indexNumber
      ? `Episode ${item.indexNumber}`
      : null;
  return [item.seriesName, number].filter(Boolean).join(' · ') || null;
}

function HomeShelf({
  row,
  rowIndex,
  getArtwork,
  onOpen,
  onActive,
  onRetry,
  onImageError,
  onRender
}: {
  row: HomeSectionState;
  rowIndex: number;
  getArtwork: (item: PtvItem, variant: CardVariant) => string | null;
  onOpen: (item: PtvItem, rowId: HomeSectionId) => void;
  onActive: (rowIndex: number) => void;
  onRetry: (rowId: HomeSectionId) => void;
  onImageError: () => void;
  onRender: (rowId: HomeSectionId) => void;
}) {
  const [startIndex, setStartIndex] = useState(0);
  const landscape = row.variant === 'landscape';
  const visibleCards = landscape ? 5 : 8;
  const step = landscape ? LANDSCAPE_STEP : POSTER_STEP;

  useEffect(() => onRender(row.id));

  useEffect(() => {
    if (startIndex >= row.items.length) setStartIndex(Math.max(0, row.items.length - visibleCards));
  }, [row.items.length, startIndex, visibleCards]);

  const reveal = (index: number) => {
    onActive(rowIndex);
    setStartIndex(current => calculateShelfStartIndex(index, current, visibleCards));
  };

  return (
    <section className={`ptv-home-row ptv-home-row--${row.variant}`} aria-label={row.title}>
      <div className="ptv-home-row__heading">
        <h2>{row.title}</h2>
        {row.refreshing && row.items.length ? <span>Updating</span> : null}
      </div>

      {row.loading && row.items.length === 0 ? (
        <div className={`ptv-skeleton-row ptv-skeleton-row--${row.variant}`} aria-label={`Loading ${row.title}`}>
          {Array.from({ length: landscape ? 5 : 8 }, (_, index) => <span key={index} />)}
        </div>
      ) : null}

      {row.error && row.items.length === 0 ? (
        <div className="ptv-home-row__empty ptv-home-row__empty--error">
          <span>{row.error}</span>
          <FocusableButton
            focusId={`home-retry-${row.id}`}
            preferredRow={`home-${row.id}`}
            onFocus={() => onActive(rowIndex)}
            onClick={() => onRetry(row.id)}
          >
            Retry
          </FocusableButton>
        </div>
      ) : null}

      {!row.loading && !row.error && row.items.length === 0 ? (
        <p className="ptv-home-row__empty ptv-muted">Nothing to show yet.</p>
      ) : null}

      {row.items.length ? (
        <div className="ptv-shelf-viewport">
          <ul
            className="ptv-row-grid"
            style={{ transform: `translate3d(${-startIndex * step}px, 0, 0)` }}
          >
            {row.items.slice(0, 16).map((item, index) => (
              <CardTile
                key={`${row.id}-${item.id}`}
                focusId={`home-${row.id}-${item.id}`}
                preferredRow={`home-${row.id}`}
                item={item}
                variant={row.variant}
                onFocus={() => reveal(index)}
                onOpen={() => onOpen(item, row.id)}
                posterUrl={getArtwork(item, row.variant)}
                context={row.variant === 'landscape' ? episodeContext(item) : null}
                meta={row.variant === 'poster' && item.productionYear ? String(item.productionYear) : null}
                progressPercent={progressPercent(item)}
                watched={Boolean(item.played)}
                lazy
                onImageError={onImageError}
              />
            ))}
          </ul>
          {row.error ? (
            <FocusableButton
              focusId={`home-retry-${row.id}`}
              preferredRow={`home-${row.id}`}
              className="ptv-home-row__retry-overlay"
              onFocus={() => onActive(rowIndex)}
              onClick={() => onRetry(row.id)}
            >
              Refresh failed · Retry
            </FocusableButton>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function HomeScreen() {
  const { state, dispatch, services } = useApp();
  const userSession = state.userSession;
  const homeCacheKey = createHomeCacheSessionKey(state.serverUrl, userSession);
  const [sections, setSections] = useState<HomeSectionState[]>(() => createHomeSections(homeCacheKey));
  const [activeRow, setActiveRow] = useState(-1);
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const [heroBackdropFailed, setHeroBackdropFailed] = useState(false);
  const [heroLogoFailed, setHeroLogoFailed] = useState(false);
  const retryRef = useRef<(rowId: HomeSectionId) => void>(() => undefined);
  const imageFailuresRef = useRef(0);
  const attemptIdRef = useRef<string | null>(null);
  const renderCountsRef = useRef<Record<HomeSectionId, number>>({ continue: 0, nextup: 0, movies: 0, shows: 0 });
  const client = useMemo(() => {
    if (!state.serverUrl || !userSession) return null;
    return services.jellyfin.getAuthenticatedClient();
  }, [state.serverUrl, userSession, services.jellyfin]);

  const getArtwork = useCallback((item: PtvItem, variant: CardVariant) => (
    artworkUrlForItem(client, item, variant === 'poster' ? 'poster' : 'landscape')
  ), [client]);

  useEffect(() => {
    if (!client || !userSession || !homeCacheKey) return;
    let active = true;
    const controller = new AbortController();
    const queued = HOME_SECTION_DEFINITIONS.map(section => section.id);
    const running = new Set<HomeSectionId>();
    let activeRequests = 0;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () => Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
    services.diagnostics.synchronizeHomePerformanceSession(homeCacheKey);
    const attemptId = services.diagnostics.beginHomePerformanceAttempt();
    attemptIdRef.current = attemptId;
    imageFailuresRef.current = 0;
    renderCountsRef.current = { continue: 0, nextup: 0, movies: 0, shows: 0 };

    const initialSections = createHomeSections(homeCacheKey);
    setSections(initialSections);
    if (attemptId) {
      const firstCachedContent = initialSections.some(section => section.cacheHit && section.items.length > 0);
      services.diagnostics.recordHomePerformance({
        attemptId,
        usableMs: firstCachedContent ? 0 : null,
        firstPopulatedMs: firstCachedContent ? 0 : null,
        rows: Object.fromEntries(initialSections.map(section => [section.id, {
          cache: section.cacheHit ? 'hit' : 'miss'
        }]))
      });
    }

    const loadSection = async (sectionId: HomeSectionId) => {
      const rowStartedAt = elapsed();
      try {
        let response: { Items: Array<Record<string, unknown>> };
        if (sectionId === 'continue') {
          response = await client.getResume(userSession.userId, 'Movie,Episode', 16, controller.signal);
        } else if (sectionId === 'nextup') {
          response = await client.getNextUp(userSession.userId, 16, controller.signal);
        } else if (sectionId === 'movies') {
          response = await client.getRecentlyAdded(userSession.userId, 'Movie', 16, controller.signal);
        } else {
          response = await client.getRecentlyAdded(userSession.userId, 'Series', 16, controller.signal);
        }
        if (!active || controller.signal.aborted) return;
        const items = mapPtvItems(response, {
          excludeEmptyVideoContainers: sectionId === 'shows'
        });
        writeHomeCacheSection(homeCacheKey, sectionId, items);
        setSections(previous => previous.map(section => section.id === sectionId ? {
          ...section,
          items,
          loading: false,
          refreshing: false,
          error: null
        } : section));
        if (attemptId) {
          const durationMs = Math.max(0, elapsed() - rowStartedAt);
          services.diagnostics.recordHomePerformance({
            attemptId,
            usableMs: items.length ? elapsed() : null,
            firstPopulatedMs: items.length ? elapsed() : null,
            rows: { [sectionId]: { durationMs, outcome: 'success' } }
          });
        }
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        const message = cause instanceof Error
          ? cause.message
          : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
            ? cause.message
            : 'This shelf could not be loaded.';
        setSections(previous => previous.map(section => section.id === sectionId ? {
          ...section,
          loading: false,
          refreshing: false,
          error: redactSensitiveText(message)
        } : section));
        if (attemptId) {
          services.diagnostics.recordHomePerformance({
            attemptId,
            rows: { [sectionId]: { durationMs: Math.max(0, elapsed() - rowStartedAt), outcome: 'error' } }
          });
        }
      }
    };

    const pump = () => {
      while (active && !controller.signal.aborted && activeRequests < HOME_MAX_REQUESTS) {
        const sectionId = queued.shift();
        if (!sectionId) return;
        if (running.has(sectionId)) continue;
        running.add(sectionId);
        activeRequests += 1;
        if (attemptId) services.diagnostics.recordHomePerformance({ attemptId, maxActiveRequests: activeRequests });
        void loadSection(sectionId).finally(() => {
          running.delete(sectionId);
          activeRequests = Math.max(0, activeRequests - 1);
          pump();
          if (attemptId && active && activeRequests === 0 && queued.length === 0) {
            services.diagnostics.recordHomePerformance({ attemptId, status: 'complete' });
          }
        });
      }
    };

    retryRef.current = rowId => {
      if (!active || running.has(rowId) || queued.includes(rowId)) return;
      setSections(previous => previous.map(section => section.id === rowId ? {
        ...section,
        loading: section.items.length === 0,
        refreshing: section.items.length > 0,
        error: null
      } : section));
      queued.push(rowId);
      pump();
    };

    pump();
    return () => {
      active = false;
      retryRef.current = () => undefined;
      if (attemptId) {
        const cancelledRows = Object.fromEntries(
          HOME_SECTION_DEFINITIONS
            .filter(section => running.has(section.id) || queued.includes(section.id))
            .map(section => [section.id, { outcome: 'cancelled' as const }])
        );
        services.diagnostics.recordHomePerformance({
          attemptId,
          status: 'route-hidden',
          imageFailures: imageFailuresRef.current,
          rows: cancelledRows
        });
      }
      if (attemptIdRef.current === attemptId) attemptIdRef.current = null;
      controller.abort('home-route-hidden');
    };
  }, [client, homeCacheKey, services.diagnostics, userSession]);

  const recordShelfRender = useCallback((rowId: HomeSectionId) => {
    const attemptId = attemptIdRef.current;
    if (!attemptId) return;
    const nextCount = renderCountsRef.current[rowId] + 1;
    renderCountsRef.current[rowId] = nextCount;
    services.diagnostics.recordHomePerformance({
      attemptId,
      rows: { [rowId]: { renderCount: nextCount } }
    });
  }, [services.diagnostics]);

  const recordImageFailure = useCallback(() => {
    imageFailuresRef.current += 1;
    const attemptId = attemptIdRef.current;
    if (attemptId) {
      services.diagnostics.recordHomePerformance({ attemptId, imageFailures: imageFailuresRef.current });
    }
  }, [services.diagnostics]);

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

  const playableItems = [
    ...(sections.find(row => row.id === 'continue')?.items ?? []),
    ...(sections.find(row => row.id === 'nextup')?.items ?? []),
    ...(sections.find(row => row.id === 'movies')?.items ?? [])
  ];
  const firstPlayable = playableItems.find(item => item.type === 'Movie' || item.type === 'Episode') ?? null;
  const selectedFeaturedItem = playableItems.find(item => item.id === featuredId) ?? null;
  const featuredItem = selectedFeaturedItem ?? firstPlayable;
  useEffect(() => {
    if (!featuredId && firstPlayable) setFeaturedId(firstPlayable.id);
    if (featuredId && !selectedFeaturedItem && firstPlayable) setFeaturedId(firstPlayable.id);
  }, [featuredId, firstPlayable, selectedFeaturedItem]);
  const heroBackdrop = artworkUrlForItem(client, featuredItem, 'hero');
  const heroLogo = artworkUrlForItem(client, featuredItem, 'logo');
  useEffect(() => {
    setHeroBackdropFailed(false);
    setHeroLogoFailed(false);
  }, [featuredItem?.id, heroBackdrop, heroLogo]);

  const startPlayback = (item: PtvItem, restart = false) => {
    if (!state.userSession || !state.serverSession || (item.type !== 'Movie' && item.type !== 'Episode')) return;
    const intent: PtvPlaybackIntent = {
      kind: item.type === 'Episode' ? 'episode' : 'movie',
      itemId: item.id,
      seriesId: item.type === 'Episode' ? item.seriesId : undefined,
      serverId: state.userSession.serverId,
      userId: state.userSession.userId,
      title: item.name,
      context: episodeContext(item) ?? undefined,
      startPositionTicks: restart ? 0 : item.playbackPositionTicks
    };
    dispatch({ type: 'set_playback_intent', playbackIntent: intent });
    dispatch({ type: 'set_route', route: playbackRouteFromIntent(intent) });
  };

  const openItem = (item: PtvItem, rowId?: HomeSectionId) => {
    if (!canNavigateToDetails(item)) return;
    dispatch({ type: 'set_route', route: buildRoute('details', item.id, rowId ?? null) });
  };

  const verticalOffset = calculateHomeVerticalOffset(activeRow);

  return (
    <LayoutShell title="Home" currentSection="home">
      <section className="ptv-home">
        <div className="ptv-home__track" style={{ transform: `translate3d(0, ${-verticalOffset}px, 0)` }}>
          {featuredItem ? (
            <section className="ptv-hero" aria-label="Featured">
              {heroBackdrop && !heroBackdropFailed ? (
                <img
                  src={heroBackdrop}
                  className="ptv-hero__art"
                  alt=""
                  aria-hidden="true"
                  onError={() => {
                    setHeroBackdropFailed(true);
                    recordImageFailure();
                  }}
                />
              ) : <div className="ptv-hero__art ptv-hero__art--fallback" aria-hidden="true" />}
              <div className="ptv-hero__scrim" aria-hidden="true" />
              <div className="ptv-hero__content">
                <span className="ptv-eyebrow">Featured on PTV</span>
                {heroLogo && !heroLogoFailed ? (
                  <img
                    src={heroLogo}
                    alt={featuredItem.name}
                    className="ptv-hero__logo"
                    onError={() => {
                      setHeroLogoFailed(true);
                      recordImageFailure();
                    }}
                  />
                ) : <h2>{featuredItem.name}</h2>}
                <p className="ptv-hero__meta">
                  {[featuredItem.productionYear, featuredItem.officialRating, episodeContext(featuredItem)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {featuredItem.overview ? <p className="ptv-hero__overview">{featuredItem.overview}</p> : null}
                <div className="ptv-hero__actions">
                  <FocusableButton
                    focusId="home-hero-play"
                    preferredRow="home-hero"
                    className="ptv-primary-action"
                    onFocus={() => setActiveRow(-1)}
                    onClick={() => startPlayback(featuredItem)}
                  >
                    {featuredItem.playbackPositionTicks ? 'Resume' : 'Play'}
                  </FocusableButton>
                  <FocusableButton
                    focusId="home-hero-details"
                    preferredRow="home-hero"
                    className="ptv-secondary-action"
                    onFocus={() => setActiveRow(-1)}
                    onClick={() => openItem(featuredItem)}
                  >
                    Details
                  </FocusableButton>
                </div>
              </div>
            </section>
          ) : <div className="ptv-hero ptv-hero--loading" aria-hidden="true" />}

          <div className="ptv-home__rows">
            {sections.map((row, rowIndex) => (
              <HomeShelf
                key={row.id}
                row={row}
                rowIndex={rowIndex}
                getArtwork={getArtwork}
                onOpen={openItem}
                onActive={setActiveRow}
                onRetry={rowId => retryRef.current(rowId)}
                onImageError={recordImageFailure}
                onRender={recordShelfRender}
              />
            ))}
          </div>
        </div>
      </section>
    </LayoutShell>
  );
}
