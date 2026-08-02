import type { PtvPlaybackInfoResponse } from '../api/jellyfin/types';

export type PlaybackMode = 'direct-play' | 'direct-stream' | 'transcode';

export interface PlaybackSelectionInput {
  preferredMode?: PlaybackMode;
  preferDirectPlay?: boolean;
  preferDirectStream?: boolean;
  allowTranscode?: boolean;
}

export interface PlaybackSelection {
  mode: PlaybackMode;
  mediaSourceId?: string;
  container?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitrate?: number | null;
  resolution?: string;
  reason: string;
}

function toResolution(width?: number | null, height?: number | null) {
  if (width == null || height == null) return undefined;
  return `${width}x${height}`;
}

export function chooseBestPlaybackSource(
  playbackInfo: PtvPlaybackInfoResponse | null,
  options: PlaybackSelectionInput = {}
): PlaybackSelection {
  const sources = playbackInfo?.MediaSources ?? [];
  if (!sources.length) {
    return {
      mode: options.preferredMode ?? (options.allowTranscode ? 'transcode' : 'direct-stream'),
      reason: 'No media source supplied by server'
    };
  }

  const directPlay = options.preferDirectPlay ?? true;
  const directStream = options.preferDirectStream ?? true;
  const allowTranscode = options.allowTranscode ?? true;

  const modes: PlaybackMode[] = options.preferredMode
    ? [options.preferredMode, 'direct-play', 'direct-stream', 'transcode']
    : ['direct-play', 'direct-stream', 'transcode'];
  const orderedModes = modes.filter((mode, index) => modes.indexOf(mode) === index);

  for (const mode of orderedModes) {
    const enabled = mode === 'direct-play' ? directPlay : mode === 'direct-stream' ? directStream : allowTranscode;
    if (!enabled) continue;
    const candidate = sources.find(source => (
      mode === 'direct-play' ? source.SupportsDirectPlay :
      mode === 'direct-stream' ? source.SupportsDirectStream :
      source.SupportsTranscoding
    ));
    if (!candidate) continue;
    return {
      mode,
      mediaSourceId: candidate.Id,
      container: candidate.Container,
      videoCodec: candidate.VideoCodec,
      audioCodec: candidate.AudioCodec,
      bitrate: candidate.Bitrate,
      resolution: toResolution(candidate.Width, candidate.Height),
      reason: mode === 'direct-play'
        ? (candidate.IsRemote ? 'Remote source can be direct played' : 'Server marked direct play support')
        : mode === 'direct-stream'
          ? 'Server marked direct stream support'
          : 'Server marked transcode support'
    };
  }

  return {
    mode: options.preferredMode ?? 'direct-stream',
    reason: 'No enabled playback mode is supported by any media source'
  };
}
