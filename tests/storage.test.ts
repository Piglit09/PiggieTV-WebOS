import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageRepository } from '../src/storage/repository';
import {
  CURRENT_SCHEMA_VERSION,
  STORAGE_KEY,
  defaultStorageState,
  normalizeStoredServers
} from '../src/storage/sessionStore';
import type { PersistedSession } from '../src/storage/schema';

const session = (overrides: Partial<PersistedSession> = {}): PersistedSession => ({
  schemaVersion: 1,
  serverUrl: 'https://server.example.com',
  accessToken: 'secret-token',
  userId: 'user-1',
  userName: 'Piggie User',
  deviceId: 'device-1',
  deviceName: 'LG webOS TV',
  applicationVersion: '0.1.0',
  savedAt: 1_700_000_000_000,
  ...overrides
});

describe('canonical session storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('starts with the current empty schema', () => {
    const state = new StorageRepository().getState();
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(state.servers).toEqual([]);
    expect(state.session).toBeNull();
  });

  it('persists and verifies exactly one canonical session record', () => {
    const repository = new StorageRepository();
    repository.saveSession(session());

    expect(repository.getSession()).toEqual(session());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { session: Record<string, unknown> };
    expect(Object.keys(stored.session).sort()).toEqual([
      'accessToken',
      'applicationVersion',
      'deviceId',
      'deviceName',
      'savedAt',
      'schemaVersion',
      'serverUrl',
      'userId',
      'userName'
    ]);
  });

  it('does not mutate in-memory session state when persistence fails', () => {
    const repository = new StorageRepository();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    expect(() => repository.saveSession(session())).toThrow(/quota exceeded/i);
    expect(repository.getSession()).toBeNull();
    setItem.mockRestore();
  });

  it('generates one stable device id for repeated calls', () => {
    const repository = new StorageRepository();
    const first = repository.getOrCreateDeviceId();
    expect(first).toMatch(/^ptv-/);
    expect(repository.getOrCreateDeviceId()).toBe(first);
    expect(new StorageRepository().getOrCreateDeviceId()).toBe(first);
  });

  it('clears persisted authentication without deleting the selected server', () => {
    const repository = new StorageRepository();
    repository.setLastServer('https://server.example.com');
    repository.saveSession(session());
    repository.clearSession();

    expect(repository.getSession()).toBeNull();
    expect(repository.getLastServer()).toBe('https://server.example.com');
  });

  it('migrates the latest valid v1 user to the canonical session schema', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      servers: [{ serverId: 'server-1', baseUrl: 'https://server.example.com', connectedAt: 1 }],
      users: [
        {
          userId: 'old', userName: 'Old', accessToken: 'old-token', serverId: 'server-1',
          serverUrl: 'https://server.example.com', deviceId: 'old-device', createdAt: 1, updatedAt: 10
        },
        {
          userId: 'new', userName: 'New', accessToken: 'new-token', serverId: 'server-1',
          serverUrl: 'https://server.example.com', deviceId: 'new-device', createdAt: 1, updatedAt: 20
        }
      ],
      serverCapabilities: {},
      recentServers: [],
      lastUpdatedAt: 20
    }));

    const migrated = new StorageRepository().getSession();
    expect(migrated).toEqual(expect.objectContaining({
      schemaVersion: 1,
      userId: 'new',
      accessToken: 'new-token',
      deviceId: 'new-device'
    }));
  });

  it('drops malformed, incomplete, and future-schema sessions', () => {
    const base = defaultStorageState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...base,
      session: { ...session(), accessToken: '' }
    }));
    expect(new StorageRepository().getSession()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, schemaVersion: 999, session: session() }));
    expect(new StorageRepository().getSession()).toBeNull();
  });

  it('normalizes and de-duplicates stored server URLs', () => {
    const state = defaultStorageState();
    state.recentServers = [' server-a.example.com ', 'invalid host', 'server-a.example.com///'];
    state.servers = [{
      serverId: 'server-a',
      baseUrl: 'server-a.example.com',
      connectedAt: Date.now()
    }];
    normalizeStoredServers(state);
    expect(state.recentServers).toEqual(['https://server-a.example.com']);
    expect(state.servers[0]?.baseUrl).toBe('https://server-a.example.com');
  });

  it('falls back to an empty state for corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{ this is not JSON');
    expect(new StorageRepository().getState().session).toBeNull();
  });
});
