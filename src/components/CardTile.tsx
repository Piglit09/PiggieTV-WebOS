import React, { useEffect, useRef, useState } from 'react';
import type { PtvItem } from '../types/ptv';
import { FocusableButton } from './FocusableButton';

export type CardVariant = 'poster' | 'landscape' | 'episode';

function placeholderLabel(item: PtvItem) {
  if (item.type === 'Episode') return 'EP';
  if (item.type === 'Series') return 'TV';
  if (item.type === 'Movie') return 'MOV';
  if (item.type === 'Unknown' && item.mediaType?.toLowerCase() === 'audio') return 'SNG';
  if (item.type === 'Audio') return 'SNG';
  if (item.type === 'MusicAlbum') return 'ALB';
  if (item.type === 'MusicArtist') return 'ART';
  if (item.type === 'MusicVideo') return 'MV';
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
  onImageError?: () => void;
  onImageLoad?: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [revealedImageUrl, setRevealedImageUrl] = useState<string | null>(() => lazy ? null : posterUrl ?? null);
  const artworkRef = useRef<HTMLSpanElement>(null);
  const safeProgress = typeof progressPercent === 'number' && Number.isFinite(progressPercent)
    ? Math.max(0, Math.min(100, progressPercent))
    : null;

  useEffect(() => {
    setImageFailed(false);
    if (!posterUrl) {
      setRevealedImageUrl(null);
      return undefined;
    }
    if (!lazy || typeof IntersectionObserver === 'undefined') {
      setRevealedImageUrl(posterUrl);
      return undefined;
    }

    const artwork = artworkRef.current;
    if (!artwork) return undefined;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) return;
      setRevealedImageUrl(posterUrl);
      observer.disconnect();
    }, { rootMargin: '320px 0px' });
    observer.observe(artwork);
    return () => observer.disconnect();
  }, [lazy, posterUrl]);

  const imageReady = Boolean(posterUrl) && revealedImageUrl === posterUrl && !imageFailed;

  return (
    <li className={`ptv-card ptv-card--${variant}`}>
      <FocusableButton
        focusId={focusId}
        preferredRow={preferredRow}
        onClick={onOpen}
        onFocus={onFocus}
        className="ptv-card-btn"
        aria-label={[item.name, context, meta].filter(Boolean).join(', ')}
      >
        <span ref={artworkRef} className="ptv-card-art">
          {imageReady ? (
            <img
              src={posterUrl ?? undefined}
              alt=""
              decoding="async"
              onLoad={onImageLoad}
              onError={() => {
                setImageFailed(true);
                onImageError?.();
              }}
            />
          ) : (
            <span className="ptv-card-placeholder" aria-hidden="true">
              <span className="ptv-card-placeholder__mark">PTV</span>
              <span className="ptv-card-placeholder__type">{placeholderLabel(item)}</span>
            </span>
          )}
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
