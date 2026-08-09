import { describe, expect, it } from 'vitest';
import {
  canNavigateToDetails,
  isAudioTrackItem,
  isBookItem,
  isFolderOrCollectionItem,
  isMusicAlbumItem,
  isMusicArtistItem,
  isMovieItem,
  isMusicVideoItem,
  isPhotoOrUnsupportedItem,
  isSeriesItem,
  isUnsupportedDetailItem,
  mapItemTypeFromServer,
  mapPtvItem,
  mapPtvItems
} from '../src/api/jellyfin/mappers';

describe('Ptv item mapper', () => {
  it('maps canonical movie fields and relationship fields', () => {
    const mapped = mapPtvItem({
      Id: 'movie-1',
      Name: 'Action Movie',
      Type: 'Movie',
      MediaType: 'Video',
      SeriesName: 'Collection',
      SeasonName: 'Season One',
      ProductionYear: 2024,
      Overview: 'Hero story',
      RunTimeTicks: 900000000,
      ImageTags: { Primary: 'tag-1', Thumb: 'tag-2' },
      BackdropImageTags: ['bg-1', 'bg-2'],
      UserData: {
        PlaybackPositionTicks: 120,
        Played: true,
        IsFavorite: true
      }
    });

    expect(mapped.id).toBe('movie-1');
    expect(mapped.name).toBe('Action Movie');
    expect(mapped.type).toBe('Movie');
    expect(mapped.mediaType).toBe('Video');
    expect(mapped.seriesName).toBe('Collection');
    expect(mapped.seasonName).toBe('Season One');
    expect(mapped.overview).toBe('Hero story');
    expect(mapped.runTimeTicks).toBe(900000000);
    expect(mapped.playbackPositionTicks).toBe(120);
    expect(mapped.played).toBe(true);
    expect(mapped.favorite).toBe(true);
  });

  it('maps rich video, audio, and subtitle media source metadata', () => {
    const mapped = mapPtvItem({
      Id: 'movie-rich-media',
      Name: 'Rich Media Movie',
      Type: 'Movie',
      MediaSources: [{
        Id: 'source-4k',
        Container: 'mkv',
        VideoCodec: 'hevc',
        AudioCodec: 'eac3',
        Bitrate: 24_000_000,
        Width: 3840,
        Height: 2160,
        DirectStreamUrl: '/Videos/movie-rich-media/stream',
        TranscodingUrl: '/Videos/movie-rich-media/master.m3u8',
        MediaStreams: [{
          Id: 'video-0',
          Type: 'Video',
          Index: 0,
          Codec: 'hevc',
          BitRate: 18_000_000,
          Width: 3840,
          Height: 2160,
          Profile: 'Main 10',
          VideoRange: 'HDR10',
          VideoRangeType: 'HDR10',
          IsDefault: true
        }, {
          Id: 'audio-2',
          Type: 'Audio',
          Index: 2,
          Codec: 'eac3',
          Language: 'eng',
          Title: 'English',
          DisplayTitle: 'English Dolby Digital+ 5.1',
          ChannelLayout: '5.1',
          Channels: 6,
          IsDefault: true
        }, {
          Id: 'subtitle-5',
          Type: 'Subtitle',
          Index: 5,
          Codec: 'subrip',
          Language: 'eng',
          Title: 'English Forced',
          DisplayTitle: 'English Forced SRT',
          IsForced: true,
          IsExternal: true
        }]
      }]
    });

    expect(mapped.mediaSources).toHaveLength(1);
    expect(mapped.mediaSources?.[0]).toMatchObject({
      id: 'source-4k',
      container: 'mkv',
      videoCodec: 'hevc',
      audioCodec: 'eac3',
      bitrate: 24_000_000,
      width: 3840,
      height: 2160,
      directStreamUrl: '/Videos/movie-rich-media/stream',
      transcodingUrl: '/Videos/movie-rich-media/master.m3u8'
    });
    expect(mapped.mediaSources?.[0]?.streams).toEqual([
      expect.objectContaining({
        id: 'video-0',
        index: 0,
        type: 'Video',
        codec: 'hevc',
        bitrate: 18_000_000,
        width: 3840,
        height: 2160,
        profile: 'Main 10',
        videoRange: 'HDR10',
        videoRangeType: 'HDR10',
        isDefault: true,
        isVideoStream: true,
        isAudioStream: false,
        isSubtitleStream: false
      }),
      expect.objectContaining({
        id: 'audio-2',
        index: 2,
        type: 'Audio',
        codec: 'eac3',
        language: 'eng',
        title: 'English',
        displayTitle: 'English Dolby Digital+ 5.1',
        channelLayout: '5.1',
        channelCount: 6,
        isDefault: true,
        isVideoStream: false,
        isAudioStream: true,
        isSubtitleStream: false
      }),
      expect.objectContaining({
        id: 'subtitle-5',
        index: 5,
        type: 'Subtitle',
        codec: 'subrip',
        language: 'eng',
        title: 'English Forced',
        displayTitle: 'English Forced SRT',
        isForced: true,
        isExternal: true,
        isVideoStream: false,
        isAudioStream: false,
        isSubtitleStream: true
      })
    ]);
  });

  it('falls back image tag mapping to PrimaryImageTag', () => {
    const mapped = mapPtvItem({
      Id: 'movie-2',
      Type: 'Movie',
      Name: 'Fallback Tag',
      PrimaryImageTag: 'primary-tag'
    });

    expect(mapped.imageTags).toEqual({ Primary: 'primary-tag' });
  });

  it('filters unsupported rows unless explicitly requested', () => {
    const response = {
      Items: [
        { Id: 'x-1', Name: 'Photo A', Type: 'PhotoAlbum' },
        { Id: 'x-2', Name: 'Unknown A', Type: 'AlienThing' },
        { Id: 'x-3', Name: 'Episode A', Type: 'Episode' }
      ]
    };

    expect(mapPtvItems(response).map(item => item.id)).toEqual(['x-1', 'x-3']);
    expect(mapPtvItems(response, { includeUnsupportedTypes: true }).map(item => item.id)).toEqual(['x-1', 'x-2', 'x-3']);
  });

  it('maps container counts and can exclude only explicitly empty shows and seasons', () => {
    const response = {
      Items: [
        { Id: 'empty-series', Name: 'Empty Series', Type: 'Series', ChildCount: 2, RecursiveItemCount: 0 },
        { Id: 'ready-series', Name: 'Ready Series', Type: 'Series', ChildCount: 2, RecursiveItemCount: 12 },
        { Id: 'unknown-count-series', Name: 'Legacy Series', Type: 'Series' },
        { Id: 'empty-season', Name: 'Empty Season', Type: 'Season', RecursiveItemCount: 0 },
        { Id: 'episode-1', Name: 'Pilot', Type: 'Episode' }
      ]
    };

    const allItems = mapPtvItems(response);
    expect(allItems[0]).toMatchObject({
      id: 'empty-series',
      childCount: 2,
      recursiveItemCount: 0
    });
    expect(mapPtvItems(response, { excludeEmptyVideoContainers: true }).map(item => item.id)).toEqual([
      'ready-series',
      'unknown-count-series',
      'episode-1'
    ]);
  });

  it('handles missing identity safely without leaking object text', () => {
    const mapped = mapPtvItem({
      Id: 'no-name',
      Type: 'Movie',
      Name: { value: 'bad' }
    });

    expect(mapped.name).toBe('Untitled');
    expect(mapped.name).not.toBe('[object Object]');
  });

  it('validates item id and type fallbacks', () => {
    expect(() => mapPtvItem({ Name: 'NoId', Type: 'Movie' })).toThrow();
    expect(mapPtvItem({ Id: 'x', Type: undefined, Name: 'NoType' }).type).toBe('Unknown');
    expect(mapItemTypeFromServer('Series')).toBe('Series');
    expect(mapItemTypeFromServer('series')).toBe('Series');
    expect(mapItemTypeFromServer('UnknownStuff')).toBe('Unknown');
  });

  it('preserves taxonomy result types and maps Jellyfin BoxSet collections', () => {
    expect(mapPtvItem({ Id: 'genre-1', Type: 'Genre', Name: 'Drama' }).type).toBe('Genre');
    expect(mapPtvItem({ Id: 'music-genre-1', Type: 'MusicGenre', Name: 'Dream Pop' }).type).toBe('MusicGenre');
    expect(mapPtvItem({ Id: 'studio-1', Type: 'Studio', Name: 'Pixar' }).type).toBe('Studio');
    expect(mapPtvItem({ Id: 'collection-1', Type: 'BoxSet', Name: 'Favorites' }).type).toBe('Collection');
    expect(canNavigateToDetails(mapPtvItem({ Id: 'genre-1', Type: 'Genre', Name: 'Drama' }))).toBe(false);
  });

  it('flags requested item categories correctly', () => {
    const movie = mapPtvItem({ Id: 'm', Type: 'Movie', Name: 'Movie' });
    const series = mapPtvItem({ Id: 's', Type: 'Series', Name: 'Series' });
    const season = mapPtvItem({ Id: 's1', Type: 'Season', Name: 'Season' });
    const episode = mapPtvItem({ Id: 'e1', Type: 'Episode', Name: 'Episode' });
    const album = mapPtvItem({ Id: 'a', Type: 'MusicAlbum', Name: 'Album' });
    const artist = mapPtvItem({ Id: 'ar', Type: 'MusicArtist', Name: 'Artist' });
    const song = mapPtvItem({ Id: 't', Type: 'Audio', Name: 'Track' });
    const video = mapPtvItem({ Id: 'mv', Type: 'MusicVideo', Name: 'Music Video' });
    const book = mapPtvItem({ Id: 'b', Type: 'Book', Name: 'Book' });
    const photo = mapPtvItem({ Id: 'p', Type: 'PhotoAlbum', Name: 'Photo set' });
    const folder = mapPtvItem({ Id: 'f', Type: 'Folder', Name: 'Folder' });
    const unknown = mapPtvItem({ Id: 'u', Type: 'Alien' as never, Name: 'Aliens' });

    expect(isMovieItem(movie)).toBe(true);
    expect(isSeriesItem(series)).toBe(true);
    expect(isMusicAlbumItem(album)).toBe(true);
    expect(isMusicArtistItem(artist)).toBe(true);
    expect(isAudioTrackItem(song)).toBe(true);
    expect(isMusicVideoItem(video)).toBe(true);
    expect(isBookItem(book)).toBe(true);
    expect(isPhotoOrUnsupportedItem(photo)).toBe(true);
    expect(isFolderOrCollectionItem(folder)).toBe(true);
    expect(isUnsupportedDetailItem(episode)).toBe(false);
    expect(isUnsupportedDetailItem(unknown)).toBe(true);
    expect(canNavigateToDetails(movie)).toBe(true);
    expect(canNavigateToDetails(season)).toBe(true);
    expect(canNavigateToDetails(episode)).toBe(true);
    expect(canNavigateToDetails(book)).toBe(true);
    expect(canNavigateToDetails(photo)).toBe(false);
    expect(canNavigateToDetails(folder)).toBe(false);
    expect(canNavigateToDetails(unknown)).toBe(false);
  });

  it('supports required fixture coverage without throwing', () => {
    const fixtures = [
      { Id: 'series-id', Name: 'A Series', Type: 'Series' },
      { Id: 'season-id', Name: 'Season 1', Type: 'Season', SeriesId: 'series-id' },
      { Id: 'ep-id', Name: 'Episode 1', Type: 'Episode', SeriesId: 'series-id', SeasonId: 'season-id' },
      { Id: 'album-id', Name: 'Great Album', Type: 'MusicAlbum' },
      { Id: 'artist-id', Name: 'Great Artist', Type: 'MusicArtist' },
      { Id: 'song-id', Name: 'Track One', Type: 'Audio' },
      { Id: 'book-id', Name: 'Some Book', Type: 'Book' }
    ];

    const result = mapPtvItems({ Items: fixtures });
    expect(result).toHaveLength(7);
    expect(result.map(item => item.id)).toEqual(
      fixtures.map(item => item.Id)
    );
  });

  it('infers audio items when type case differs or is omitted with audio media type', () => {
    const lower = mapPtvItem({
      Id: 'case-audio',
      Type: 'audio',
      Name: 'Case Audio'
    });
    const audioFromMediaType = mapPtvItem({
      Id: 'audio-media',
      Name: 'Audio By MediaType',
      MediaType: 'Audio'
    });

    expect(lower.type).toBe('Audio');
    expect(audioFromMediaType.type).toBe('Audio');
    expect(lower.type).not.toBe('Movie');
    expect(audioFromMediaType.type).not.toBe('Movie');
  });

  it('maps audio track media metadata', () => {
    const mapped = mapPtvItem({
      Id: 'song-1',
      Type: 'Audio',
      Name: 'Fearless',
      Artists: ['Taylor Swift'],
      AlbumArtist: 'Taylor Swift',
      Album: 'Fearless',
      AlbumId: 'album-1',
      IndexNumber: 1,
      TrackCount: 2,
      RunTimeTicks: 300000000,
      ProductionYear: 2008,
      Genres: ['Pop'],
      ImageTags: { Primary: 'cover' },
      BackdropImageTags: ['bg-1'],
      MediaSources: [{
        Id: 'source-1',
        Container: 'flac',
        Codec: 'flac',
        MediaStreams: [{ Type: 'Audio', Index: 1, Codec: 'flac', Language: 'en', ChannelCount: 2 }]
      }],
      UserData: {
        PlaybackPositionTicks: 12000000,
        Played: false,
        IsFavorite: true
      }
    });

    expect(mapped.type).toBe('Audio');
    expect(mapped.artists).toEqual(['Taylor Swift']);
    expect(mapped.albumArtist).toBe('Taylor Swift');
    expect(mapped.album).toBe('Fearless');
    expect(mapped.albumId).toBe('album-1');
    expect(mapped.trackNumber).toBe(1);
    expect(mapped.trackCount).toBe(2);
    expect(mapped.playbackPositionTicks).toBe(12000000);
    expect(mapped.favorite).toBe(true);
    expect(mapped.mediaSources?.[0]?.id).toBe('source-1');
    expect(mapped.mediaSources?.[0]?.streams?.[0]?.isAudioStream).toBe(true);
    expect(mapped.mediaSources?.[0]?.streams?.[0]?.channelCount).toBe(2);
  });
});
