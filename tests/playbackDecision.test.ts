import { describe, expect, it } from 'vitest';
import { chooseBestPlaybackSource } from '../src/playback/decision';

describe('playback decision', () => {
  it('prefers direct play', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{ Id: 'A', SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true }]
    } as any, { preferDirectPlay: true });
    expect(result.mode).toBe('direct-play');
  });

  it('falls back to direct stream', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{
        Id: 'A',
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        DirectStreamUrl: '/Videos/A/stream'
      }]
    } as any, { preferDirectPlay: false, preferDirectStream: true, allowTranscode: true });
    expect(result.mode).toBe('direct-stream');
  });

  it('falls back to transcode', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{
        Id: 'A',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '/Videos/A/master.m3u8'
      }]
    } as any, { preferDirectPlay: false, preferDirectStream: false, allowTranscode: true });
    expect(result.mode).toBe('transcode');
  });

  it('skips a direct-stream flag without a URL and selects a valid transcode', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{
        Id: 'A',
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        DirectStreamUrl: '   ',
        TranscodingUrl: '/Videos/A/master.m3u8'
      }]
    } as any, { preferDirectPlay: false, preferDirectStream: true, allowTranscode: true });

    expect(result).toMatchObject({ mode: 'transcode', mediaSourceId: 'A' });
  });

  it('selects the first source with a usable URL for the requested mode', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [
        {
          Id: 'missing-url',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          SupportsTranscoding: false
        },
        {
          Id: 'usable-url',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: '/Videos/usable-url/stream'
        }
      ]
    } as any, { preferDirectPlay: false, preferDirectStream: true, allowTranscode: false });

    expect(result).toMatchObject({ mode: 'direct-stream', mediaSourceId: 'usable-url' });
  });

  it('returns no media source when transcode support has no usable URL', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{
        Id: 'A',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '   '
      }]
    } as any, { preferDirectPlay: false, preferDirectStream: false, allowTranscode: true });

    expect(result.mode).toBe('direct-stream');
    expect(result.mediaSourceId).toBeUndefined();
  });
});
