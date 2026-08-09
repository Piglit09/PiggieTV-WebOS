import type { PtvItem, PtvItemKind } from '../types/ptv';
import {
  policyForSurface,
  type MusicRecommendationSurface
} from './policy';

export interface RelatedRankingOptions {
  /** Maximum number of recommendations to return. */
  limit?: number;
  /** Stable per-session value used to vary otherwise equal recommendations. */
  sessionSeed?: string;
  /** Watched/played candidates are excluded by default. */
  excludePlayed?: boolean;
  /** Additional item ids that must not be returned. */
  excludeItemIds?: Iterable<string>;
  /** Hard cap for music artists in related results. */
  maxItemsPerArtist?: number;
  /** Hard cap for music albums in related results. */
  maxItemsPerAlbum?: number;
  /** Maximum adjacent items sharing an artist. */
  maxConsecutiveArtist?: number;
  /** Maximum adjacent items sharing an album. */
  maxConsecutiveAlbum?: number;
}

export interface MusicMixRankingOptions extends RelatedRankingOptions {
  /** Include an audio seed as the first queue entry while still excluding duplicate seed candidates. */
  includeSeedFirst?: boolean;
  /** Hard cap across the returned mix. Candidates without artist metadata are uncapped. */
  maxTracksPerArtist?: number;
  /** Hard cap across the returned mix. Candidates without album metadata are uncapped. */
  maxTracksPerAlbum?: number;
  /** Recommendation intent controls the familiar/discovery blend. */
  surface?: MusicRecommendationSurface;
  /** Optional experiment override for the familiar share. */
  familiarRatio?: number;
}

interface RankedCandidate {
  item: PtvItem;
  score: number;
  tieBreaker: number;
  identity: string;
}

const DEFAULT_RELATED_LIMIT = 24;
const DEFAULT_MIX_LIMIT = 25;
const DEFAULT_MAX_TRACKS_PER_ARTIST = 3;
const DEFAULT_MAX_TRACKS_PER_ALBUM = 2;

const TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with'
]);

function normalizeText(value: string | undefined) {
  return value
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() ?? '';
}

function normalizedValues(values: Iterable<string | undefined>) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function titleTokens(item: PtvItem) {
  return new Set(
    normalizeText(item.name)
      .split(' ')
      .filter(token => token.length > 1 && !TITLE_STOP_WORDS.has(token))
  );
}

function normalizedGenres(item: PtvItem) {
  return normalizedValues(item.genres ?? []);
}

function musicArtists(item: PtvItem) {
  const values: Array<string | undefined> = [...(item.artists ?? []), item.albumArtist];
  if (item.type === 'MusicArtist') values.unshift(item.name);
  return normalizedValues(values);
}

function albumId(item: PtvItem) {
  if (item.type === 'MusicAlbum') return item.id;
  return item.albumId?.trim() || undefined;
}

function albumName(item: PtvItem) {
  return normalizeText(item.type === 'MusicAlbum' ? item.name : item.album);
}

function musicAlbumKey(item: PtvItem) {
  const itemAlbumId = albumId(item);
  return itemAlbumId ? `id:${itemAlbumId}` : albumName(item);
}

function intersectionSize(left: Iterable<string>, right: Iterable<string>) {
  const rightSet = right instanceof Set ? right : new Set(right);
  let count = 0;
  for (const value of left) {
    if (rightSet.has(value)) count += 1;
  }
  return count;
}

