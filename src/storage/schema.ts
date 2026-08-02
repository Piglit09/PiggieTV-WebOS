import type { PtvServerSession, PtvServerCapabilities } from '../types/ptv';

export interface PersistedSession {
  schemaVersion: 1;
  serverUrl: string;
  accessToken: string;
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
  session: PersistedSession | null;
  serverCapabilities: Record<string, PtvServerCapabilities>;
  recentServers: string[];
  lastServerUrl?: string;
  lastUpdatedAt: number;
}

export const CURRENT_SCHEMA_VERSION = 2;

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
