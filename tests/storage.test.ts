import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryProtectedCredentialStoreForTests,
  setCredentialStoreFactoryForTests,
  type CredentialBinding,
  type ProtectedCredentialStore
} from '../src/storage/credentialStore';
import {
  InvalidLocalSessionError,
  SecureStorageError,
  StorageOperationCancelledError,
  StorageRepository
} from '../src/storage/repository';
import {
  CURRENT_SCHEMA_VERSION,
  PENDING_CLEAR_KEY,
  STORAGE_KEY,
  defaultStorageState,
  normalizeStoredServers
} from '../src/storage/sessionStore';
import type { PersistedSession } from '../src/storage/schema';

const TEST_TOKEN = 'disposable-storage-test-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const session = (overrides: Partial<PersistedSession> = {}): PersistedSession => ({
  schemaVersion: 1,
  serverUrl: 'https://server.example.com',
  serverId: 'server-1',
  accessToken: TEST_TOKEN,
  userId: 'user-1',
  userName: 'Piggie User',
  deviceId: 'device-1',
  deviceName: 'LG webOS TV',
  applicationVersion: '0.1.16',
  savedAt: 1_700_000_000_000,
  ...overrides
});

class ControlledProtectedStore implements ProtectedCredentialStore {
  public readonly events: string[] = [];
  public failWrite = false;
  public failNextRead = false;
  public failDelete = false;
  public afterWrite: (() => void) | null = null;
  public writeGate: Promise<void> | null = null;
  public deleteGate: Promise<void> | null = null;
  private readonly values = new Map<string, { binding: string; token: string }>();
  private keyPresent = false;

  public async writeCredential(
    binding: CredentialBinding,
    accessToken: string,
    assertWritable?: () => void
  ): Promise<void> {
    this.events.push('write');
    if (this.writeGate) await this.writeGate;
    assertWritable?.();
    if (this.failWrite) throw new Error('controlled write failure');
    this.keyPresent = true;
    this.values.set(binding.credentialId, { binding: JSON.stringify(binding), token: accessToken });
    this.afterWrite?.();
  }

  public async readCredential(binding: CredentialBinding): Promise<string | null> {
    this.events.push('read');
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('controlled read failure');
    }
    const value = this.values.get(binding.credentialId);
    return value?.binding === JSON.stringify(binding) ? value.token : null;
  }

  public async deleteCredential(credentialId: string): Promise<void> {
    this.events.push('delete');
    if (this.deleteGate) await this.deleteGate;
    if (this.failDelete) throw new Error('controlled delete failure');
    this.values.delete(credentialId);
  }

  public async hasCredential(credentialId: string): Promise<boolean> {
    this.events.push('has');
    return this.values.has(credentialId);
  }

  public async clearAllCredentialsAndKey(): Promise<void> {
    this.events.push('clear-all');
    if (this.failDelete) throw new Error('controlled delete failure');
    this.values.clear();
    this.keyPresent = false;
  }

  public async hasAnyCredential(): Promise<boolean> {
    this.events.push('has-any');
    return this.values.size > 0;
  }

  public async hasKey(): Promise<boolean> {
    this.events.push('has-key');
    return this.keyPresent;
  }

  public get size(): number {
    return this.values.size;
  }
}

function writeLegacyCurrent(legacySession: PersistedSession = session()): string {
  const legacyRecord = { ...legacySession } as Partial<PersistedSession>;
  delete legacyRecord.serverId;
  const raw = JSON.stringify({
    schemaVersion: 2,
    servers: [{ serverId: 'server-1', baseUrl: legacySession.serverUrl, connectedAt: 1 }],
    session: legacyRecord,
    serverCapabilities: {
      'server-1': { version: '10.10.7', features: [] }
    },
    recentServers: [legacySession.serverUrl],
    lastServerUrl: legacySession.serverUrl,
    lastUpdatedAt: legacySession.savedAt
  });
  localStorage.setItem(STORAGE_KEY, raw);
  return raw;
}

