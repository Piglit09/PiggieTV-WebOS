/**
 * Conservative phase-1 profile for the webOS 5.x HTML media pipeline.
 *
 * Direct play is intentionally limited to the most dependable combination.
 * Everything else is offered an HLS H.264/AAC transcode instead of relying on
 * Jellyfin's wildcard video profile to guess what the television can decode.
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
        VideoCodec: 'h264',
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
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' }
    ],
    ResponseProfiles: [
      { Container: 'm4v', Type: 'Video', MimeType: 'video/mp4' }
    ]
  };
}
