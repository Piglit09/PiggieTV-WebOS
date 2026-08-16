import React, { useEffect, useRef, useState } from 'react';
import type { PtvItem } from '../types/ptv';
import type { ArtworkLoadPermit, ArtworkLoadScheduler } from '../utils/artworkLoadScheduler';
import { FocusableButton } from './FocusableButton';

export type CardVariant = 'poster' | 'landscape' | 'episode';
export type CardPlaceholderVariant = 'default' | 'subtle';

const ARTWORK_LOAD_TIMEOUT_MS = 20_000;

function placeholderLabel(item: PtvItem) {
  if (item.type === 'Episode') return 'EP';
  if (item.type === 'Series') return 'TV';
  if (item.type === 'Movie') return 'MOV';
  if (item.type === 'Unknown' && item.mediaType?.toLowerCase() === 'audio') return 'SNG';
  if (item.type === 'Audio') return 'SNG';
  if (item.type === 'MusicAlbum') return 'ALB';
  if (item.type === 'MusicArtist') return 'ART';
  if (item.type === 'MusicVideo') return 'MV';
  if (item.type === 'Genre') return 'GEN';
  if (item.type === 'MusicGenre') return 'MGEN';
  if (item.type === 'Studio') return 'STD';
  if (item.type === 'Collection') return 'COL';
  if (item.type === 'Book') return 'READ';
  return 'PTV';
}

