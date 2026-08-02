import type { PtvItemKind, PtvNavigationIntent, PtvRoute, PtvPlaybackIntent } from '../types/ptv';

export const PTV_ROUTES = [
  'startup',
  'server',
  'auth',
  'quick-connect',
  'home',
  'movies',
  'shows',
  'search',
  'details',
  'settings',
  'diagnostics',
  'playback'
] as const;

export type PtvScreen = (typeof PTV_ROUTES)[number];

export function toRouteString(route: PtvRoute): string {
  const base = route.screen;
  if (route.itemId) return `${base}:${route.itemId}`;
  if (route.sectionId) return `${base}?section=${route.sectionId}`;
  return base;
}

export function buildRoute(screen: PtvScreen, itemId?: string | null, sectionId?: string | null): PtvRoute {
  return {
    screen,
    itemId: itemId ?? null,
    sectionId: sectionId ?? null
  };
}

export function createNavigationIntent(
  route: PtvRoute,
  itemType?: PtvItemKind | null,
  kind: PtvNavigationIntent['kind'] = 'details',
  metadata: Record<string, string | null> = {}
): PtvNavigationIntent {
  return {
    kind,
    targetId: route.itemId ?? null,
    metadata: {
      ...metadata,
      itemType,
      rowId: route.sectionId ?? null
    }
  };
}

export function playbackRouteFromIntent(intent: PtvPlaybackIntent): PtvRoute {
  return {
    screen: 'playback',
    itemId: intent.itemId,
    sectionId: null
  };
}
