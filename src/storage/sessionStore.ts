import {
  defaultStorageState,
  CURRENT_SCHEMA_VERSION,
  type PersistedSession,
  type PersistentStorageState
} from './schema';
import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import { PTV_APPLICATION_VERSION, PTV_DEVICE_NAME } from '../config/app';
import type { PtvServerCapabilities, PtvServerSession, PtvUserSession } from '../types/ptv';

export { defaultStorageState, CURRENT_SCHEMA_VERSION };
export type { PersistedSession, PersistentStorageState };

export const STORAGE_KEY = 'ptv-webos-native-storage-v1';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStoredServerUrl(raw: string): string | null {
  try {
    return normalizeServerUrl(raw);
  } catch {
    return null;
  }
}

function normalizeSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersistedSession>;
  const serverUrl = isNonEmptyString(candidate.serverUrl)
    ? normalizeStoredServerUrl(candidate.serverUrl)
    : null;

  if (
    candidate.schemaVersion !== 1 ||
    !serverUrl ||
    !isNonEmptyString(candidate.accessToken) ||
    !isNonEmptyString(candidate.userId) ||
    !isNonEmptyString(candidate.userName) ||
    !isNonEmptyString(candidate.deviceId) ||
    !isNonEmptyString(candidate.deviceName) ||
    !isNonEmptyString(candidate.applicationVersion) ||
    !Number.isFinite(candidate.savedAt)
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    serverUrl,
    accessToken: candidate.accessToken,
    userId: candidate.userId,
    userName: candidate.userName,
    deviceId: candidate.deviceId,
    deviceName: candidate.deviceName,
    applicationVersion: candidate.applicationVersion,
    savedAt: candidate.savedAt as number
  };
}

function normalizeServers(value: unknown): PtvServerSession[] {
  if (!Array.isArray(value)) return [];
  const byUrl = new Map<string, PtvServerSession>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<PtvServerSession>;
    const baseUrl = isNonEmptyString(candidate.baseUrl)
      ? normalizeStoredServerUrl(candidate.baseUrl)
      : null;
    if (!baseUrl || !isNonEmptyString(candidate.serverId)) continue;
    byUrl.set(baseUrl, {
      serverId: candidate.serverId,
      baseUrl,
      serverName: isNonEmptyString(candidate.serverName) ? candidate.serverName : undefined,
      serverVersion: isNonEmptyString(candidate.serverVersion) ? candidate.serverVersion : undefined,
      connectedAt: Number.isFinite(candidate.connectedAt) ? candidate.connectedAt as number : Date.now(),
      lastValidatedAt: Number.isFinite(candidate.lastValidatedAt) ? candidate.lastValidatedAt : undefined
    });
  }

  return Array.from(byUrl.values());
}

function normalizeRecentServers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) continue;
    const normalized = normalizeStoredServerUrl(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === 10) break;
  }
  return result;
}

function migrateLegacySession(value: unknown): PersistedSession | null {
  if (!Array.isArray(value)) return null;
  const candidates = value
    .filter((entry): entry is PtvUserSession => Boolean(entry && typeof entry === 'object'))
    .filter(entry => (
      isNonEmptyString(entry.userId) &&
      isNonEmptyString(entry.userName) &&
      isNonEmptyString(entry.accessToken) &&
      isNonEmptyString(entry.serverUrl) &&
      isNonEmptyString(entry.deviceId)
    ))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const latest = candidates[0];
  if (!latest) return null;
  const serverUrl = normalizeStoredServerUrl(latest.serverUrl);
  if (!serverUrl) return null;
  return {
    schemaVersion: 1,
    serverUrl,
    accessToken: latest.accessToken,
    userId: latest.userId,
    userName: latest.userName,
    deviceId: latest.deviceId,
    deviceName: PTV_DEVICE_NAME,
    applicationVersion: PTV_APPLICATION_VERSION,
    savedAt: Number.isFinite(latest.updatedAt) ? latest.updatedAt : Date.now()
  };
}

function migrateState(raw: unknown): PersistentStorageState {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
  if (!parsed || typeof parsed !== 'object') return defaultStorageState();
  const candidate = parsed as Record<string, unknown>;
  const sourceVersion = typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0;
  if (sourceVersion > CURRENT_SCHEMA_VERSION) return defaultStorageState();

  const recentServers = normalizeRecentServers(candidate.recentServers);
  const lastServerUrl = isNonEmptyString(candidate.lastServerUrl)
    ? normalizeStoredServerUrl(candidate.lastServerUrl) ?? undefined
    : undefined;
  const session = sourceVersion >= 2
    ? normalizeSession(candidate.session)
    : migrateLegacySession(candidate.users);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    servers: normalizeServers(candidate.servers),
    session,
    serverCapabilities: candidate.serverCapabilities && typeof candidate.serverCapabilities === 'object'
      ? candidate.serverCapabilities as Record<string, PtvServerCapabilities>
      : {},
    recentServers,
    lastServerUrl: lastServerUrl ?? session?.serverUrl,
    lastUpdatedAt: typeof candidate.lastUpdatedAt === 'number' && Number.isFinite(candidate.lastUpdatedAt)
      ? candidate.lastUpdatedAt
      : Date.now()
  };
}

export function normalizeStoredServers(state: PersistentStorageState) {
  state.servers = normalizeServers(state.servers);
  state.recentServers = normalizeRecentServers(state.recentServers);
  state.session = normalizeSession(state.session);
  if (state.lastServerUrl) {
    state.lastServerUrl = normalizeStoredServerUrl(state.lastServerUrl) ?? undefined;
  }
}

export function readStorage(): PersistentStorageState {
  if (typeof localStorage === 'undefined') return defaultStorageState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStorageState();
    const state = migrateState(raw);
    normalizeStoredServers(state);
    return state;
  } catch {
    return defaultStorageState();
  }
}

export function writeStorage(state: PersistentStorageState): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('Persistent storage is unavailable');
  }
  const next: PersistentStorageState = {
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastUpdatedAt: Date.now()
  };
  normalizeStoredServers(next);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function clearStorage() {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function mergeRecent(state: PersistentStorageState, serverUrl: string) {
  const normalized = normalizeStoredServerUrl(serverUrl);
  if (!normalized) return;
  state.recentServers = [normalized, ...state.recentServers.filter(item => item !== normalized)].slice(0, 10);
}
