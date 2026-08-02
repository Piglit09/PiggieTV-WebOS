export const PTV_PRODUCTION_SERVER_URL = 'https://PiggieTV.com';
const LOCAL_SERVER_OVERRIDE_KEY = 'ptvDefaultServerUrl';

function getRuntimeServerOverride(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const override = new URL(window.location.href).searchParams.get('server');
    if (override && override.trim()) {
      return override.trim();
    }
  } catch {
    // ignore bad URLs in browser state
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(LOCAL_SERVER_OVERRIDE_KEY);
      if (stored && stored.trim()) {
        return stored.trim();
      }
    }
  } catch {
    // ignore storage access issues
  }

  return null;
}

function stripTrailingSlashes(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function isLikelyLocalApiHost(hostname: string) {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.endsWith('.local')
  );
}

export function getDefaultServerUrl(): string {
  if (import.meta.env.MODE === 'test') {
    return PTV_PRODUCTION_SERVER_URL;
  }

  const runtimeOverride = getRuntimeServerOverride();
  if (runtimeOverride) {
    return stripTrailingSlashes(runtimeOverride);
  }

  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    try {
      const current = new URL(window.location.origin);
      if (isLikelyLocalApiHost(current.hostname)) {
        return stripTrailingSlashes(current.origin);
      }
    } catch {
      // ignore and keep production default
    }
  }

  const configuredDefault = import.meta.env?.VITE_PTV_DEFAULT_SERVER_URL?.trim();
  if (configuredDefault) {
    return stripTrailingSlashes(configuredDefault);
  }

  return PTV_PRODUCTION_SERVER_URL;
}
