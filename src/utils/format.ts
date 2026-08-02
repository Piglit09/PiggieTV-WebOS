const JELLYFIN_TICKS_PER_SECOND = 10_000_000;

export interface MediaSeekRange {
  start: number;
  end: number;
}

export function isFiniteMediaTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function finiteMediaDuration(value: unknown): number | null {
  return isFiniteMediaTime(value) && value > 0 ? value : null;
}

export function safeMediaPosition(value: unknown): number {
  return isFiniteMediaTime(value) ? value : 0;
}

export function secondsToTicks(seconds: unknown): number {
  if (!isFiniteMediaTime(seconds)) return 0;
  return Math.floor(seconds * JELLYFIN_TICKS_PER_SECOND);
}

export function toTickSeconds(ticks?: number | null) {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND);
}

export function formatMediaTime(seconds: unknown, unknownValue = '--:--') {
  if (!isFiniteMediaTime(seconds)) return unknownValue;

  const wholeSeconds = Math.floor(seconds);
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  const s = wholeSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatMediaDuration(seconds: unknown) {
  const duration = finiteMediaDuration(seconds);
  return duration == null ? '--:--' : formatMediaTime(duration);
}

export function clampMediaSeek(
  targetSeconds: unknown,
  durationSeconds: unknown,
  seekableRanges?: readonly MediaSeekRange[]
): number | null {
  if (!isFiniteMediaTime(targetSeconds)) return null;
  const duration = finiteMediaDuration(durationSeconds);
  if (duration == null) return null;

  const target = Math.min(targetSeconds, duration);
  if (seekableRanges === undefined) return target;

  const ranges = seekableRanges
    .filter(range => (
      isFiniteMediaTime(range.start) &&
      isFiniteMediaTime(range.end) &&
      range.end >= range.start
    ))
    .map(range => ({
      start: Math.min(range.start, duration),
      end: Math.min(range.end, duration)
    }))
    .filter(range => range.end >= range.start);

  if (!ranges.length) return null;
  for (const range of ranges) {
    if (target >= range.start && target <= range.end) return target;
  }

  let nearest = ranges[0]?.start ?? null;
  let nearestDistance = nearest == null ? Number.POSITIVE_INFINITY : Math.abs(target - nearest);
  for (const range of ranges) {
    for (const boundary of [range.start, range.end]) {
      const distance = Math.abs(target - boundary);
      if (distance < nearestDistance) {
        nearest = boundary;
        nearestDistance = distance;
      }
    }
  }
  return nearest;
}

export function toHms(ticks?: number | null) {
  if (typeof ticks === 'number' && !Number.isFinite(ticks)) return '--:--';
  return formatMediaTime(toTickSeconds(ticks), '0:00');
}

export function safeTruncate(value: string | null | undefined, maxLen = 120) {
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}
