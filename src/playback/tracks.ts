import type { PtvPlaybackMediaSource, PtvPlaybackSourceStream } from '../api/jellyfin/types';

export interface PlaybackTrackOption {
  index: number;
  language: string | null;
  codec: string | null;
  title: string | null;
  channelCount: number | null;
  channelLayout: string | null;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  label: string;
}

function audioLayoutLabel(stream: PtvPlaybackSourceStream) {
  const layout = stream.ChannelLayout?.trim();
  if (layout) return layout;
  if (stream.Channels === 1) return 'Mono';
  if (stream.Channels === 2) return 'Stereo';
  if (stream.Channels === 6) return '5.1';
  if (stream.Channels === 8) return '7.1';
  return typeof stream.Channels === 'number' ? `${stream.Channels} ch` : null;
}

function buildPlaybackTrackLabel(stream: PtvPlaybackSourceStream) {
  const displayTitle = stream.DisplayTitle?.trim();
  if (displayTitle) return displayTitle;

  const title = stream.Title?.trim();
  const language = stream.Language?.trim();
  const codec = stream.Codec?.trim()?.toUpperCase();
  const layout = stream.Type === 'Audio' ? audioLayoutLabel(stream) : null;
  return [title ?? language?.toUpperCase() ?? 'Track', codec, layout].filter(Boolean).join(' · ');
}

export function parsePlaybackTrackOptions(mediaSource: PtvPlaybackMediaSource | null | undefined): {
  audio: PlaybackTrackOption[];
  subtitles: PlaybackTrackOption[];
} {
  const streams = mediaSource?.MediaStreams ?? [];
  const createOption = (stream: PtvPlaybackSourceStream): PlaybackTrackOption | null => {
    const index = stream.Index;
    if (typeof index !== 'number' || !Number.isFinite(index)) return null;
    return {
      index,
      language: stream.Language?.trim() ?? null,
      codec: stream.Codec?.trim() ?? null,
      title: stream.DisplayTitle?.trim() ?? stream.Title?.trim() ?? null,
      channelCount: typeof stream.Channels === 'number' ? stream.Channels : null,
      channelLayout: stream.ChannelLayout?.trim() ?? null,
      isDefault: Boolean(stream.IsDefault),
      isForced: Boolean(stream.IsForced),
      isExternal: Boolean(stream.IsExternal),
      label: buildPlaybackTrackLabel(stream)
    };
  };

  const audio = streams
    .filter(stream => stream.Type === 'Audio')
    .map(createOption)
    .filter((stream): stream is PlaybackTrackOption => Boolean(stream));
  const subtitles = streams
    .filter(stream => stream.Type === 'Subtitle')
    .map(createOption)
    .filter((stream): stream is PlaybackTrackOption => Boolean(stream));
  return { audio, subtitles };
}

function isLikelyEnglishTrack(language: string | null | undefined) {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'en' || normalized === 'eng' || normalized === 'english' || normalized.startsWith('en-');
}

export function isTrackIndexAvailable(options: PlaybackTrackOption[], index: number | null | undefined) {
  if (typeof index !== 'number' || !Number.isFinite(index)) return false;
  return options.some(option => option.index === index);
}

export function pickDefaultAudioTrackIndex(options: PlaybackTrackOption[], preferredIndex: number | null | undefined) {
  if (isTrackIndexAvailable(options, preferredIndex)) return preferredIndex ?? null;
  const english = options.find(option => isLikelyEnglishTrack(option.language));
  if (english) return english.index;
  const primary = options.find(option => option.isDefault);
  return primary?.index ?? options[0]?.index ?? null;
}

export function pickDefaultSubtitleTrackIndex(
  options: PlaybackTrackOption[],
  preferredIndex: number | null | undefined,
  defaultOff = false
) {
  if (preferredIndex === null) return null;
  if (isTrackIndexAvailable(options, preferredIndex)) return preferredIndex ?? null;
  if (defaultOff) return null;
  const forced = options.find(option => option.isForced);
  if (forced) return forced.index;
  const primary = options.find(option => option.isDefault);
  return primary?.index ?? null;
}
