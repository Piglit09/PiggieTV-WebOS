import { describe, expect, it } from 'vitest';
import { createPtvWebOsDeviceProfile } from '../src/playback/deviceProfile';

describe('PTV webOS playback profile', () => {
  it('uses explicit direct-play codecs and a conservative HLS fallback', () => {
    const profile = createPtvWebOsDeviceProfile() as {
      DirectPlayProfiles: Array<Record<string, unknown>>;
      TranscodingProfiles: Array<Record<string, unknown>>;
    };

    expect(profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
      Container: 'mp4,m4v,mov',
      Type: 'Video',
      VideoCodec: 'h264',
      AudioCodec: 'aac,mp3'
    }));
    expect(profile.DirectPlayProfiles.some(entry => (
      entry.Type === 'Video' && !entry.Container && !entry.VideoCodec
    ))).toBe(false);
    expect(profile.TranscodingProfiles).toContainEqual(expect.objectContaining({
      Container: 'ts',
      Type: 'Video',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      Protocol: 'hls'
    }));
  });
});
