import { describe, expect, it } from 'vitest';
import {
  rankMusicMixTracks,
  rankRelatedCandidates
} from '../src/recommendations/ranker';
import { MUSIC_RECOMMENDATION_SURFACE_POLICIES } from '../src/recommendations/policy';
import type { PtvItem } from '../src/types/ptv';

function item(overrides: Partial<PtvItem> & Pick<PtvItem, 'id' | 'name' | 'type'>): PtvItem {
  return { ...overrides };
}

describe('recommendation ranker', () => {
  it('shares explicit context policies for premium mix surfaces', () => {
    expect(MUSIC_RECOMMENDATION_SURFACE_POLICIES['made-for-you']).toMatchObject({
      discoveryTarget: 0.3,
      familiarTarget: 0.7,
      maxConsecutiveArtist: 2
    });
    expect(MUSIC_RECOMMENDATION_SURFACE_POLICIES.radio).toMatchObject({
      discoveryTarget: 0.75,
      familiarTarget: 0.25
    });
  });

  it('ranks strong generic relationships first while excluding the seed, played items, and duplicates', () => {
    const seed = item({
      id: 'seed',
      name: 'Voyage Beyond',
      type: 'Movie',
      genres: ['Science Fiction', 'Adventure'],
      productionYear: 2024
    });
    const candidates = [
      seed,
      item({
        id: 'strong',
        name: 'Beyond the Stars',
        type: 'Movie',
        genres: ['Science Fiction', 'Adventure'],
        productionYear: 2023
      }),
      item({
        id: 'strong',
        name: 'Beyond the Stars',
        type: 'Movie',
        genres: ['Science Fiction'],
        productionYear: 2023
      }),
      item({
        id: 'played',
        name: 'Another Voyage',
        type: 'Movie',
        genres: ['Science Fiction', 'Adventure'],
        productionYear: 2024,
        played: true
      }),
      item({
        id: 'weak',
        name: 'Quiet Kitchen',
        type: 'Movie',
        genres: ['Documentary'],
        productionYear: 1980
      })
    ];

    expect(rankRelatedCandidates(seed, candidates).map(candidate => candidate.id)).toEqual(['strong', 'weak']);
  });

  it('is input-order independent and deterministically varies equal-score ties by session seed', () => {
    const seed = item({ id: 'seed', name: 'Seed', type: 'Movie' });
    const candidates = Array.from({ length: 8 }, (_, index) => item({
      id: `candidate-${index}`,
      name: `Title ${index}`,
      type: 'Movie'
    }));

    const first = rankRelatedCandidates(seed, candidates, { sessionSeed: 'session-alpha' }).map(candidate => candidate.id);
    const repeated = rankRelatedCandidates(seed, [...candidates].reverse(), { sessionSeed: 'session-alpha' }).map(candidate => candidate.id);
    const varied = rankRelatedCandidates(seed, candidates, { sessionSeed: 'session-bravo' }).map(candidate => candidate.id);

    expect(repeated).toEqual(first);
    expect(varied).not.toEqual(first);
  });

  it('diversifies music-related results instead of returning one artist block', () => {
    const seed = item({
      id: 'seed',
      name: 'Seed',
      type: 'Audio',
      artists: ['Artist A'],
      genres: ['Pop']
    });
    const candidates = [
      item({ id: 'a1', name: 'A One', type: 'Audio', artists: ['Artist A'], albumId: 'a1', genres: ['Pop'] }),
      item({ id: 'a2', name: 'A Two', type: 'Audio', artists: ['Artist A'], albumId: 'a2', genres: ['Pop'] }),
      item({ id: 'a3', name: 'A Three', type: 'Audio', artists: ['Artist A'], albumId: 'a3', genres: ['Pop'] }),
      item({ id: 'a4', name: 'A Four', type: 'Audio', artists: ['Artist A'], albumId: 'a4', genres: ['Pop'] }),
      item({ id: 'b1', name: 'B One', type: 'Audio', artists: ['Artist B'], albumId: 'b1', genres: ['Pop'] }),
      item({ id: 'c1', name: 'C One', type: 'Audio', artists: ['Artist C'], albumId: 'c1', genres: ['Pop'] })
    ];

    const ranked = rankRelatedCandidates(seed, candidates, { excludePlayed: false, limit: 6 });

    expect(ranked.slice(0, 3).map(candidate => candidate.artists?.[0])).toEqual([
      'Artist A',
      'Artist A',
      expect.not.stringMatching('Artist A')
    ]);
    expect(ranked.filter(candidate => candidate.artists?.[0] === 'Artist A')).toHaveLength(3);
  });

  it('applies the Related 60/40 familiar-discovery cadence deterministically', () => {
    const seed = item({
      id: 'related-seed',
      name: 'Related Seed',
      type: 'Audio',
      genres: ['Neo Soul']
    });
    // The WebOS item model has no explicit server classification. Favorites,
    // plays, and resume state are therefore the bounded local familiarity hint.
    const familiar = Array.from({ length: 8 }, (_, index) => item({
      id: `familiar-${index}`,
      name: `Familiar ${index}`,
      type: 'Audio',
      artists: [`Familiar Artist ${index}`],
      albumId: `familiar-album-${index}`,
      genres: ['Neo Soul'],
      favorite: true
    }));
    const discovery = Array.from({ length: 8 }, (_, index) => item({
      id: `new-${index}`,
      name: `New ${index}`,
      type: 'Audio',
      artists: [`New Artist ${index}`],
      albumId: `new-album-${index}`,
      genres: ['Neo Soul']
    }));
    const candidates = [...familiar, ...discovery];
    const options = { limit: 10, sessionSeed: 'related-policy' };

    const ranked = rankRelatedCandidates(seed, candidates, options);
    const repeated = rankRelatedCandidates(seed, [...candidates].reverse(), options);

    expect(ranked).toHaveLength(10);
    expect(ranked.filter(candidate => candidate.favorite)).toHaveLength(6);
    expect(ranked.filter(candidate => !candidate.favorite)).toHaveLength(4);
    expect(repeated.map(candidate => candidate.id)).toEqual(ranked.map(candidate => candidate.id));
  });

  it('rejects zero-affinity music even when it has strong user signals', () => {
    const seed = item({
      id: 'seed-track',
      name: 'Seed Track',
      type: 'Audio',
      artists: ['Seed Artist'],
      album: 'Seed Album',
      albumId: 'seed-album',
      genres: ['Dream Pop']
    });
    const candidates = [
      seed,
      item({
        id: 'same-artist',
        name: 'Artist Match',
        type: 'Audio',
        artists: ['Seed Artist'],
        album: 'Other Album',
        albumId: 'other-album'
      }),
      item({
        id: 'same-genre',
        name: 'Genre Match',
        type: 'Audio',
        artists: ['Another Artist'],
        album: 'Genre Album',
        albumId: 'genre-album',
        genres: ['Dream Pop']
      }),
      item({
        id: 'played-match',
        name: 'Already Played',
        type: 'Audio',
        artists: ['Seed Artist'],
        played: true
      }),
      item({
        id: 'unrelated-favorite',
        name: 'Unrelated Favorite',
        type: 'Audio',
        artists: ['No Connection'],
        album: 'No Connection',
        albumId: 'unrelated-album',
        genres: ['Metal'],
        favorite: true,
        communityRating: 10
      }),
      item({ id: 'not-a-track', name: 'Matching Album', type: 'MusicAlbum', genres: ['Dream Pop'] })
    ];

    expect(rankMusicMixTracks(seed, candidates).map(candidate => candidate.id)).toEqual([
      'same-artist',
      'same-genre'
    ]);
  });

  it('deduplicates recordings and strictly caps artist and album repetition', () => {
    const seed = item({ id: 'seed', name: 'Seed', type: 'Audio', genres: ['Pop'] });
    const candidates = [
      item({ id: 'a1', name: 'One', type: 'Audio', artists: ['Artist A'], albumId: 'album-a1', genres: ['Pop'] }),
      item({ id: 'a2', name: 'Two', type: 'Audio', artists: ['Artist A'], albumId: 'album-a1', genres: ['Pop'] }),
      item({ id: 'a3', name: 'Three', type: 'Audio', artists: ['Artist A'], albumId: 'album-a2', genres: ['Pop'] }),
      item({ id: 'a4', name: 'Four', type: 'Audio', artists: ['Artist A'], albumId: 'album-a3', genres: ['Pop'] }),
      item({ id: 'b1', name: 'Twin Song', type: 'Audio', artists: ['Artist B'], albumId: 'album-b1', genres: ['Pop'] }),
      item({ id: 'b2', name: 'Twin Song', type: 'Audio', artists: ['Artist B'], albumId: 'compilation', genres: ['Pop'] }),
      item({ id: 'c1', name: 'Five', type: 'Audio', artists: ['Artist C'], albumId: 'album-c1', genres: ['Pop'] })
    ];

    const ranked = rankMusicMixTracks(seed, candidates, {
      limit: 10,
      maxTracksPerArtist: 2,
      maxTracksPerAlbum: 1,
      sessionSeed: 'diversity-session'
    });
    const artistACount = ranked.filter(candidate => candidate.artists?.[0] === 'Artist A').length;
    const albumA1Count = ranked.filter(candidate => candidate.albumId === 'album-a1').length;
    const twinSongCount = ranked.filter(candidate => candidate.name === 'Twin Song').length;

    expect(artistACount).toBeLessThanOrEqual(2);
    expect(albumA1Count).toBeLessThanOrEqual(1);
    expect(twinSongCount).toBe(1);
    expect(ranked.some(candidate => candidate.id === 'c1')).toBe(true);
  });

  it('uses Discovery total caps of two tracks per artist and one per album', () => {
    const seed = item({
      id: 'discovery-seed',
      name: 'Discovery Seed',
      type: 'Audio',
      genres: ['Ambient']
    });
    const candidates = [
      item({ id: 'a1', name: 'A One', type: 'Audio', artists: ['Artist A'], albumId: 'album-a', genres: ['Ambient'] }),
      item({ id: 'a2', name: 'A Two', type: 'Audio', artists: ['Artist A'], albumId: 'album-b', genres: ['Ambient'] }),
      item({ id: 'a3', name: 'A Three', type: 'Audio', artists: ['Artist A'], albumId: 'album-c', genres: ['Ambient'] }),
      item({ id: 'b1', name: 'B One', type: 'Audio', artists: ['Artist B'], albumId: 'shared-album', genres: ['Ambient'] }),
      item({ id: 'c1', name: 'C One', type: 'Audio', artists: ['Artist C'], albumId: 'shared-album', genres: ['Ambient'] }),
      item({ id: 'd1', name: 'D One', type: 'Audio', artists: ['Artist D'], albumId: 'album-d', genres: ['Ambient'] }),
      item({ id: 'e1', name: 'E One', type: 'Audio', artists: ['Artist E'], albumId: 'album-e', genres: ['Ambient'] })
    ];
    const options = {
      limit: 10,
      sessionSeed: 'discovery-caps',
      surface: 'discovery' as const
    };

    const ranked = rankMusicMixTracks(seed, candidates, options);
    const repeated = rankMusicMixTracks(seed, [...candidates].reverse(), options);

    expect(ranked.filter(candidate => candidate.artists?.includes('Artist A'))).toHaveLength(2);
    expect(ranked.filter(candidate => candidate.albumId === 'shared-album')).toHaveLength(1);
    expect(repeated.map(candidate => candidate.id)).toEqual(ranked.map(candidate => candidate.id));
  });

  it('uses the session seed to vary equal-affinity music ties reproducibly', () => {
    const seed = item({ id: 'seed', name: 'Seed', type: 'Audio', genres: ['Soul'] });
    const candidates = Array.from({ length: 8 }, (_, index) => item({
      id: `track-${index}`,
      name: `Track ${index}`,
      type: 'Audio',
      artists: [`Artist ${index}`],
      albumId: `album-${index}`,
      genres: ['Soul']
    }));

    const first = rankMusicMixTracks(seed, candidates, { sessionSeed: 'listener-one' }).map(candidate => candidate.id);
    const repeated = rankMusicMixTracks(seed, [...candidates].reverse(), { sessionSeed: 'listener-one' }).map(candidate => candidate.id);
    const varied = rankMusicMixTracks(seed, candidates, { sessionSeed: 'listener-two' }).map(candidate => candidate.id);

    expect(repeated).toEqual(first);
    expect(varied).not.toEqual(first);
  });

  it('can keep an audio seed first while applying diversity to the rest of the mix', () => {
    const seed = item({
      id: 'seed',
      name: 'Seed',
      type: 'Audio',
      artists: ['Artist A'],
      albumId: 'album-a',
      genres: ['Soul'],
      played: true
    });
    const candidates = [
      seed,
      item({ id: 'a2', name: 'A Two', type: 'Audio', artists: ['Artist A'], albumId: 'album-a', genres: ['Soul'] }),
      item({ id: 'a3', name: 'A Three', type: 'Audio', artists: ['Artist A'], albumId: 'album-b', genres: ['Soul'] }),
      item({ id: 'b1', name: 'B One', type: 'Audio', artists: ['Artist B'], albumId: 'album-c', genres: ['Soul'] })
    ];

    const ranked = rankMusicMixTracks(seed, candidates, {
      includeSeedFirst: true,
      excludePlayed: false,
      limit: 4,
      maxTracksPerArtist: 2,
      maxTracksPerAlbum: 1,
      sessionSeed: 'seed-first'
    });

    expect(ranked[0]?.id).toBe('seed');
    expect(ranked.filter(candidate => candidate.artists?.[0] === 'Artist A')).toHaveLength(2);
    expect(ranked.filter(candidate => candidate.albumId === 'album-a')).toHaveLength(1);
    expect(ranked.some(candidate => candidate.id === 'b1')).toBe(true);
  });

  it('distributes a bounded familiar share when played tracks are allowed', () => {
    const seed = item({
      id: 'seed',
      name: 'Seed',
      type: 'Audio',
      artists: ['Seed Artist'],
      albumId: 'seed-album',
      genres: ['Soul']
    });
    const familiar = [
      item({
        id: 'favorite',
        name: 'Favorite',
        type: 'Audio',
        artists: ['Favorite Artist'],
        albumId: 'favorite-album',
        genres: ['Soul'],
        favorite: true
      }),
      item({
        id: 'played',
        name: 'Played',
        type: 'Audio',
        artists: ['Played Artist'],
        albumId: 'played-album',
        genres: ['Soul'],
        played: true
      }),
      item({
        id: 'in-progress',
        name: 'In Progress',
        type: 'Audio',
        artists: ['Progress Artist'],
        albumId: 'progress-album',
        genres: ['Soul'],
        playbackPositionTicks: 10
      })
    ];
    const discovery = Array.from({ length: 12 }, (_, index) => item({
      id: `discovery-${index}`,
      name: `Discovery ${index}`,
      type: 'Audio',
      artists: [`Discovery Artist ${index}`],
      albumId: `discovery-album-${index}`,
      genres: ['Soul']
    }));
    const familiarIds = new Set(familiar.map(candidate => candidate.id));

    const ranked = rankMusicMixTracks(seed, [...familiar, ...discovery], {
      includeSeedFirst: true,
      excludePlayed: false,
      limit: 12,
      sessionSeed: 'familiar-cadence'
    });
    const repeated = rankMusicMixTracks(seed, [...discovery, ...familiar].reverse(), {
      includeSeedFirst: true,
      excludePlayed: false,
      limit: 12,
      sessionSeed: 'familiar-cadence'
    });
    const familiarPositions = ranked.flatMap((candidate, index) => (
      familiarIds.has(candidate.id) ? [index + 1] : []
    ));

    expect(familiarPositions).toEqual([3, 7, 11]);
    expect(ranked.filter(candidate => familiarIds.has(candidate.id))).toHaveLength(3);
    expect(repeated.map(candidate => candidate.id)).toEqual(ranked.map(candidate => candidate.id));
  });

  it('avoids a third consecutive artist or album when another eligible track exists', () => {
    const artistSeed = item({
      id: 'artist-seed',
      name: 'Artist Seed',
      type: 'Audio',
      artists: ['Artist A'],
      albumId: 'seed-album',
      genres: ['Soul']
    });
    const artistRanked = rankMusicMixTracks(artistSeed, [
      item({ id: 'artist-a1', name: 'A One', type: 'Audio', artists: ['Artist A'], albumId: 'album-a1', genres: ['Soul'] }),
      item({ id: 'artist-a2', name: 'A Two', type: 'Audio', artists: ['Artist A'], albumId: 'album-a2', genres: ['Soul'] }),
      item({ id: 'artist-b1', name: 'B One', type: 'Audio', artists: ['Artist B'], albumId: 'album-b1', genres: ['Soul'] })
    ], {
      includeSeedFirst: true,
      limit: 4,
      maxTracksPerArtist: 5,
      maxTracksPerAlbum: 5,
      sessionSeed: 'artist-run'
    });

    expect(artistRanked[0]?.id).toBe('artist-seed');
    expect(artistRanked[1]?.artists).toContain('Artist A');
    expect(artistRanked[2]?.id).toBe('artist-b1');
    expect(artistRanked).toHaveLength(4);

    const albumSeed = item({
      id: 'album-seed',
      name: 'Album Seed',
      type: 'Audio',
      artists: ['Seed Artist'],
      albumId: 'shared-album',
      genres: ['Soul']
    });
    const albumRanked = rankMusicMixTracks(albumSeed, [
      item({ id: 'album-one', name: 'Album One', type: 'Audio', artists: ['Artist One'], albumId: 'shared-album', genres: ['Soul'] }),
      item({ id: 'album-two', name: 'Album Two', type: 'Audio', artists: ['Artist Two'], albumId: 'shared-album', genres: ['Soul'] }),
      item({ id: 'other-album', name: 'Other Album', type: 'Audio', artists: ['Artist Three'], albumId: 'other-album', genres: ['Soul'] })
    ], {
      includeSeedFirst: true,
      limit: 4,
      maxTracksPerArtist: 5,
      maxTracksPerAlbum: 5,
      sessionSeed: 'album-run'
    });

    expect(albumRanked[0]?.id).toBe('album-seed');
    expect(albumRanked[1]?.albumId).toBe('shared-album');
    expect(albumRanked[2]?.id).toBe('other-album');
    expect(albumRanked).toHaveLength(4);
  });

  it('honors a zero result limit', () => {
    const seed = item({ id: 'seed', name: 'Seed', type: 'Movie' });
    const candidate = item({ id: 'candidate', name: 'Candidate', type: 'Movie' });

    expect(rankRelatedCandidates(seed, [candidate], { limit: 0 })).toEqual([]);
    expect(rankMusicMixTracks(undefined, [
      item({ id: 'track', name: 'Track', type: 'Audio' })
    ], { limit: 0 })).toEqual([]);
  });
});
