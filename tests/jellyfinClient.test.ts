import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJson } = vi.hoisted(() => ({
  requestJson: vi.fn()
}));

vi.mock('../src/api/http/http', () => ({
  requestJson
}));

import { JellyfinApiClient, resolvePlaybackStreamUrl } from '../src/api/jellyfin/client';

function createClient() {
  return new JellyfinApiClient({
    baseUrl: 'https://piggietv.com',
    deviceId: 'device-test'
  });
}

describe('JellyfinApiClient server identity compatibility', () => {
  beforeEach(() => requestJson.mockReset());

  it('normalizes the Jellyfin 10.11 public Id field to ServerId', async () => {
    requestJson.mockResolvedValue({
      Id: 'server-from-id',
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().validateServer()).resolves.toMatchObject({
      Id: 'server-from-id',
      ServerId: 'server-from-id',
      Version: '10.11.11'
    });
  });

  it('preserves ServerId when both identity fields are present', async () => {
    requestJson.mockResolvedValue({
      Id: 'fallback-id',
      ServerId: 'canonical-id',
      ServerName: 'PiggieTV',
      Version: '10.10.0'
    });

    await expect(createClient().validateServer()).resolves.toMatchObject({
      ServerId: 'canonical-id'
    });
  });

  it('normalizes identity through getSystemInfo as well as validateServer', async () => {
    requestJson.mockResolvedValue({
      Id: 'server-from-public-info',
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().getSystemInfo()).resolves.toMatchObject({
      Id: 'server-from-public-info',
      ServerId: 'server-from-public-info'
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('rejects a public identity response without either ID field', async () => {
    requestJson.mockResolvedValue({
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().validateServer()).rejects.toMatchObject({
      kind: 'invalid-server-response'
    });
  });

  it('derives static client capabilities without a duplicate server request', async () => {
    const capabilities = await createClient().discoverCapabilities();

    expect(capabilities.map(capability => capability.id)).toEqual(expect.arrayContaining([
      'quick-connect',
      'playback-direct-play',
      'playback-direct-stream',
      'playback-transcode',
      'jellyfin-server'
    ]));
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('uses lean Home queries and disables unneeded result counts', async () => {
    requestJson.mockResolvedValue({ Items: [] });
    const client = createClient();

    await client.getResume('user-1', 'Movie,Series,Episode', 10);
    await client.getNextUp('user-1', 10);
    await client.getRecentlyAdded('user-1', 'Movie,Series', 12);

    expect(requestJson.mock.calls[0]?.[1]).toMatchObject({
      query: {
        Fields: expect.stringContaining('BackdropImageTags'),
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(requestJson.mock.calls[1]?.[1]).toMatchObject({
      query: {
        Fields: expect.stringContaining('BackdropImageTags'),
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(requestJson.mock.calls[2]?.[1]).toMatchObject({
      query: {
        Fields: expect.stringContaining('BackdropImageTags'),
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(requestJson.mock.calls[2]?.[1]?.query?.Fields).toEqual(expect.stringContaining('RecursiveItemCount'));
  });

  it('requests recursive episode counts for series discovery, search, and seasons', async () => {
    requestJson.mockResolvedValue({ Items: [] });
    const client = createClient();

    await client.getSearch('user-1', 'show');
    await client.getSeasons('user-1', 'series-1');

    expect(requestJson.mock.calls[0]?.[1]?.query?.Fields).toEqual(expect.stringContaining('RecursiveItemCount'));
    expect(requestJson.mock.calls[1]?.[1]?.query?.Fields).toEqual(expect.stringContaining('RecursiveItemCount'));
    expect(requestJson.mock.calls[1]?.[1]?.query?.Fields).toEqual(expect.stringContaining('ChildCount'));
  });

  it('searches media genres, music genres, and studios through canonical exact endpoints first', async () => {
    requestJson.mockImplementation((rawUrl: string) => {
      const path = typeof rawUrl === 'string' ? new URL(rawUrl).pathname : 'missing-url';
      if (path === '/Genres/dra') return Promise.resolve({ Id: 'genre-drama', Name: 'Drama' });
      if (path === '/MusicGenres/dre') return Promise.resolve({ Id: 'genre-dream-pop', Name: 'Dream Pop' });
      return Promise.resolve({ Id: 'studio-pixar', Name: 'Pixar' });
    });
    const client = createClient();

    const genre = await client.getSearchGenres('private-user', 'dra');
    const musicGenre = await client.getSearchMusicGenres('private-user', 'dre');
    const studio = await client.getSearchStudios('private-user', 'pix');

    expect(requestJson.mock.calls.map(call => typeof call[0] === 'string' ? new URL(call[0]).pathname : 'missing-url')).toEqual([
      '/Genres/dra',
      '/MusicGenres/dre',
      '/Studios/pix'
    ]);
    expect(requestJson.mock.calls[0]?.[1]).toMatchObject({
      query: { UserId: 'private-user' },
      timeoutMs: 6_000,
      retries: 0,
      requestRoute: 'GET Genres/{name} (search taxonomy exact)'
    });
    expect(requestJson.mock.calls[1]?.[1]).toMatchObject({
      query: { UserId: 'private-user' },
      timeoutMs: 6_000,
      retries: 0,
      requestRoute: 'GET MusicGenres/{name} (search taxonomy exact)'
    });
    expect(requestJson.mock.calls[2]?.[1]).toMatchObject({
      query: { UserId: 'private-user' },
      timeoutMs: 6_000,
      retries: 0,
      requestRoute: 'GET Studios/{name} (search taxonomy exact)'
    });
    expect(genre.Items).toEqual([expect.objectContaining({ Id: 'genre-drama', Type: 'Genre' })]);
    expect(musicGenre.Items).toEqual([expect.objectContaining({ Id: 'genre-dream-pop', Type: 'MusicGenre' })]);
    expect(studio.Items).toEqual([expect.objectContaining({ Id: 'studio-pixar', Type: 'Studio' })]);
  });

  it('falls back to a bounded directory query when an exact taxonomy lookup has no match', async () => {
    requestJson
      .mockRejectedValueOnce({ kind: 'server-unreachable', code: 404, message: 'No exact taxonomy match' })
      .mockResolvedValueOnce({ Items: [{ Id: 'genre-dream-pop', Name: 'Dream Pop' }] });
    const client = createClient();

    const result = await client.getSearchMusicGenres('private-user', 'dream');

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(typeof requestJson.mock.calls[0]?.[0] === 'string' ? new URL(requestJson.mock.calls[0]![0]).pathname : '').toBe('/MusicGenres/dream');
    expect(typeof requestJson.mock.calls[1]?.[0] === 'string' ? new URL(requestJson.mock.calls[1]![0]).pathname : '').toBe('/MusicGenres');
    expect(requestJson.mock.calls[1]?.[1]).toMatchObject({
      query: { UserId: 'private-user', SearchTerm: 'dream', Limit: 48 },
      timeoutMs: 2_500,
      retries: 0,
      requestRoute: 'GET MusicGenres (search taxonomy)'
    });
    expect(result.Items).toEqual([expect.objectContaining({ Id: 'genre-dream-pop', Name: 'Dream Pop', Type: 'MusicGenre' })]);
    expect(requestJson.mock.calls[1]?.[1]?.query?.Limit).toBe(48);
  });

  it('does not amplify an exact taxonomy timeout with a second directory request', async () => {
    requestJson.mockRejectedValueOnce({
      kind: 'request-timeout',
      message: 'The server took too long to respond',
      recoverable: true
    });
    const client = createClient();

    const first = await client.getSearchStudios('private-user', 'rock');
    const cachedRetry = await client.getSearchStudios('private-user', 'rock');

    expect(first.Items).toEqual([]);
    expect(cachedRetry.Items).toEqual([]);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 6_000,
      retries: 0,
      requestRoute: 'GET Studios/{name} (search taxonomy exact)'
    });
  });

  it('reuses successful content and taxonomy searches within the short response cache', async () => {
    requestJson
      .mockResolvedValueOnce({ Items: [{ Id: 'movie-rock', Name: 'Rock', Type: 'Movie' }] })
      .mockResolvedValueOnce({ Id: 'music-rock', Name: 'Rock' });
    const client = createClient();

    await client.getSearch('private-user', 'Rock');
    await client.getSearch('private-user', ' rock ');
    await client.getSearchMusicGenres('private-user', 'Rock');
    await client.getSearchMusicGenres('private-user', ' rock ');

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
      '/Users/private-user/Items',
      '/MusicGenres/Rock'
    ]);
  });

  it('opens search categories as native, typed Jellyfin catalog queries', async () => {
    requestJson
      .mockResolvedValueOnce({ Items: [{ Id: 'movie-drama', Type: 'Movie' }], TotalRecordCount: 10 })
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 })
      .mockResolvedValueOnce({ Items: [{ Id: 'album-rock', Type: 'MusicAlbum' }], TotalRecordCount: 20 })
      .mockResolvedValueOnce({ Items: [{ Id: 'movie-pixar', Type: 'Movie' }], TotalRecordCount: 7 });
    const client = createClient();

    const genre = await client.getSearchCategoryItems('private-user', 'genre/private', 'Genre', 16, 16, undefined, 'Drama');
    const musicGenre = await client.getSearchCategoryItems('private-user', 'music/private', 'MusicGenre', 0, 16, undefined, 'Rock');
    await client.getSearchCategoryItems('private-user', 'studio/private', 'Studio', 0, 16, undefined, 'Pixar');

    expect(requestJson.mock.calls[0]?.[1]).toMatchObject({
      query: {
        StartIndex: 16,
        Limit: 16,
        IncludeItemTypes: 'Movie,Series',
        Genres: 'Drama',
        EnableTotalRecordCount: false
      },
      timeoutMs: 8_000,
      retries: 0,
      requestRoute: 'GET Users/{user}/Items (search category by name)'
    });
    expect(requestJson.mock.calls[1]?.[1]?.query).toMatchObject({
      IncludeItemTypes: 'MusicAlbum',
      Fields: 'ImageTags,ProductionYear',
      Genres: 'Rock'
    });
    expect(requestJson.mock.calls[2]?.[1]).toMatchObject({
      query: { GenreIds: 'music/private' },
      requestRoute: 'GET Users/{user}/Items (search category by id)'
    });
    expect(requestJson.mock.calls[3]?.[1]).toMatchObject({
      query: {
        IncludeItemTypes: 'Movie,Series',
        Studios: 'Pixar'
      },
      requestRoute: 'GET Users/{user}/Items (search category by name)'
    });
    expect(genre.TotalRecordCount).toBeUndefined();
    expect(musicGenre.TotalRecordCount).toBeUndefined();
    for (const call of requestJson.mock.calls) {
      const requestRoute = String(call[1]?.requestRoute ?? '');
      expect(requestRoute).not.toContain('private-user');
      expect(requestRoute).not.toContain('/private');
    }
  });

  it('falls back to the selected season children when the Shows episodes response is empty', async () => {
    requestJson
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [{
          Id: 'episode-fallback',
          Name: 'Fallback Episode',
          Type: 'Episode',
          ParentId: 'season/private'
        }]
      });
    const controller = new AbortController();

    const response = await createClient().getEpisodes(
      'private-user',
      'series/private',
      'season/private',
      controller.signal
    );

    expect(response.Items[0]).toMatchObject({
      Id: 'episode-fallback',
      ParentId: 'season/private',
      SeasonId: 'season/private',
      SeriesId: 'series/private'
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackConfig] = requestJson.mock.calls[1] ?? [];
    expect(fallbackUrl).toBe('https://piggietv.com/Users/private-user/Items');
    expect(fallbackConfig).toMatchObject({
      signal: controller.signal,
      requestRoute: 'GET Users/{user}/Items (season episode fallback)',
      query: {
        ParentId: 'season/private',
        IncludeItemTypes: 'Episode',
        Recursive: true,
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(fallbackConfig.query.Fields).toEqual(expect.stringContaining('SeriesId'));
    expect(fallbackConfig.query.Fields).toEqual(expect.stringContaining('SeasonId'));
    expect(fallbackConfig.requestRoute).not.toContain('private-user');
    expect(fallbackConfig.requestRoute).not.toContain('series/private');
    expect(fallbackConfig.requestRoute).not.toContain('season/private');
  });

  it('uses the season-child fallback after a primary error and preserves supplied relationships', async () => {
    requestJson
      .mockRejectedValueOnce(new Error('primary route unavailable'))
      .mockResolvedValueOnce({
        Items: [{
          Id: 'episode-related',
          Name: 'Related Episode',
          Type: 'Episode',
          ParentId: 'parent-from-server',
          SeasonId: 'season-from-server',
          SeriesId: 'series-from-server'
        }]
      });

    const response = await createClient().getEpisodes('user-1', 'series-requested', 'season-requested');

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(response.Items[0]).toMatchObject({
      ParentId: 'parent-from-server',
      SeasonId: 'season-from-server',
      SeriesId: 'series-from-server'
    });
  });

  it('normalizes missing relationship IDs without making a fallback request for populated primary results', async () => {
    requestJson.mockResolvedValue({
      Items: [{ Id: 'episode-primary', Name: 'Primary Episode', Type: 'Episode', ParentId: 'season-1' }]
    });

    const response = await createClient().getEpisodes('user-1', 'series-1', 'season-1');

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(response.Items[0]).toMatchObject({
      SeasonId: 'season-1',
      SeriesId: 'series-1'
    });
  });

  it('uses a Series-scoped next-up query and an identifier-free diagnostic route', async () => {
    requestJson.mockResolvedValue({ Items: [] });
    const controller = new AbortController();

    await createClient().getNextUpForSeries(
      'private-user-id',
      'private-series-id',
      3,
      controller.signal
    );

    const [url, requestConfig] = requestJson.mock.calls[0] ?? [];
    const config = requestConfig as {
      method?: string;
      query?: Record<string, unknown>;
      requestRoute?: string;
      signal?: AbortSignal;
    };

    expect(url).toBe('https://piggietv.com/Shows/NextUp');
    expect(config).toMatchObject({
      method: 'GET',
      signal: controller.signal,
      requestRoute: 'GET Shows/NextUp',
      query: {
        UserId: 'private-user-id',
        SeriesId: 'private-series-id',
        Limit: 3,
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(config.query?.Fields).toEqual(expect.stringContaining('SeriesName'));
    expect(config.query?.Fields).toEqual(expect.stringContaining('SeasonName'));
    expect(config.query?.Fields).toEqual(expect.stringContaining('IndexNumber'));
    expect(config.query?.Fields).toEqual(expect.stringContaining('ParentIndexNumber'));
    expect(config.requestRoute).not.toContain('private-user-id');
    expect(config.requestRoute).not.toContain('private-series-id');
  });

  it('requests bounded similar items with explicit fields and a sanitized diagnostic route', async () => {
    requestJson.mockResolvedValue({ Items: [] });
    const controller = new AbortController();

    await createClient().getSimilarItems(
      'private-user-id',
      'private/item-id',
      {
        limit: 99,
        fields: ['ImageTags', 'MediaSources', 'UserData']
      },
      controller.signal
    );

    const [url, requestConfig] = requestJson.mock.calls[0] ?? [];
    const config = requestConfig as {
      method?: string;
      query?: Record<string, unknown>;
      requestRoute?: string;
      signal?: AbortSignal;
    };

    expect(url).toBe('https://piggietv.com/Items/private%2Fitem-id/Similar');
    expect(config).toMatchObject({
      method: 'GET',
      signal: controller.signal,
      requestRoute: 'GET Items/{item}/Similar',
      query: {
        UserId: 'private-user-id',
        Limit: 64,
        Fields: 'ImageTags,MediaSources,UserData',
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(config.requestRoute).not.toContain('private-user-id');
    expect(config.requestRoute).not.toContain('private/item-id');
  });

  it('requests a bounded instant mix with user data and an identifier-free diagnostic route', async () => {
    requestJson.mockResolvedValue({ Items: [] });
    const controller = new AbortController();

    await createClient().getInstantMix(
      'private-user-id',
      'private/mix-seed',
      {
        limit: 999,
        fields: ['Artists', 'Album', 'AlbumId', 'Genres', 'UserData']
      },
      controller.signal
    );

    const [url, requestConfig] = requestJson.mock.calls[0] ?? [];
    const config = requestConfig as {
      method?: string;
      query?: Record<string, unknown>;
      requestRoute?: string;
      signal?: AbortSignal;
    };

    expect(url).toBe('https://piggietv.com/Items/private%2Fmix-seed/InstantMix');
    expect(config).toMatchObject({
      method: 'GET',
      signal: controller.signal,
      requestRoute: 'GET Items/{item}/InstantMix',
      query: {
        UserId: 'private-user-id',
        Limit: 64,
        Fields: 'Artists,Album,AlbumId,Genres,UserData',
        EnableUserData: true,
        EnableTotalRecordCount: false
      }
    });
    expect(config.requestRoute).not.toContain('private-user-id');
    expect(config.requestRoute).not.toContain('private/mix-seed');
  });

  it('uses one bounded PlaybackInfo request with a sanitized diagnostic route', async () => {
    requestJson.mockResolvedValue({ MediaSources: [] });

    await createClient().getPlaybackInfo('user-1', 'private-item-id');

    expect(requestJson).toHaveBeenCalledWith(
      expect.stringContaining('/Items/private-item-id/PlaybackInfo'),
      expect.objectContaining({
        method: 'POST',
        timeoutMs: 20_000,
        retries: 0,
        requestCategory: 'playback',
        requestRoute: 'POST Items/{item}/PlaybackInfo'
      }),
      expect.any(Object)
    );
  });

  it('preserves audio index zero and distinguishes subtitle Off from Auto', async () => {
    requestJson.mockResolvedValue({ MediaSources: [] });
    const client = createClient();

    await client.getPlaybackInfo('user-1', 'item-off', {
      audioStreamIndex: 0,
      subtitleStreamIndex: null
    });
    await client.getPlaybackInfo('user-1', 'item-auto', {});
    await client.getPlaybackInfo('user-1', 'item-explicit', {
      audioStreamIndex: 3,
      subtitleStreamIndex: 7
    });

    const offBody = requestJson.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    const autoBody = requestJson.mock.calls[1]?.[1]?.body as Record<string, unknown>;
    const explicitBody = requestJson.mock.calls[2]?.[1]?.body as Record<string, unknown>;

    expect(offBody).toMatchObject({
      UserId: 'user-1',
      AudioStreamIndex: 0,
      SubtitleStreamIndex: -1
    });
    expect(autoBody).not.toHaveProperty('AudioStreamIndex');
    expect(autoBody).not.toHaveProperty('SubtitleStreamIndex');
    expect(explicitBody).toMatchObject({
      AudioStreamIndex: 3,
      SubtitleStreamIndex: 7
    });
  });

  it('creates card-sized image URLs without changing detail-image defaults', () => {
    const client = createClient();
    const cardUrl = new URL(client.getImageUrl('item-1', 'Primary', 'tag-1', {
      maxWidth: 320,
      quality: 80
    }));
    const detailUrl = new URL(client.getImageUrl('item-1', 'Primary', 'tag-1'));

    expect(cardUrl.searchParams.get('maxWidth')).toBe('320');
    expect(cardUrl.searchParams.get('quality')).toBe('80');
    expect(detailUrl.searchParams.get('maxWidth')).toBe('900');
    expect(detailUrl.searchParams.get('quality')).toBe('90');
  });

  it('keeps the generated stream fallback for direct play', () => {
    const url = new URL(resolvePlaybackStreamUrl(
      'https://piggietv.com',
      'item-1',
      { Id: 'source-1', Container: 'mp4' },
      'direct-play',
      'test-token',
      'device-test'
    ));

    expect(url.pathname).toBe('/Videos/item-1/stream');
    expect(url.searchParams.get('mediaSourceId')).toBe('source-1');
    expect(url.searchParams.get('static')).toBe('true');
    expect(url.searchParams.get('container')).toBe('mp4');
  });

  it('preserves valid supplied direct-stream and transcode URLs', () => {
    const directStream = new URL(resolvePlaybackStreamUrl(
      'https://piggietv.com',
      'item-1',
      { Id: 'source-1', DirectStreamUrl: ' /Videos/item-1/stream?mediaSourceId=source-1 ' },
      'direct-stream',
      'test-token',
      'device-test'
    ));
    const transcode = new URL(resolvePlaybackStreamUrl(
      'https://piggietv.com',
      'item-1',
      { Id: 'source-1', TranscodingUrl: 'https://media.example.test/Videos/item-1/master.m3u8' },
      'transcode',
      'test-token',
      'device-test'
    ));

    expect(directStream.origin).toBe('https://piggietv.com');
    expect(directStream.pathname).toBe('/Videos/item-1/stream');
    expect(directStream.searchParams.get('api_key')).toBe('test-token');
    expect(directStream.searchParams.get('deviceId')).toBe('device-test');
    expect(transcode.origin).toBe('https://media.example.test');
    expect(transcode.pathname).toBe('/Videos/item-1/master.m3u8');
    expect(transcode.searchParams.get('api_key')).toBe('test-token');
    expect(transcode.searchParams.get('deviceId')).toBe('device-test');
  });

  it('rejects missing non-direct URLs without exposing request identifiers', () => {
    const directStream = () => resolvePlaybackStreamUrl(
      'https://piggietv.com',
      'private-item',
      { Id: 'private-source' },
      'direct-stream',
      'private-token',
      'private-device'
    );
    const transcode = () => resolvePlaybackStreamUrl(
      'https://piggietv.com',
      'private-item',
      { Id: 'private-source', TranscodingUrl: '   ' },
      'transcode',
      'private-token',
      'private-device'
    );

    expect(directStream).toThrow('Jellyfin did not provide a usable direct-stream URL');
    expect(transcode).toThrow('Jellyfin did not provide a usable transcode URL');
    for (const invoke of [directStream, transcode]) {
      try {
        invoke();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('private-item');
        expect(message).not.toContain('private-source');
        expect(message).not.toContain('private-token');
        expect(message).not.toContain('private-device');
      }
    }
  });
});
