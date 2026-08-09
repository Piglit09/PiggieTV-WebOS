import { describe, expect, it } from 'vitest';
import type { PtvPlaybackMediaSource } from '../src/api/jellyfin/types';
import {
  parsePlaybackTrackOptions,
  pickDefaultAudioTrackIndex,
  pickDefaultSubtitleTrackIndex
} from '../src/playback/tracks';
import {
  cycleSubtitleIndex,
  cycleTrackIndex
} from '../src/screens/details/detailsMedia';

function mediaSource(): PtvPlaybackMediaSource {
  return {
    Id: 'source-tracks',
    Container: 'mkv',
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    MediaStreams: [{
      Type: 'Video',
      Index: 0,
      Codec: 'hevc'
    }, {
      Type: 'Audio',
      Index: 1,
      Language: 'spa',
      Codec: 'aac',
      IsDefault: true,
      Channels: 2
    }, {
      Type: 'Audio',
      Index: 2,
      Language: 'eng',
      Codec: 'eac3',
      DisplayTitle: 'English Dolby Digital+ 5.1',
      ChannelLayout: '5.1',
      Channels: 6
    }, {
      Type: 'Subtitle',
      Index: 5,
      Language: 'spa',
      Codec: 'subrip',
      DisplayTitle: 'Spanish',
      IsDefault: true
    }, {
      Type: 'Subtitle',
      Index: 6,
      Language: 'eng',
      Codec: 'subrip',
      DisplayTitle: 'English Forced',
      IsForced: true,
      IsExternal: true
    }]
  };
}

describe('shared playback track selection', () => {
  it('parses ordered audio and subtitle options with display metadata', () => {
    const tracks = parsePlaybackTrackOptions(mediaSource());

    expect(tracks.audio).toEqual([
      expect.objectContaining({
        index: 1,
        language: 'spa',
        codec: 'aac',
        channelCount: 2,
        isDefault: true
      }),
      expect.objectContaining({
        index: 2,
        language: 'eng',
        codec: 'eac3',
        title: 'English Dolby Digital+ 5.1',
        channelCount: 6,
        channelLayout: '5.1',
        label: 'English Dolby Digital+ 5.1'
      })
    ]);
    expect(tracks.subtitles).toEqual([
      expect.objectContaining({ index: 5, label: 'Spanish', isDefault: true }),
      expect.objectContaining({
        index: 6,
        label: 'English Forced',
        isForced: true,
        isExternal: true
      })
    ]);
  });

  it('honors explicit indices and keeps subtitle Auto distinct from Off', () => {
    const tracks = parsePlaybackTrackOptions(mediaSource());

    expect(pickDefaultAudioTrackIndex(tracks.audio, 1)).toBe(1);
    expect(pickDefaultAudioTrackIndex(tracks.audio, undefined)).toBe(2);
    expect(pickDefaultSubtitleTrackIndex(tracks.subtitles, 5)).toBe(5);
    expect(pickDefaultSubtitleTrackIndex(tracks.subtitles, undefined)).toBe(6);
    expect(pickDefaultSubtitleTrackIndex(tracks.subtitles, null)).toBeNull();
    expect(pickDefaultSubtitleTrackIndex(tracks.subtitles, undefined, true)).toBeNull();
    expect(pickDefaultSubtitleTrackIndex(
      tracks.subtitles.filter(track => !track.isForced),
      undefined
    )).toBe(5);
  });

  it('cycles audio continuously and subtitles through an Off stop', () => {
    const tracks = parsePlaybackTrackOptions(mediaSource());

    expect(cycleTrackIndex(tracks.audio, null)).toBe(1);
    expect(cycleTrackIndex(tracks.audio, 1)).toBe(2);
    expect(cycleTrackIndex(tracks.audio, 2)).toBe(1);
    expect(cycleTrackIndex(tracks.audio, 99)).toBe(1);
    expect(cycleTrackIndex([], 1)).toBeNull();

    expect(cycleSubtitleIndex(tracks.subtitles, null)).toBe(5);
    expect(cycleSubtitleIndex(tracks.subtitles, 5)).toBe(6);
    expect(cycleSubtitleIndex(tracks.subtitles, 6)).toBeNull();
    expect(cycleSubtitleIndex(tracks.subtitles, 99)).toBeNull();
    expect(cycleSubtitleIndex([], 5)).toBeNull();
  });
});
