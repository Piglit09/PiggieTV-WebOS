export type MusicRecommendationSurface =
  | 'home'
  | 'made-for-you'
  | 'radio'
  | 'related'
  | 'discovery';

export interface MusicRecommendationPolicy {
  discoveryTarget: number;
  familiarTarget: number;
  maxConsecutiveAlbum: number;
  maxConsecutiveArtist: number;
  maxItemsPerAlbum: number;
  maxItemsPerArtist: number;
}

export const MUSIC_RECOMMENDATION_POLICY_VERSION = 'music-premium-v2';

export const MUSIC_RECOMMENDATION_SURFACE_POLICIES: Readonly<
  Record<MusicRecommendationSurface, Readonly<MusicRecommendationPolicy>>
> = Object.freeze({
  home: policy(0.3, 0.7, 3, 2, 2, 2),
  'made-for-you': policy(0.3, 0.7, 3, 2, 2, 2),
  radio: policy(0.75, 0.25, 3, 2, 2, 2),
  related: policy(0.4, 0.6, 3, 2, 2, 2),
  discovery: policy(0.8, 0.2, 2, 1, 1, 1)
});

export function policyForSurface(surface: MusicRecommendationSurface | undefined) {
  return MUSIC_RECOMMENDATION_SURFACE_POLICIES[surface ?? 'radio'];
}

function policy(
  discoveryTarget: number,
  familiarTarget: number,
  maxItemsPerArtist: number,
  maxItemsPerAlbum: number,
  maxConsecutiveArtist: number,
  maxConsecutiveAlbum: number
): Readonly<MusicRecommendationPolicy> {
  return Object.freeze({
    discoveryTarget,
    familiarTarget,
    maxConsecutiveAlbum,
    maxConsecutiveArtist,
    maxItemsPerAlbum,
    maxItemsPerArtist
  });
}
