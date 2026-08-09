import type { JellyfinApiClient } from '../api/jellyfin/client';
import type { PtvItem } from '../types/ptv';

export type ArtworkPurpose = 'poster' | 'landscape' | 'hero' | 'logo';

type ImageClient = Pick<JellyfinApiClient, 'getImageUrl'>;

export function artworkUrlForItem(client: ImageClient | null, item: PtvItem | null, purpose: ArtworkPurpose) {
  if (!client || !item) return null;
  const tags = item.imageTags ?? {};
  const backdropTag = item.backdropImageTags?.[0] ?? tags.Backdrop;

  if (purpose === 'logo') {
    return tags.Logo ? client.getImageUrl(item.id, 'Logo', tags.Logo, { maxWidth: 760, quality: 90 }) : null;
  }
  if (purpose === 'hero') {
    if (backdropTag) return client.getImageUrl(item.id, 'Backdrop', backdropTag, { maxWidth: 1920, quality: 88 });
    if (tags.Thumb) return client.getImageUrl(item.id, 'Thumb', tags.Thumb, { maxWidth: 1920, quality: 86 });
    if (tags.Primary) return client.getImageUrl(item.id, 'Primary', tags.Primary, { maxWidth: 1920, quality: 86 });
    return null;
  }
  if (purpose === 'landscape') {
    if (tags.Thumb) return client.getImageUrl(item.id, 'Thumb', tags.Thumb, { maxWidth: 520, quality: 80 });
    if (backdropTag) return client.getImageUrl(item.id, 'Backdrop', backdropTag, { maxWidth: 520, quality: 80 });
    if (tags.Primary) return client.getImageUrl(item.id, 'Primary', tags.Primary, { maxWidth: 520, quality: 80 });
    return null;
  }

  if (tags.Primary) return client.getImageUrl(item.id, 'Primary', tags.Primary, { maxWidth: 360, quality: 82 });
  if (tags.Poster) return client.getImageUrl(item.id, 'Poster', tags.Poster, { maxWidth: 360, quality: 82 });
  if (tags.Thumb) return client.getImageUrl(item.id, 'Thumb', tags.Thumb, { maxWidth: 360, quality: 80 });
  return null;
}
