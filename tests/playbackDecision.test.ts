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
      MediaSources: [{ Id: 'A', SupportsDirectPlay: false, SupportsDirectStream: true, SupportsTranscoding: true }]
    } as any, { preferDirectPlay: false, preferDirectStream: true, allowTranscode: true });
    expect(result.mode).toBe('direct-stream');
  });

  it('falls back to transcode', () => {
    const result = chooseBestPlaybackSource({
      MediaSources: [{ Id: 'A', SupportsDirectPlay: false, SupportsDirectStream: false, SupportsTranscoding: true }]
    } as any, { preferDirectPlay: false, preferDirectStream: false, allowTranscode: true });
    expect(result.mode).toBe('transcode');
  });
});