describe('protected canonical session storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    setCredentialStoreFactoryForTests(null);
  });

  afterEach(() => {
    setCredentialStoreFactoryForTests(null);
  });

  it('starts with the current empty schema without touching protected storage', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);

    expect(repository.getState().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(repository.hasStoredSession()).toBe(false);
    expect(await repository.restoreSession()).toBeNull();
    expect(store.events).toEqual([]);
  });

  it('writes, reads back, then activates tokenless metadata', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    const localWrites: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === STORAGE_KEY) localWrites.push(value);
      originalSetItem.call(this, key, value);
    });

    await repository.saveSession(session());

    expect(store.events.slice(0, 2)).toEqual(['write', 'read']);
    expect(localWrites).toHaveLength(1);
    expect(localWrites[0]).not.toContain(TEST_TOKEN);
    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain(TEST_TOKEN);
    expect(raw).not.toContain('accessToken');
    expect(repository.getState().session).toEqual(expect.objectContaining({
      schemaVersion: 2,
      credentialSchemaVersion: 1,
      userId: 'user-1'
    }));

    const restored = await new StorageRepository(store).restoreSession();
    expect(restored).toEqual(session());
  });

  it('supports an explicit shared test factory without production memory fallback', async () => {
    const store = new InMemoryProtectedCredentialStoreForTests();
    setCredentialStoreFactoryForTests(() => store);
    await new StorageRepository().saveSession(session());
    await expect(new StorageRepository().restoreSession()).resolves.toEqual(session());
  });

  it('preserves the prior active session when candidate verification fails', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    const original = session({ accessToken: 'prior-test-token', userId: 'prior-user' });
    await repository.saveSession(original);
    const priorRaw = localStorage.getItem(STORAGE_KEY);
    store.failNextRead = true;

    await expect(repository.saveSession(session({ userId: 'candidate-user' })))
      .rejects.toMatchObject({ code: 'SECURE_STORAGE_FAILURE' });

    expect(localStorage.getItem(STORAGE_KEY)).toBe(priorRaw);
    expect(repository.getSession()).toEqual(original);
    expect(store.size).toBe(1);
  });

  it('migrates the 0.1.15 current schema only after protected readback succeeds', async () => {
    const raw = writeLegacyCurrent();
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    expect(raw).toContain(TEST_TOKEN);

    await expect(repository.restoreSession()).resolves.toEqual(session());

    expect(store.events.slice(0, 2)).toEqual(['write', 'read']);
    const migratedRaw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(migratedRaw).not.toContain(TEST_TOKEN);
    expect(migratedRaw).not.toContain('accessToken');
    expect(JSON.parse(migratedRaw)).toEqual(expect.objectContaining({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      serverCapabilities: expect.objectContaining({ 'server-1': expect.any(Object) })
    }));
  });

  it('migrates the newest valid v1 user and removes every legacy user token', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      servers: [{ serverId: 'server-1', baseUrl: 'https://server.example.com', connectedAt: 1 }],
      users: [
        {
          userId: 'old', userName: 'Old', accessToken: 'old-test-token', serverId: 'server-1',
          serverUrl: 'https://server.example.com', deviceId: 'old-device', createdAt: 1, updatedAt: 10
        },
        {
          userId: 'new', userName: 'New', accessToken: TEST_TOKEN, serverId: 'server-1',
          serverUrl: 'https://server.example.com', deviceId: 'new-device', createdAt: 1, updatedAt: 20
        }
      ],
      serverCapabilities: {},
      recentServers: [],
      lastUpdatedAt: 20
    }));
    const store = new ControlledProtectedStore();

    const migrated = await new StorageRepository(store).restoreSession();

    expect(migrated).toEqual(expect.objectContaining({ userId: 'new', accessToken: TEST_TOKEN }));
    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain(TEST_TOKEN);
    expect(raw).not.toContain('old-test-token');
    expect(raw).not.toContain('users');
  });

  it('preserves exact legacy plaintext evidence and refuses authentication on migration failure', async () => {
    const originalRaw = writeLegacyCurrent();
    const store = new ControlledProtectedStore();
    store.failNextRead = true;
    const repository = new StorageRepository(store);

    await expect(repository.restoreSession()).rejects.toBeInstanceOf(SecureStorageError);

    expect(localStorage.getItem(STORAGE_KEY)).toBe(originalRaw);
    expect(repository.getSession()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('does not activate a verified candidate after its operation is superseded', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    let current = true;
    store.afterWrite = () => { current = false; };

    await expect(repository.saveSession(session(), { isCurrent: () => current }))
      .rejects.toBeInstanceOf(StorageOperationCancelledError);

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.size).toBe(0);
    expect(repository.getSession()).toBeNull();
  });

  it('commits replacement ownership without awaiting prior encrypted-record cleanup', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    await repository.saveSession(session({ accessToken: 'prior-test-token', userId: 'prior-user' }));
    const deletion = deferred<void>();
    store.deleteGate = deletion.promise;
    let settled = false;

    const replacement = repository.saveSession(
      session({ userId: 'replacement-user' }),
      { isCurrent: () => true },
      () => 'replacement-ticket'
    ).then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(replacement).resolves.toBe('replacement-ticket');
    expect(repository.getSession()).toEqual(expect.objectContaining({ userId: 'replacement-user' }));
    expect(store.size).toBe(2);

    deletion.resolve();
    await vi.waitFor(() => expect(store.size).toBe(1));
  });

  it('deletes a staged candidate only after exact prior metadata rollback is verified', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);

    await expect(repository.saveSession(session(), undefined, () => {
      throw new Error('activation rejected');
    })).rejects.toThrow('activation rejected');

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('retains the verified candidate when metadata rollback cannot be proven', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (key) {
      if (key === STORAGE_KEY) throw new Error('controlled rollback failure');
      originalRemoveItem.call(this, key);
    });

    await expect(repository.saveSession(session(), undefined, () => {
      throw new Error('activation rejected');
    })).rejects.toThrow('activation rejected');

    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain(TEST_TOKEN);
    expect(raw).not.toContain('accessToken');
    expect(store.size).toBe(1);
    await expect(new StorageRepository(store).restoreSession()).resolves.toEqual(session());
  });

  it('does not recreate a credential after logout supersedes a queued secure write', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    const blockedWrite = deferred<void>();
    store.writeGate = blockedWrite.promise;
    let current = true;
    const pendingSave = repository.saveSession(session(), { isCurrent: () => current });
    await vi.waitFor(() => expect(store.events).toContain('write'));

    current = false;
    repository.armSessionClearBarrier();
    await repository.completePendingSessionClear();
    blockedWrite.resolve();

    await expect(pendingSave).rejects.toBeInstanceOf(StorageOperationCancelledError);
    expect(store.size).toBe(0);
    expect(await store.hasKey()).toBe(false);
  });

  it('classifies a missing protected credential as invalid and clears without a restart loop', async () => {
    const originalStore = new ControlledProtectedStore();
    await new StorageRepository(originalStore).saveSession(session());
    const missingStore = new ControlledProtectedStore();
    const restarted = new StorageRepository(missingStore);

    await expect(restarted.restoreSession()).rejects.toBeInstanceOf(InvalidLocalSessionError);
    restarted.armSessionClearBarrier();
    await restarted.completePendingSessionClear();

    await expect(new StorageRepository(missingStore).restoreSession()).resolves.toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').session).toBeNull();
  });

  it('arms the durable logout barrier synchronously before asynchronous deletion', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    await repository.saveSession(session());

    repository.armSessionClearBarrier();

    const marker = JSON.parse(localStorage.getItem(PENDING_CLEAR_KEY) ?? '{}') as {
      schemaVersion?: number;
      credentialIds?: string[];
    };
    expect(marker.schemaVersion).toBe(1);
    expect(marker.credentialIds).toHaveLength(1);
    expect(JSON.stringify(marker)).not.toContain(TEST_TOKEN);
    expect(repository.hasStoredSession()).toBe(false);

    await repository.clearSession();
    expect(localStorage.getItem(PENDING_CLEAR_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').session).toBeNull();
    expect(store.size).toBe(0);
    expect(store.events).toEqual(expect.arrayContaining(['clear-all', 'has-any', 'has-key']));
  });

  it('preserves a legacy token when its Jellyfin server identity cannot be recovered', async () => {
    const legacyRecord = { ...session() } as Partial<PersistedSession>;
    delete legacyRecord.serverId;
    const raw = JSON.stringify({
      schemaVersion: 2,
      servers: [],
      session: legacyRecord,
      serverCapabilities: {},
      recentServers: [legacyRecord.serverUrl],
      lastServerUrl: legacyRecord.serverUrl,
      lastUpdatedAt: legacyRecord.savedAt
    });
    localStorage.setItem(STORAGE_KEY, raw);
    const repository = new StorageRepository(new ControlledProtectedStore());

    expect(repository.hasStoredSession()).toBe(true);
    await expect(repository.restoreSession()).rejects.toMatchObject({ code: 'SECURE_STORAGE_FAILURE' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(repository.getSession()).toBeNull();
  });

  it('keeps the clear marker on interruption and startup safely retries to completion', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    await repository.saveSession(session());
    store.failDelete = true;

    await expect(repository.clearSession()).rejects.toMatchObject({ code: 'SECURE_STORAGE_FAILURE' });
    expect(localStorage.getItem(PENDING_CLEAR_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').session).toBeNull();
    expect(store.size).toBe(1);

    store.failDelete = false;
    const restarted = new StorageRepository(store);
    await expect(restarted.restoreSession()).resolves.toBeNull();
    expect(localStorage.getItem(PENDING_CLEAR_KEY)).toBeNull();
    expect(store.size).toBe(0);
    expect(restarted.getSession()).toBeNull();
  });

  it('preserves unrelated server data through migration and logout cleanup', async () => {
    writeLegacyCurrent();
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    await repository.restoreSession();
    await repository.clearSession();

    const state = repository.getState();
    expect(state.servers).toEqual([expect.objectContaining({ serverId: 'server-1' })]);
    expect(state.serverCapabilities).toEqual(expect.objectContaining({
      'server-1': expect.objectContaining({ version: '10.10.7' })
    }));
    expect(state.recentServers).toEqual(['https://server.example.com']);
    expect(state.lastServerUrl).toBe('https://server.example.com');
  });

  it('updates harmless metadata without rewriting the protected credential', async () => {
    const store = new ControlledProtectedStore();
    const repository = new StorageRepository(store);
    await repository.saveSession(session());
    store.events.length = 0;

    repository.updateSessionMetadata({ userName: 'Updated Name', savedAt: 1_800_000_000_000 });

    expect(store.events).toEqual([]);
    expect(repository.getState().session).toEqual(expect.objectContaining({
      userName: 'Updated Name',
      savedAt: 1_800_000_000_000
    }));
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(TEST_TOKEN);
  });

  it('fails closed and sanitizes malformed/future local auth during an armed clear', async () => {
    const store = new ControlledProtectedStore();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 999,
      session: { accessToken: TEST_TOKEN }
    }));
    const repository = new StorageRepository(store);

    repository.armSessionClearBarrier();
    await repository.completePendingSessionClear();

    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain(TEST_TOKEN);
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      session: null
    }));
  });

  it('normalizes and de-duplicates harmless stored server URLs', () => {
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
});
