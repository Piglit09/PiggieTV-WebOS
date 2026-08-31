import {
  defaultStorageState,
  CURRENT_SCHEMA_VERSION,
  type PersistedSession,
  type PersistedSessionMetadata,
  type PersistentStorageState
} from './schema';
import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import { PTV_APPLICATION_VERSION, PTV_DEVICE_NAME } from '../config/app';
import type { PtvServerCapabilities, PtvServerSession } from '../types/ptv';

export { defaultStorageState, CURRENT_SCHEMA_VERSION };
export type { PersistedSession, PersistedSessionMetadata, PersistentStorageState };

export const STORAGE_KEY = 'ptv-webos-native-storage-v1';
export const PENDING_CLEAR_KEY = 'ptv-webos-auth-clear-pending-v1';
export const PENDING_CLEAR_SCHEMA_VERSION = 1;

export interface StorageSnapshot {
  state: PersistentStorageState;
  legacySession: PersistedSession | null;
  legacySessionStatus: 'none' | 'valid' | 'recoverable-invalid' | 'invalid';
  raw: string | null;
  rawKind: 'empty' | 'current' | 'legacy-current' | 'legacy-v1' | 'malformed' | 'future';
}

export interface PendingClearMarker {
  schemaVersion: typeof PENDING_CLEAR_SCHEMA_VERSION;
  credentialIds: string[];
}

export interface PendingClearSnapshot {
  present: boolean;
  valid: boolean;
  marker: PendingClearMarker;
}

interface LegacyPtvUserSession {
  userId: string;
  userName: string;
  accessToken: string;
  serverId: string;
  serverUrl: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
}

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

function normalizeSessionMetadata(value: unknown): PersistedSessionMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersistedSessionMetadata>;
  const serverUrl = isNonEmptyString(candidate.serverUrl)
    ? normalizeStoredServerUrl(candidate.serverUrl)
    : null;
  if (
    candidate.schemaVersion !== 2 ||
    candidate.credentialSchemaVersion !== 1 ||
    !isNonEmptyString(candidate.credentialId) ||
    !serverUrl ||
    !isNonEmptyString(candidate.serverId) ||
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
    schemaVersion: 2,
    credentialSchemaVersion: 1,
    credentialId: candidate.credentialId,
    serverUrl,
    serverId: candidate.serverId,
    userId: candidate.userId,
    userName: candidate.userName,
    deviceId: candidate.deviceId,
    deviceName: candidate.deviceName,
    applicationVersion: candidate.applicationVersion,
    savedAt: candidate.savedAt as number
  };
}

function normalizeLegacyCurrentSession(
  value: unknown,
  servers: PtvServerSession[]
): PersistedSession | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersistedSession>;
  const serverUrl = isNonEmptyString(candidate.serverUrl)
    ? normalizeStoredServerUrl(candidate.serverUrl)
    : null;
  const serverId = isNonEmptyString(candidate.serverId)
    ? candidate.serverId
    : servers.find(server => server.baseUrl === serverUrl)?.serverId;
  if (
    candidate.schemaVersion !== 1 ||
    !serverUrl ||
    !isNonEmptyString(serverId) ||
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
    serverId,
    accessToken: candidate.accessToken,
    userId: candidate.userId,
    userName: candidate.userName,
    deviceId: candidate.deviceId,
    deviceName: candidate.deviceName,
    applicationVersion: candidate.applicationVersion,
    savedAt: candidate.savedAt as number
  };
}

function hasPotentiallyRecoverableLegacyCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedSession>;
  return (
    isNonEmptyString(candidate.accessToken) &&
    isNonEmptyString(candidate.serverUrl) &&
    isNonEmptyString(candidate.userId) &&
    isNonEmptyString(candidate.userName) &&
    isNonEmptyString(candidate.deviceId)
  );
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

