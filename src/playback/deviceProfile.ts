/**
 * Conservative phase-1 profile for the webOS 5.x HTML media pipeline.
 *
 * Direct play is intentionally limited to the most dependable combination.
 * HEVC is accepted only inside the HLS/TS pipeline, allowing Jellyfin to remux
 * compatible video without exposing raw MKV playback to the television.
 */
export function createPtvWebOsDeviceProfile(): Record<string, unknown> {
  return {
    Name: 'PTV webOS 5',
    MaxStreamingBitrate: 20_000_000,
    MaxStaticBitrate: 20_000_000,
    MusicStreamingTranscodingBitrate: 192_000,
    DirectPlayProfiles: [
      {
        Container: 'mp4,m4v,mov',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3'
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3' },
      { Container: 'aac,m4a', Type: 'Audio', AudioCodec: 'aac' }
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264,hevc',
        AudioCodec: 'aac',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: 1,
        BreakOnNonKeyFrames: false
      },
      {
        Container: 'aac',
        Type: 'Audio',
        AudioCodec: 'aac',
        Protocol: 'http',
        Context: 'Streaming',
        MaxAudioChannels: '2'
      }
    ],
    CodecProfiles: [
      {
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
      }
    ],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' }
    ],
    ResponseProfiles: [
      { Container: 'm4v', Type: 'Video', MimeType: 'video/mp4' }
    ]
  };
}
