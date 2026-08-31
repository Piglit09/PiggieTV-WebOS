import type { PtvServerSession, PtvServerCapabilities } from '../types/ptv';

/**
 * The in-memory session shape used by the authentication coordinator. Tokens in
 * this shape must never be serialized to localStorage by the current schema.
 */
export interface PersistedSession {
  schemaVersion: 1;
  serverUrl: string;
  serverId: string;
  accessToken: string;
  userId: string;
  userName: string;
  deviceId: string;
  deviceName: string;
  applicationVersion: string;
  savedAt: number;
}

/** Tokenless localStorage pointer to an encrypted credential in IndexedDB. */
export interface PersistedSessionMetadata {
  schemaVersion: 2;
  credentialSchemaVersion: 1;
  credentialId: string;
  serverUrl: string;
  serverId: string;
  userId: string;
  userName: string;
  deviceId: string;
  deviceName: string;
  applicationVersion: string;
  savedAt: number;
}

export interface PersistentStorageState {
  schemaVersion: number;
  servers: PtvServerSession[];
  session: PersistedSessionMetadata | null;
  serverCapabilities: Record<string, PtvServerCapabilities>;
  recentServers: string[];
  lastServerUrl?: string;
  lastUpdatedAt: number;
}

export const CURRENT_SCHEMA_VERSION = 3;

export function defaultStorageState(): PersistentStorageState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    servers: [],
    session: null,
    serverCapabilities: {},
    recentServers: [],
    lastUpdatedAt: Date.now()
  };
}
