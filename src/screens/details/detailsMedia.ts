import type { PtvPlaybackMediaSource, PtvPlaybackSourceStream } from '../../api/jellyfin/types';
import {
  parsePlaybackTrackOptions,
  type PlaybackTrackOption
} from '../../playback/tracks';
import type { PtvItem, PtvMediaSource, PtvMediaStreamInfo } from '../../types/ptv';

export interface DetailMediaPresentation {
  qualityTags: string[];
  audioTracks: PlaybackTrackOption[];
  subtitleTracks: PlaybackTrackOption[];
}

function primaryMediaSource(item: PtvItem | null) {
  return item?.mediaSources?.find(source => source.streams?.some(stream => stream.isVideoStream))
    ?? item?.mediaSources?.[0]
    ?? null;
}

function streamType(stream: PtvMediaStreamInfo): PtvPlaybackSourceStream['Type'] | null {
  if (stream.type) return stream.type;
  if (stream.isVideoStream) return 'Video';
  if (stream.isAudioStream) return 'Audio';
  if (stream.isSubtitleStream) return 'Subtitle';
  return null;
}

function toPlaybackMediaSource(source: PtvMediaSource | null): PtvPlaybackMediaSource | null {
  if (!source?.id) return null;
  const mediaStreams: PtvPlaybackSourceStream[] = [];
  for (const stream of source.streams ?? []) {
    const type = streamType(stream);
    if (!type) continue;
    mediaStreams.push({
      Index: stream.index,
      Type: type,
      DisplayTitle: stream.displayTitle,
      Title: stream.title,
      Codec: stream.codec,
      Language: stream.language,
      IsDefault: stream.isDefault,
      IsForced: stream.isForced,
      IsExternal: stream.isExternal,
      Width: stream.width,
      Height: stream.height,
      BitRate: stream.bitrate,
      Profile: stream.profile,
      VideoRange: stream.videoRange,
      VideoRangeType: stream.videoRangeType,
      ChannelLayout: stream.channelLayout,
      Channels: stream.channelCount
    });
  }

  return {
    Id: source.id,
    Container: source.container,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    IsRemote: source.isRemote,
    MediaStreams: mediaStreams,
    DirectStreamUrl: source.directStreamUrl,
    TranscodingUrl: source.transcodingUrl,
    Bitrate: source.bitrate,
    Width: source.width,
    Height: source.height,
    VideoCodec: source.videoCodec ?? source.codec,
    AudioCodec: source.audioCodec
  };
}

function resolutionLabel(width?: number | null, height?: number | null) {
  if ((width ?? 0) >= 3800 || (height ?? 0) >= 2000) return '4K UHD';
  if ((width ?? 0) >= 2500 || (height ?? 0) >= 1400) return '1440p';
  if ((width ?? 0) >= 1900 || (height ?? 0) >= 1000) return '1080p';
  if ((width ?? 0) >= 1200 || (height ?? 0) >= 700) return '720p';
  if ((height ?? 0) > 0) return `${height}p`;
  return null;
}

function rangeLabel(stream: PtvMediaStreamInfo | undefined) {
  const value = `${stream?.videoRangeType ?? ''} ${stream?.videoRange ?? ''}`.trim().toUpperCase();
  if (!value || value === 'SDR') return null;
  if (value.includes('DOVI') || value.includes('DOLBY')) return 'Dolby Vision';
  if (value.includes('HDR10+') || value.includes('HDR10PLUS')) return 'HDR10+';
  if (value.includes('HDR10')) return 'HDR10';
  if (value.includes('HLG')) return 'HLG';
  if (value.includes('HDR')) return 'HDR';
  return null;
}

function codecLabel(codec?: string | null) {
  const normalized = codec?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'hevc' || normalized === 'h265') return 'HEVC';
  if (normalized === 'h264' || normalized === 'avc') return 'H.264';
  if (normalized === 'av1') return 'AV1';
  if (normalized === 'vp9') return 'VP9';
  return normalized.toUpperCase();
}

function channelLabel(stream: PtvMediaStreamInfo | undefined) {
  const layout = stream?.channelLayout?.trim();
  if (layout) return layout;
  if (stream?.channelCount === 1) return 'Mono';
  if (stream?.channelCount === 2) return 'Stereo';
  if (stream?.channelCount === 6) return '5.1';
  if (stream?.channelCount === 8) return '7.1';
  return typeof stream?.channelCount === 'number' ? `${stream.channelCount} ch` : null;
}

function uniqueTags(tags: Array<string | null | undefined>) {
  const unique: string[] = [];
  for (const tag of tags) {
    if (!tag || unique.includes(tag)) continue;
    unique.push(tag);
    if (unique.length === 4) break;
  }
  return unique;
}

export function presentDetailMedia(item: PtvItem | null): DetailMediaPresentation {
  const source = primaryMediaSource(item);
  const streams = source?.streams ?? [];
  const video = streams.find(stream => stream.isVideoStream || stream.type === 'Video');
  const audio = streams.find(stream => stream.isAudioStream && stream.isDefault)
    ?? streams.find(stream => stream.isAudioStream || stream.type === 'Audio');
  const tracks = parsePlaybackTrackOptions(toPlaybackMediaSource(source));
  return {
    qualityTags: uniqueTags([
      resolutionLabel(video?.width ?? source?.width, video?.height ?? source?.height),
      rangeLabel(video),
      codecLabel(video?.codec ?? source?.videoCodec ?? source?.codec),
      channelLabel(audio)
    ]),
    audioTracks: tracks.audio,
    subtitleTracks: tracks.subtitles
  };
}

export function cycleTrackIndex(options: PlaybackTrackOption[], selected: number | null) {
  if (!options.length) return null;
  const currentIndex = options.findIndex(option => option.index === selected);
  return options[(currentIndex + 1) % options.length]?.index ?? options[0]?.index ?? null;
}

export function cycleSubtitleIndex(options: PlaybackTrackOption[], selected: number | null) {
  if (!options.length) return null;
  if (selected === null) return options[0]?.index ?? null;
  const currentIndex = options.findIndex(option => option.index === selected);
  if (currentIndex < 0 || currentIndex === options.length - 1) return null;
  return options[currentIndex + 1]?.index ?? null;
}
