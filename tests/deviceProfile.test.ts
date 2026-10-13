import { describe, expect, it } from 'vitest';
import { createPtvWebOsDeviceProfile } from '../src/playback/deviceProfile';

describe('PTV webOS playback profile', () => {
  it('keeps raw direct play conservative while permitting bounded HEVC HLS stream copy', () => {
    const profile = createPtvWebOsDeviceProfile() as {
      DirectPlayProfiles: Array<Record<string, unknown>>;
      TranscodingProfiles: Array<Record<string, unknown>>;
      CodecProfiles: Array<Record<string, unknown>>;
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
      VideoCodec: 'h264,hevc',
      AudioCodec: 'aac',
      Protocol: 'hls',
      BreakOnNonKeyFrames: false
    }));
    expect(profile.CodecProfiles).toContainEqual({
      Type: 'Video',
      Codec: 'hevc',
      Conditions: [
        {
          Condition: 'EqualsAny',
          Property: 'VideoProfile',
          Value: 'main|main 10',
          IsRequired: false
        },
        {
          Condition: 'LessThanEqual',
          Property: 'VideoLevel',
          Value: '120',
          IsRequired: false
        }
      ]
    });
    expect(profile.DirectPlayProfiles.some(entry => (
      entry.Type === 'Video' && String(entry.Container ?? '').includes('mkv')
    ))).toBe(false);
  });
});