function migrateLegacyUsers(value: unknown): PersistedSession | null {
  if (!Array.isArray(value)) return null;
  const candidates = value
    .filter((entry): entry is LegacyPtvUserSession => Boolean(entry && typeof entry === 'object'))
    .filter(entry => (
      isNonEmptyString(entry.userId) &&
      isNonEmptyString(entry.userName) &&
      isNonEmptyString(entry.accessToken) &&
      isNonEmptyString(entry.serverId) &&
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
    serverId: latest.serverId,
    accessToken: latest.accessToken,
    userId: latest.userId,
    userName: latest.userName,
    deviceId: latest.deviceId,
    deviceName: PTV_DEVICE_NAME,
    applicationVersion: PTV_APPLICATION_VERSION,
    savedAt: Number.isFinite(latest.updatedAt) ? latest.updatedAt : Date.now()
  };
}

function normalizeBaseState(candidate: Record<string, unknown>): PersistentStorageState {
  const recentServers = normalizeRecentServers(candidate.recentServers);
  const lastServerUrl = isNonEmptyString(candidate.lastServerUrl)
    ? normalizeStoredServerUrl(candidate.lastServerUrl) ?? undefined
    : undefined;
  const session = normalizeSessionMetadata(candidate.session);
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

export function inspectStorage(): StorageSnapshot {
  if (typeof localStorage === 'undefined') {
    return {
      state: defaultStorageState(), legacySession: null, legacySessionStatus: 'none', raw: null, rawKind: 'empty'
    };
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {
      state: defaultStorageState(), legacySession: null, legacySessionStatus: 'invalid', raw: null, rawKind: 'malformed'
    };
  }
  if (!raw) {
    return { state: defaultStorageState(), legacySession: null, legacySessionStatus: 'none', raw, rawKind: 'empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      state: defaultStorageState(), legacySession: null, legacySessionStatus: 'invalid', raw, rawKind: 'malformed'
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      state: defaultStorageState(), legacySession: null, legacySessionStatus: 'invalid', raw, rawKind: 'malformed'
    };
  }
  const candidate = parsed as Record<string, unknown>;
  const sourceVersion = typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0;
  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    return {
      state: defaultStorageState(), legacySession: null, legacySessionStatus: 'invalid', raw, rawKind: 'future'
    };
  }

  const state = normalizeBaseState(candidate);
  if (sourceVersion === CURRENT_SCHEMA_VERSION) {
    const invalidCurrentSession = candidate.session != null && state.session === null;
    return {
      state,
      legacySession: null,
      legacySessionStatus: invalidCurrentSession ? 'invalid' : 'none',
      raw,
      rawKind: 'current'
    };
  }
  if (sourceVersion >= 2) {
    const legacySession = normalizeLegacyCurrentSession(candidate.session, state.servers);
    if (legacySession) state.lastServerUrl = state.lastServerUrl ?? legacySession.serverUrl;
    const legacySessionStatus = legacySession
      ? 'valid'
      : candidate.session == null
        ? 'none'
        : hasPotentiallyRecoverableLegacyCredential(candidate.session)
          ? 'recoverable-invalid'
          : 'invalid';
    return {
      state,
      legacySession,
      legacySessionStatus,
      raw,
      rawKind: 'legacy-current'
    };
  }
  const legacySession = migrateLegacyUsers(candidate.users);
  if (legacySession) state.lastServerUrl = state.lastServerUrl ?? legacySession.serverUrl;
  const legacySessionStatus = legacySession
    ? 'valid'
    : candidate.users == null
      ? 'none'
      : Array.isArray(candidate.users) && candidate.users.some(hasPotentiallyRecoverableLegacyCredential)
        ? 'recoverable-invalid'
        : 'invalid';
  return {
    state,
    legacySession,
    legacySessionStatus,
    raw,
    rawKind: 'legacy-v1'
  };
}

export function normalizeStoredServers(state: PersistentStorageState): void {
  state.servers = normalizeServers(state.servers);
  state.recentServers = normalizeRecentServers(state.recentServers);
  state.session = normalizeSessionMetadata(state.session);
  if (state.lastServerUrl) {
    state.lastServerUrl = normalizeStoredServerUrl(state.lastServerUrl) ?? undefined;
  }
}

export function readStorage(): PersistentStorageState {
  return inspectStorage().state;
}

export function writeStorage(state: PersistentStorageState): void {
  if (typeof localStorage === 'undefined') throw new Error('Persistent storage is unavailable');
  const next: PersistentStorageState = {
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastUpdatedAt: Date.now()
  };
  normalizeStoredServers(next);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function restoreRawStorage(raw: string | null): void {
  if (typeof localStorage === 'undefined') throw new Error('Persistent storage is unavailable');
  if (raw === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, raw);
  if (localStorage.getItem(STORAGE_KEY) !== raw) {
    throw new Error('Unable to verify restored persistent storage');
  }
}

export function readPendingClear(): PendingClearSnapshot {
  const empty: PendingClearMarker = {
    schemaVersion: PENDING_CLEAR_SCHEMA_VERSION,
    credentialIds: []
  };
  if (typeof localStorage === 'undefined') return { present: false, valid: true, marker: empty };
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_CLEAR_KEY);
  } catch {
    return { present: true, valid: false, marker: empty };
  }
  if (raw === null) return { present: false, valid: true, marker: empty };
  try {
    const parsed = JSON.parse(raw) as Partial<PendingClearMarker>;
    if (
      parsed.schemaVersion !== PENDING_CLEAR_SCHEMA_VERSION ||
      !Array.isArray(parsed.credentialIds) ||
      parsed.credentialIds.some(value => !isNonEmptyString(value))
    ) {
      return { present: true, valid: false, marker: empty };
    }
    return {
      present: true,
      valid: true,
      marker: {
        schemaVersion: PENDING_CLEAR_SCHEMA_VERSION,
        credentialIds: Array.from(new Set(parsed.credentialIds))
      }
    };
  } catch {
    return { present: true, valid: false, marker: empty };
  }
}

export function writePendingClear(credentialIds: string[]): void {
  if (typeof localStorage === 'undefined') throw new Error('Persistent storage is unavailable');
  const marker: PendingClearMarker = {
    schemaVersion: PENDING_CLEAR_SCHEMA_VERSION,
    credentialIds: Array.from(new Set(credentialIds.filter(isNonEmptyString)))
  };
  localStorage.setItem(PENDING_CLEAR_KEY, JSON.stringify(marker));
  const confirmed = readPendingClear();
  if (!confirmed.present || !confirmed.valid) throw new Error('Unable to verify pending credential clear marker');
}

export function removePendingClear(): void {
  if (typeof localStorage === 'undefined') throw new Error('Persistent storage is unavailable');
  localStorage.removeItem(PENDING_CLEAR_KEY);
  if (readPendingClear().present) throw new Error('Unable to remove pending credential clear marker');
}

export function clearStorage(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function mergeRecent(state: PersistentStorageState, serverUrl: string): void {
  const normalized = normalizeStoredServerUrl(serverUrl);
  if (!normalized) return;
  state.recentServers = [normalized, ...state.recentServers.filter(item => item !== normalized)].slice(0, 10);
}
