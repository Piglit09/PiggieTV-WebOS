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
