import type { PtvServerCapabilities, PtvServerSession, PtvUserSession } from '../types/ptv';
import {
  PTV_APPLICATION_VERSION,
  PTV_DEVICE_ID_STORAGE_KEY,
  PTV_DEVICE_NAME
} from '../config/app';
import {
  mergeRecent,
  normalizeStoredServers,
  readStorage,
  writeStorage,
  type PersistedSession,
  type PersistentStorageState
} from './sessionStore';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDeviceId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint32Array(4);
      crypto.getRandomValues(values);
      return `ptv-${Array.from(values).map(value => value.toString(16).padStart(8, '0')).join('')}`;
    }
  } catch {
    // A deterministic in-memory fallback is still preferable to a shared device id.
  }
  return `ptv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class StorageRepository {
  private state: PersistentStorageState;
  private deviceId: string | null = null;

  constructor() {
    this.state = readStorage();
    normalizeStoredServers(this.state);
  }

  public getState(): PersistentStorageState {
    return clone(this.state);
  }

  private commit(next: PersistentStorageState) {
    writeStorage(next);
    this.state = clone(next);
    normalizeStoredServers(this.state);
  }

  public persist() {
    this.commit(this.state);
  }

  public clearAll() {
    this.commit({
      ...this.state,
      servers: [],
      session: null,
      serverCapabilities: {},
      lastServerUrl: undefined
    });
  }

  public getOrCreateDeviceId(): string {
    if (this.deviceId) return this.deviceId;
    const fromSession = this.state.session?.deviceId;
    if (fromSession) {
      this.deviceId = fromSession;
      return fromSession;
    }

    try {
      const stored = typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(PTV_DEVICE_ID_STORAGE_KEY);
      if (stored && stored.trim()) {
        this.deviceId = stored.trim();
        return this.deviceId;
      }
    } catch {
      // The session save path will surface persistent-storage failures to the user.
    }

    this.deviceId = createDeviceId();
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PTV_DEVICE_ID_STORAGE_KEY, this.deviceId);
      }
    } catch {
      // Keep the generated id stable for this app lifetime.
    }
    return this.deviceId;
  }

  public getSession(): PersistedSession | null {
    return this.state.session ? clone(this.state.session) : null;
  }

  public saveSession(session: PersistedSession) {
    const next = clone(this.state);
    next.session = clone(session);
    next.lastServerUrl = session.serverUrl;
    mergeRecent(next, session.serverUrl);
    this.commit(next);

    const confirmed = readStorage().session;
    if (
      !confirmed ||
      confirmed.serverUrl !== session.serverUrl ||
      confirmed.userId !== session.userId ||
      confirmed.accessToken !== session.accessToken ||
      confirmed.deviceId !== session.deviceId
    ) {
      throw new Error('Unable to verify the saved session');
    }
    this.deviceId = session.deviceId;
  }

  public clearSession() {
    if (!this.state.session) return;
    const next = clone(this.state);
    next.session = null;
    this.commit(next);
  }

  public getRecentServers(): string[] {
    return [...this.state.recentServers];
  }

  public setLastServer(serverUrl: string) {
    const next = clone(this.state);
    const normalized = serverUrl.trim().replace(/\/+$/, '');
    next.lastServerUrl = normalized;
    mergeRecent(next, normalized);
    this.commit(next);
  }

  public getLastServer(): string | null {
    return this.state.lastServerUrl ?? null;
  }

  public findServerByUrl(serverUrl: string): PtvServerSession | null {
    const normalized = serverUrl.trim().replace(/\/+$/, '');
    const server = this.state.servers.find(entry => entry.baseUrl === normalized);
    return server ? clone(server) : null;
  }

  public removeServerByUrl(serverUrl: string) {
    const normalized = serverUrl.trim().replace(/\/+$/, '');
    const next = clone(this.state);
    next.servers = next.servers.filter(item => item.baseUrl !== normalized);
    next.recentServers = next.recentServers.filter(item => item !== normalized);
    if (next.session?.serverUrl === normalized) next.session = null;
    if (next.lastServerUrl === normalized) next.lastServerUrl = next.recentServers[0];
    this.commit(next);
  }

  public upsertServer(session: PtvServerSession) {
    const next = clone(this.state);
    const existingIndex = next.servers.findIndex(item => (
      item.serverId === session.serverId || item.baseUrl === session.baseUrl
    ));
    if (existingIndex >= 0) next.servers[existingIndex] = clone(session);
    else next.servers.push(clone(session));
    mergeRecent(next, session.baseUrl);
    next.lastServerUrl = session.baseUrl;
    this.commit(next);
  }

  public upsertServerCapabilities(serverId: string, capabilities: PtvServerCapabilities) {
    const next = clone(this.state);
    next.serverCapabilities[serverId] = clone(capabilities);
    this.commit(next);
  }

  public getServerCapabilities(serverId: string): PtvServerCapabilities | null {
    const value = this.state.serverCapabilities[serverId];
    return value ? clone(value) : null;
  }

  public removeServerCapabilities(serverId: string) {
    if (!this.state.serverCapabilities[serverId]) return;
    const next = clone(this.state);
    delete next.serverCapabilities[serverId];
    this.commit(next);
  }

  // Compatibility adapters for callers migrating from the v1 multi-user store.
  public upsertUser(session: PtvUserSession) {
    this.saveSession({
      schemaVersion: 1,
      serverUrl: session.serverUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      userName: session.userName,
      deviceId: session.deviceId,
      deviceName: PTV_DEVICE_NAME,
      applicationVersion: PTV_APPLICATION_VERSION,
      savedAt: session.updatedAt
    });
  }

  public clearAuth() {
    this.clearSession();
  }

  public removeAllUsersForServer(serverId: string) {
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (!server || this.state.session?.serverUrl !== server.baseUrl) return;
    this.clearSession();
  }

  public removeUser(serverId: string, userId: string) {
    const session = this.state.session;
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (session && server && session.serverUrl === server.baseUrl && session.userId === userId) {
      this.clearSession();
    }
  }

  public findUser(serverId: string, userId?: string): PtvUserSession | null {
    const session = this.state.session;
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (!session || !server || session.serverUrl !== server.baseUrl) return null;
    if (userId && session.userId !== userId) return null;
    return {
      userId: session.userId,
      userName: session.userName,
      accessToken: session.accessToken,
      serverId,
      serverUrl: session.serverUrl,
      deviceId: session.deviceId,
      createdAt: session.savedAt,
      updatedAt: session.savedAt
    };
  }

  public findLatestUser(serverId: string) {
    return this.findUser(serverId);
  }

  public getUsers() {
    const session = this.state.session;
    if (!session) return [];
    const server = this.state.servers.find(entry => entry.baseUrl === session.serverUrl);
    if (!server) return [];
    const user = this.findUser(server.serverId);
    return user ? [user] : [];
  }
}