function overlapRatio(left: Iterable<string>, right: Iterable<string>) {
  const leftSet = left instanceof Set ? left : new Set(left);
  const rightSet = right instanceof Set ? right : new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  const intersection = intersectionSize(leftSet, rightSet);
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function hash32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tieBreaker(sessionSeed: string | undefined, item: PtvItem) {
  let hash = hash32(item.id) ^ hash32(sessionSeed ?? '');
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}

function positiveInteger(value: number | undefined, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function compareRanked(left: RankedCandidate, right: RankedCandidate) {
  if (left.score !== right.score) return right.score - left.score;
  if (left.tieBreaker !== right.tieBreaker) return left.tieBreaker - right.tieBreaker;
  if (left.item.id < right.item.id) return -1;
  if (left.item.id > right.item.id) return 1;
  return 0;
}

function mediaFamily(type: PtvItemKind) {
  if (type === 'Movie' || type === 'Series' || type === 'Episode' || type === 'Season') {
    return 'video';
  }
  if (type === 'Audio' || type === 'MusicAlbum' || type === 'MusicArtist' || type === 'MusicVideo' || type === 'Playlist') {
    return 'music';
  }
  if (type === 'Book') return 'reading';
  return type;
}

function relatedIdentity(item: PtvItem) {
  const name = normalizeText(item.name);
  const artists = musicArtists(item);
  if (item.type === 'Audio' && name && artists[0]) {
    return `audio:${artists[0]}:${name}`;
  }
  if (item.type === 'MusicAlbum' && name && artists[0]) {
    return `album:${artists[0]}:${name}`;
  }
  if (item.type === 'Episode' && item.seriesId && item.parentIndexNumber !== undefined && item.indexNumber !== undefined) {
    return `episode:${item.seriesId}:${item.parentIndexNumber}:${item.indexNumber}`;
  }
  if (
    (item.type === 'Movie' || item.type === 'Series' || item.type === 'Book')
    && name
    && item.productionYear !== undefined
  ) {
    return `${item.type}:${name}:${item.productionYear}`;
  }
  return `id:${item.id}`;
}

function musicTrackIdentity(item: PtvItem) {
  const name = normalizeText(item.name);
  const artist = musicArtists(item)[0];
  if (name && artist) return `track:${artist}:${name}`;
  return `id:${item.id}`;
}

function commonRelationshipScore(seed: PtvItem, candidate: PtvItem) {
  let score = 0;

  if (seed.seriesId && candidate.seriesId && seed.seriesId === candidate.seriesId) score += 80;
  if (seed.id === candidate.seriesId || candidate.id === seed.seriesId) score += 55;
  if (seed.parentId && candidate.parentId && seed.parentId === candidate.parentId) score += 35;

  const seedArtists = musicArtists(seed);
  const candidateArtists = musicArtists(candidate);
  const sharedArtists = intersectionSize(seedArtists, candidateArtists);
  score += sharedArtists * 34;

  const seedAlbumId = albumId(seed);
  const candidateAlbumId = albumId(candidate);
  if (seedAlbumId && candidateAlbumId && seedAlbumId === candidateAlbumId) score += 42;
  else {
    const seedAlbumName = albumName(seed);
    const candidateAlbumName = albumName(candidate);
    if (seedAlbumName && candidateAlbumName && seedAlbumName === candidateAlbumName) score += 25;
  }

  const seedGenres = normalizedGenres(seed);
  const candidateGenres = normalizedGenres(candidate);
  score += intersectionSize(seedGenres, candidateGenres) * 15;
  score += overlapRatio(seedGenres, candidateGenres) * 10;

  score += overlapRatio(titleTokens(seed), titleTokens(candidate)) * 12;

  if (seed.productionYear !== undefined && candidate.productionYear !== undefined) {
    const distance = Math.abs(seed.productionYear - candidate.productionYear);
    if (distance <= 1) score += 8;
    else if (distance <= 3) score += 5;
    else if (distance <= 10) score += 2;
  }

  return score;
}

function userSignalScore(item: PtvItem) {
  let score = 0;
  if (item.favorite) score += 8;
  if (item.played) score -= 18;
  if ((item.playbackPositionTicks ?? 0) > 0) score -= 4;
  if (typeof item.communityRating === 'number') {
    score += Math.max(0, Math.min(10, item.communityRating)) * 0.5;
  }
  return score;
}

function relatedScore(seed: PtvItem, candidate: PtvItem) {
  let score = commonRelationshipScore(seed, candidate);
  if (seed.type === candidate.type) score += 40;
  else if (mediaFamily(seed.type) === mediaFamily(candidate.type)) score += 16;
  return score + userSignalScore(candidate);
}

function musicAffinity(seed: PtvItem, candidate: PtvItem) {
  let affinity = 0;
  const seedArtists = musicArtists(seed);
  const candidateArtists = musicArtists(candidate);
  affinity += intersectionSize(seedArtists, candidateArtists) * 60;

  const seedAlbumId = albumId(seed);
  const candidateAlbumId = albumId(candidate);
  if (seedAlbumId && candidateAlbumId && seedAlbumId === candidateAlbumId) affinity += 55;
  else {
    const seedAlbumName = albumName(seed);
    const candidateAlbumName = albumName(candidate);
    if (seedAlbumName && candidateAlbumName && seedAlbumName === candidateAlbumName) affinity += 38;
  }

  const seedGenres = normalizedGenres(seed);
  const candidateGenres = normalizedGenres(candidate);
  affinity += intersectionSize(seedGenres, candidateGenres) * 20;
  affinity += overlapRatio(seedGenres, candidateGenres) * 10;
  return affinity;
}

function isMusicTrack(item: PtvItem) {
  return item.type === 'Audio' || (item.type === 'Unknown' && item.mediaType?.toLocaleLowerCase('en-US') === 'audio');
}

/**
 * WebOS does not receive the server policy's affinity/discovery classification.
 * Use only bounded user-state signals as the local familiarity inference so the
 * same input always lands in the same policy bucket.
 */
function isFamiliarItem(item: PtvItem) {
  return Boolean(item.favorite || item.played || (item.playbackPositionTicks ?? 0) > 0);
}

function isFamiliarMusicTrack(item: PtvItem) {
  return isFamiliarItem(item);
}

function wouldCreateConsecutiveMatch(
  selected: readonly PtvItem[],
  candidate: PtvItem,
  maxConsecutiveArtist: number,
  maxConsecutiveAlbum: number
) {
  const candidateArtists = musicArtists(candidate);
  const artistRun = selected.slice(-maxConsecutiveArtist);
  const repeatsArtist = artistRun.length === maxConsecutiveArtist
    && candidateArtists.length > 0
    && artistRun.every(previous => {
      const previousArtists = new Set(musicArtists(previous));
      return candidateArtists.some(artist => previousArtists.has(artist));
    });
  const candidateAlbum = musicAlbumKey(candidate);
  const albumRun = selected.slice(-maxConsecutiveAlbum);
  const repeatsAlbum = Boolean(candidateAlbum)
    && albumRun.length === maxConsecutiveAlbum
    && albumRun.every(previous => candidateAlbum === musicAlbumKey(previous));

  return repeatsArtist || repeatsAlbum;
}

function excludedIds(options: RelatedRankingOptions) {
  return new Set(options.excludeItemIds ?? []);
}

function dedupeRanked(candidates: RankedCandidate[], limit: number) {
  if (limit <= 0) return [];
  const result: RankedCandidate[] = [];
  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const candidate of candidates) {
    if (seenIds.has(candidate.item.id) || seenIdentities.has(candidate.identity)) continue;
    seenIds.add(candidate.item.id);
    seenIdentities.add(candidate.identity);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Ranks a generic related-content pool without mutating it. The seed and played
 * candidates are omitted by default, and duplicate media identities collapse to
 * the highest-ranked occurrence.
 */
export function rankRelatedCandidates(
  seed: PtvItem,
  candidates: readonly PtvItem[],
  options: RelatedRankingOptions = {}
) {
  const limit = nonNegativeInteger(options.limit, DEFAULT_RELATED_LIMIT);
  const excluded = excludedIds(options);
  excluded.add(seed.id);
  const excludePlayed = options.excludePlayed ?? true;

  const ranked = candidates
    .filter(candidate => !excluded.has(candidate.id) && !(excludePlayed && candidate.played))
    .map(candidate => ({
      item: candidate,
      score: relatedScore(seed, candidate),
      tieBreaker: tieBreaker(options.sessionSeed, candidate),
      identity: relatedIdentity(candidate)
    }))
    .sort(compareRanked);

  const policy = policyForSurface('related');
  const maxPerArtist = positiveInteger(options.maxItemsPerArtist, policy.maxItemsPerArtist);
  const maxPerAlbum = positiveInteger(options.maxItemsPerAlbum, policy.maxItemsPerAlbum);
  const maxConsecutiveArtist = positiveInteger(options.maxConsecutiveArtist, policy.maxConsecutiveArtist);
  const maxConsecutiveAlbum = positiveInteger(options.maxConsecutiveAlbum, policy.maxConsecutiveAlbum);
  const remaining = dedupeRanked(ranked, ranked.length);
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const result: PtvItem[] = [];
  const plannedLength = Math.min(limit, remaining.length);
  const familiarTarget = Math.min(
    remaining.filter(candidate => isFamiliarItem(candidate.item)).length,
    Math.round(plannedLength * policy.familiarTarget)
  );
  const discoveryTarget = Math.min(
    remaining.filter(candidate => !isFamiliarItem(candidate.item)).length,
    plannedLength - familiarTarget
  );
  let familiarCount = 0;
  let discoveryCount = 0;

  const findNext = (preference: 'discovery' | 'familiar') => remaining.find(candidate => {
    const familiar = isFamiliarItem(candidate.item);
    const artists = musicArtists(candidate.item);
    const album = musicAlbumKey(candidate.item);
    return (preference === 'familiar' ? familiar : !familiar)
      && !artists.some(artist => (artistCounts.get(artist) ?? 0) >= maxPerArtist)
      && (!album || (albumCounts.get(album) ?? 0) < maxPerAlbum)
      && !wouldCreateConsecutiveMatch(
        result,
        candidate.item,
        maxConsecutiveArtist,
        maxConsecutiveAlbum
      );
  });

  while (result.length < limit) {
    const selectedBucketCount = familiarCount + discoveryCount;
    const expectedFamiliarByNext = Math.ceil(
      ((selectedBucketCount + 1) * familiarTarget) / Math.max(1, plannedLength)
    );
    const preference: 'discovery' | 'familiar' = familiarCount >= familiarTarget
      ? 'discovery'
      : discoveryCount >= discoveryTarget || familiarCount < expectedFamiliarByNext
      ? 'familiar'
      : 'discovery';
    const alternate = preference === 'familiar' ? 'discovery' : 'familiar';
    const next = findNext(preference) ?? findNext(alternate);
    if (!next) break;
    remaining.splice(remaining.indexOf(next), 1);
    result.push(next.item);
    for (const artist of musicArtists(next.item)) {
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    }
    const album = musicAlbumKey(next.item);
    if (album) albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
    if (isFamiliarItem(next.item)) familiarCount += 1;
    else discoveryCount += 1;
  }

  return result;
}

/**
 * Builds a finite, diverse music mix from audio candidates. When a seed is
 * supplied, candidates must share an artist, album, or genre with it; favorites
 * and ratings can improve an affiliated track but cannot make unrelated music
 * eligible. Played tracks are omitted by default. When they are allowed, a
 * controlled familiar share is spread through the mix rather than clustered.
 */
export function rankMusicMixTracks(
  seed: PtvItem | null | undefined,
  candidates: readonly PtvItem[],
  options: MusicMixRankingOptions = {}
) {
  const limit = nonNegativeInteger(options.limit, DEFAULT_MIX_LIMIT);
  if (limit === 0) return [];
  const policy = policyForSurface(options.surface);
  const maxPerArtist = positiveInteger(
    options.maxTracksPerArtist ?? options.maxItemsPerArtist,
    policy.maxItemsPerArtist ?? DEFAULT_MAX_TRACKS_PER_ARTIST
  );
  const maxPerAlbum = positiveInteger(
    options.maxTracksPerAlbum ?? options.maxItemsPerAlbum,
    policy.maxItemsPerAlbum ?? DEFAULT_MAX_TRACKS_PER_ALBUM
  );
  const maxConsecutiveArtist = positiveInteger(options.maxConsecutiveArtist, policy.maxConsecutiveArtist);
  const maxConsecutiveAlbum = positiveInteger(options.maxConsecutiveAlbum, policy.maxConsecutiveAlbum);
  const excluded = excludedIds(options);
  const includeSeedFirst = Boolean(seed && isMusicTrack(seed) && options.includeSeedFirst && !excluded.has(seed.id));
  if (seed) excluded.add(seed.id);
  const excludePlayed = options.excludePlayed ?? true;

  const ranked = candidates
    .filter(candidate => isMusicTrack(candidate))
    .filter(candidate => !excluded.has(candidate.id) && !(excludePlayed && candidate.played))
    .map(candidate => {
      const affinity = seed ? musicAffinity(seed, candidate) : 0;
      return {
        item: candidate,
        affinity,
        score: affinity + userSignalScore(candidate),
        tieBreaker: tieBreaker(options.sessionSeed, candidate),
        identity: musicTrackIdentity(candidate)
      };
    })
    .filter(candidate => !seed || candidate.affinity > 0)
    .sort(compareRanked);

  const deduped = dedupeRanked(ranked, ranked.length);
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const result: PtvItem[] = includeSeedFirst && seed ? [seed] : [];

  if (includeSeedFirst && seed) {
    for (const artist of musicArtists(seed)) artistCounts.set(artist, 1);
    const seedAlbum = musicAlbumKey(seed);
    if (seedAlbum) albumCounts.set(seedAlbum, 1);
  }

  if (result.length >= limit) return result.slice(0, limit);

  const remaining = [...deduped];
  const plannedLength = Math.min(limit, result.length + remaining.length);
  const seededFamiliarCount = result.filter(isFamiliarMusicTrack).length;
  const availableFamiliarCount = seededFamiliarCount
    + remaining.filter(candidate => isFamiliarMusicTrack(candidate.item)).length;
  const familiarTarget = excludePlayed ? 0 : Math.min(
    availableFamiliarCount,
    Math.max(1, Math.floor(plannedLength * Math.max(0, Math.min(1, options.familiarRatio ?? policy.familiarTarget))))
  );
  let familiarCount = seededFamiliarCount;

  const respectsHardCaps = (candidate: RankedCandidate) => {
    const artists = musicArtists(candidate.item);
    const album = musicAlbumKey(candidate.item);
    return !artists.some(artist => (artistCounts.get(artist) ?? 0) >= maxPerArtist)
      && (!album || (albumCounts.get(album) ?? 0) < maxPerAlbum);
  };
  const findNext = (preference: 'any' | 'discovery' | 'familiar', avoidThird: boolean) => (
    remaining.find(candidate => {
      const familiar = isFamiliarMusicTrack(candidate.item);
      const matchesPreference = preference === 'any'
        || (preference === 'familiar' && familiar)
        || (preference === 'discovery' && !familiar);
      return matchesPreference
        && respectsHardCaps(candidate)
        && (!avoidThird || !wouldCreateConsecutiveMatch(
          result,
          candidate.item,
          maxConsecutiveArtist,
          maxConsecutiveAlbum
        ));
    })
  );

  while (result.length < limit) {
    let preference: 'any' | 'discovery' | 'familiar' = 'any';
    if (!excludePlayed) {
      const familiarNeeded = Math.max(0, familiarTarget - familiarCount);
      const remainingSlots = plannedLength - result.length;
      const nextPosition = result.length + 1;
      const desiredFamiliarByPosition = Math.min(
        familiarTarget,
        Math.floor(((nextPosition + 1) * familiarTarget) / Math.max(1, plannedLength))
      );
      preference = remainingSlots <= familiarNeeded || familiarCount < desiredFamiliarByPosition
        ? 'familiar'
        : 'discovery';
    }

    const next = findNext(preference, true)
      || findNext('any', true)
      || findNext(preference, false)
      || findNext('any', false);
    if (!next) break;

    remaining.splice(remaining.indexOf(next), 1);
    result.push(next.item);
    const artists = musicArtists(next.item);
    const album = musicAlbumKey(next.item);
    for (const artist of artists) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    if (album) albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
    if (isFamiliarMusicTrack(next.item)) familiarCount += 1;
  }

  return result;
}