export function CardTile({
  item,
  focusId,
  onOpen,
  posterUrl,
  preferredRow,
  onFocus,
  variant = 'poster',
  context,
  meta,
  progressPercent,
  watched = false,
  lazy = false,
  lazyRootRef,
  lazyRootMargin = '320px 0px',
  fadeArtwork = false,
  placeholderVariant = 'default',
  artworkLoadScheduler,
  onImageError,
  onImageLoad
}: {
  item: PtvItem;
  focusId: string;
  onOpen: () => void;
  posterUrl?: string | null;
  preferredRow?: string;
  onFocus?: () => void;
  variant?: CardVariant;
  context?: string | null;
  meta?: string | null;
  progressPercent?: number | null;
  watched?: boolean;
  lazy?: boolean;
  lazyRootRef?: React.RefObject<Element>;
  lazyRootMargin?: string;
  fadeArtwork?: boolean;
  placeholderVariant?: CardPlaceholderVariant;
  artworkLoadScheduler?: ArtworkLoadScheduler;
  onImageError?: () => void;
  onImageLoad?: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [revealedImageUrl, setRevealedImageUrl] = useState<string | null>(() => lazy ? null : posterUrl ?? null);
  const artworkRef = useRef<HTMLSpanElement>(null);
  const artworkLoadPermitRef = useRef<ArtworkLoadPermit | null>(null);
  const artworkLoadTimeoutRef = useRef<number | null>(null);
  const onImageErrorRef = useRef(onImageError);
  onImageErrorRef.current = onImageError;
  const safeProgress = typeof progressPercent === 'number' && Number.isFinite(progressPercent)
    ? Math.max(0, Math.min(100, progressPercent))
    : null;

  useEffect(() => {
    setImageFailed(false);
    if (artworkLoadTimeoutRef.current !== null) {
      window.clearTimeout(artworkLoadTimeoutRef.current);
      artworkLoadTimeoutRef.current = null;
    }
    artworkLoadPermitRef.current?.cancel();
    artworkLoadPermitRef.current = null;

    if (!posterUrl) {
      setRevealedImageUrl(null);
      return undefined;
    }

    const revealArtwork = () => {
      if (!artworkLoadScheduler) {
        setRevealedImageUrl(posterUrl);
        return;
      }

      const permit = artworkLoadScheduler.schedule(() => {
        setRevealedImageUrl(posterUrl);
        artworkLoadTimeoutRef.current = window.setTimeout(() => {
          setImageFailed(true);
          artworkLoadPermitRef.current?.release();
          artworkLoadPermitRef.current = null;
          artworkLoadTimeoutRef.current = null;
          onImageErrorRef.current?.();
        }, ARTWORK_LOAD_TIMEOUT_MS);
      });
      artworkLoadPermitRef.current = permit;
    };

    let observer: IntersectionObserver | null = null;
    if (!lazy || typeof IntersectionObserver === 'undefined') {
      revealArtwork();
    } else {
      const artwork = artworkRef.current;
      if (!artwork) return undefined;
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) return;
        revealArtwork();
        observer?.disconnect();
      }, {
        root: lazyRootRef?.current ?? null,
        rootMargin: lazyRootMargin
      });
      observer.observe(artwork);
    }

    return () => {
      observer?.disconnect();
      if (artworkLoadTimeoutRef.current !== null) {
        window.clearTimeout(artworkLoadTimeoutRef.current);
        artworkLoadTimeoutRef.current = null;
      }
      artworkLoadPermitRef.current?.cancel();
      artworkLoadPermitRef.current = null;
    };
  }, [artworkLoadScheduler, lazy, lazyRootMargin, lazyRootRef, posterUrl]);

  const imageRequested = Boolean(posterUrl) && revealedImageUrl === posterUrl && !imageFailed;

  const finishArtworkRequest = () => {
    if (artworkLoadTimeoutRef.current !== null) {
      window.clearTimeout(artworkLoadTimeoutRef.current);
      artworkLoadTimeoutRef.current = null;
    }
    artworkLoadPermitRef.current?.release();
    artworkLoadPermitRef.current = null;
  };

  return (
    <li className={`ptv-card ptv-card--${variant}`}>
      <FocusableButton
        focusId={focusId}
        preferredRow={preferredRow}
        onClick={onOpen}
        onFocus={() => {
          artworkLoadPermitRef.current?.prioritize();
          onFocus?.();
        }}
        className="ptv-card-btn"
        aria-label={[item.name, context, meta].filter(Boolean).join(', ')}
      >
        <span ref={artworkRef} className="ptv-card-art">
          {!imageRequested || fadeArtwork ? (
            <span
              className={`ptv-card-placeholder ${placeholderVariant === 'subtle' ? 'ptv-card-placeholder--subtle' : ''}`.trim()}
              aria-hidden="true"
            >
              <span className="ptv-card-placeholder__mark">PTV</span>
              <span className="ptv-card-placeholder__type">{placeholderLabel(item)}</span>
            </span>
          ) : null}
          {imageRequested ? (
            <img
              key={posterUrl ?? undefined}
              className={`ptv-card-art__image ${fadeArtwork ? 'ptv-card-art__image--fade' : ''}`.trim()}
              src={posterUrl ?? undefined}
              alt=""
              decoding="async"
              draggable={false}
              data-image-state={fadeArtwork ? 'loading' : undefined}
              onLoad={event => {
                if (fadeArtwork) {
                  event.currentTarget.classList.add('is-loaded');
                  event.currentTarget.setAttribute('data-image-state', 'loaded');
                }
                finishArtworkRequest();
                onImageLoad?.();
              }}
              onError={event => {
                event.currentTarget.setAttribute('data-image-state', 'error');
                setImageFailed(true);
                finishArtworkRequest();
                onImageError?.();
              }}
            />
          ) : null}
          {watched ? <span className="ptv-card-watched" aria-label="Watched">✓</span> : null}
          {safeProgress !== null && safeProgress > 0 ? (
            <span className="ptv-card-progress" aria-hidden="true">
              <span style={{ width: `${safeProgress}%` }} />
            </span>
          ) : null}
        </span>
        <span className="ptv-card-copy">
          {context ? <span className="ptv-card-context">{context}</span> : null}
          <span className="ptv-card-title">{item.name}</span>
          {meta ? <span className="ptv-card-meta">{meta}</span> : null}
        </span>
      </FocusableButton>
    </li>
  );
}
