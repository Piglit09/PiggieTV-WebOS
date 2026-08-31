import type { PtvServerCapabilities, PtvServerSession, PtvUserSession } from '../types/ptv';
import { PTV_DEVICE_ID_STORAGE_KEY } from '../config/app';
import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import {
  CREDENTIAL_SCHEMA_VERSION,
  createProtectedCredentialStore,
  InvalidProtectedCredentialError,
  type CredentialBinding,
  type ProtectedCredentialStore
} from './credentialStore';
import {
  inspectStorage,
  mergeRecent,
  normalizeStoredServers,
  readPendingClear,
  removePendingClear,
  restoreRawStorage,
  writePendingClear,
  writeStorage,
  type PersistedSession,
  type PersistedSessionMetadata,
  type PersistentStorageState
} from './sessionStore';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function createDeviceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint32Array(4);
      crypto.getRandomValues(values);
      return `ptv-${Array.from(values).map(value => value.toString(16).padStart(8, '0')).join('')}`;
    }
  } catch {
    // A per-install fallback is still preferable to a shared device id.
  }
  return `ptv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createCredentialId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint8Array(16);
      crypto.getRandomValues(values);
      return `credential-${Array.from(values).map(value => value.toString(16).padStart(2, '0')).join('')}`;
    }
  } catch {
    // The id is non-secret. The production credential write still requires WebCrypto.
  }
  return `credential-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export interface StorageOperationGuard {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface SessionMetadataUpdate {
  userName?: string;
  deviceName?: string;
  applicationVersion?: string;
  savedAt?: number;
}

export class SecureStorageError extends Error {
  public readonly code = 'SECURE_STORAGE_FAILURE' as const;
  public readonly originalError: unknown;

  constructor(message = 'Protected credential storage failed', originalError?: unknown) {
    super(message);
    this.name = 'SecureStorageError';
    this.originalError = originalError;
  }
}

export class StorageOperationCancelledError extends Error {
  public readonly code = 'STORAGE_OPERATION_CANCELLED' as const;

  constructor() {
    super('The credential storage operation was superseded');
    this.name = 'StorageOperationCancelledError';
  }
}

export class InvalidLocalSessionError extends Error {
  public readonly code = 'INVALID_LOCAL_SESSION' as const;

  constructor() {
    super('Stored authentication state is structurally invalid');
    this.name = 'InvalidLocalSessionError';
  }
}

function asSecureStorageError(error: unknown, message?: string): SecureStorageError | StorageOperationCancelledError {
  if (error instanceof StorageOperationCancelledError) return error;
  if (error instanceof SecureStorageError) return error;
  return new SecureStorageError(message, error);
}

function assertCurrent(guard?: StorageOperationGuard): void {
  if (guard?.signal?.aborted || (guard?.isCurrent && !guard.isCurrent())) {
    throw new StorageOperationCancelledError();
  }
}

function normalizeSession(session: PersistedSession): PersistedSession {
  const serverUrl = normalizeServerUrl(session.serverUrl);
  if (
    session.schemaVersion !== 1 ||
    !isNonEmptyString(session.accessToken) ||
    !isNonEmptyString(session.serverId) ||
    !isNonEmptyString(session.userId) ||
    !isNonEmptyString(session.userName) ||
    !isNonEmptyString(session.deviceId) ||
    !isNonEmptyString(session.deviceName) ||
    !isNonEmptyString(session.applicationVersion) ||
    !Number.isFinite(session.savedAt)
  ) {
    throw new SecureStorageError('The session is not valid for protected persistence');
  }
  return { ...session, serverUrl };
}

function metadataForSession(session: PersistedSession, credentialId: string): PersistedSessionMetadata {
  return {
    schemaVersion: 2,
    credentialSchemaVersion: CREDENTIAL_SCHEMA_VERSION,
    credentialId,
    serverUrl: session.serverUrl,
    serverId: session.serverId,
    userId: session.userId,
    userName: session.userName,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    applicationVersion: session.applicationVersion,
    savedAt: session.savedAt
  };
}

function bindingForMetadata(metadata: PersistedSessionMetadata): CredentialBinding {
  return {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    credentialId: metadata.credentialId,
    serverUrl: metadata.serverUrl,
    serverId: metadata.serverId,
    userId: metadata.userId,
    deviceId: metadata.deviceId
  };
}

function sessionFromMetadata(metadata: PersistedSessionMetadata, accessToken: string): PersistedSession {
  return {
    schemaVersion: 1,
    serverUrl: metadata.serverUrl,
    serverId: metadata.serverId,
    accessToken,
    userId: metadata.userId,
    userName: metadata.userName,
    deviceId: metadata.deviceId,
    deviceName: metadata.deviceName,
    applicationVersion: metadata.applicationVersion,
    savedAt: metadata.savedAt
  };
}

function sameMetadata(left: PersistedSessionMetadata | null, right: PersistedSessionMetadata): boolean {
  return Boolean(
    left &&
    left.schemaVersion === right.schemaVersion &&
    left.credentialSchemaVersion === right.credentialSchemaVersion &&
    left.credentialId === right.credentialId &&
    left.serverUrl === right.serverUrl &&
    left.serverId === right.serverId &&
    left.userId === right.userId &&
    left.userName === right.userName &&
    left.deviceId === right.deviceId &&
    left.deviceName === right.deviceName &&
    left.applicationVersion === right.applicationVersion &&
    left.savedAt === right.savedAt
  );
}

export class StorageRepository {
  private state: PersistentStorageState;
  private deviceId: string | null = null;
  private activeSession: PersistedSession | null = null;
  private readonly protectedStore: ProtectedCredentialStore;

  constructor(protectedStore: ProtectedCredentialStore = createProtectedCredentialStore()) {
    this.protectedStore = protectedStore;
    this.state = inspectStorage().state;
    normalizeStoredServers(this.state);
  }

  public getState(): PersistentStorageState {
    return clone(this.state);
  }

  /** Only returns a session already restored into this repository instance. */
  public getSession(): PersistedSession | null {
    return this.activeSession ? clone(this.activeSession) : null;
  }

  public hasStoredSession(): boolean {
    if (readPendingClear().present) return false;
    const snapshot = inspectStorage();
    return Boolean(
      snapshot.state.session ||
      snapshot.legacySession ||
      snapshot.legacySessionStatus === 'recoverable-invalid' ||
      snapshot.legacySessionStatus === 'invalid'
    );
  }

  public getStoredSessionServerUrl(): string | null {
    if (readPendingClear().present) return null;
    const snapshot = inspectStorage();
    return snapshot.state.session?.serverUrl
      ?? snapshot.legacySession?.serverUrl
      ?? (
        snapshot.legacySessionStatus === 'recoverable-invalid' ||
        snapshot.legacySessionStatus === 'invalid'
          ? snapshot.state.lastServerUrl ?? null
          : null
      );
  }

  private commitMetadata(next: PersistentStorageState): void {
    const snapshot = inspectStorage();
    if (
      snapshot.legacySessionStatus !== 'none' ||
      snapshot.rawKind === 'malformed' ||
      snapshot.rawKind === 'future'
    ) {
      // Harmless metadata can remain in memory until migration. Never rewrite a
      // legacy token-bearing envelope before protected persistence is verified.
      this.state = clone(next);
      normalizeStoredServers(this.state);
      return;
    }
    writeStorage(next);
    this.state = clone(next);
    normalizeStoredServers(this.state);
  }

  public persist(): void {
    this.commitMetadata(this.state);
  }

  public async clearAll(): Promise<void> {
    await this.clearSession();
    const next = clone(this.state);
    next.servers = [];
    next.serverCapabilities = {};
    next.recentServers = [];
    next.lastServerUrl = undefined;
    this.commitMetadata(next);
  }

  public getOrCreateDeviceId(): string {
    if (this.deviceId) return this.deviceId;
    const snapshot = inspectStorage();
    const fromSession = this.activeSession?.deviceId
      ?? snapshot.state.session?.deviceId
      ?? snapshot.legacySession?.deviceId;
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
      // The protected session save path surfaces persistent-storage failures.
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

  public async restoreSession(guard?: StorageOperationGuard): Promise<PersistedSession | null> {
    assertCurrent(guard);
    if (readPendingClear().present) {
      this.activeSession = null;
      await this.completePendingSessionClear();
      assertCurrent(guard);
      return null;
    }

    const snapshot = inspectStorage();
    this.state = clone(snapshot.state);
    if (snapshot.state.session) {
      try {
        const accessToken = await this.protectedStore.readCredential(
          bindingForMetadata(snapshot.state.session)
        );
        assertCurrent(guard);
        if (!isNonEmptyString(accessToken)) {
          throw new InvalidProtectedCredentialError();
        }
        const restored = sessionFromMetadata(snapshot.state.session, accessToken);
        this.activeSession = clone(restored);
        this.deviceId = restored.deviceId;
        return restored;
      } catch (error) {
        this.activeSession = null;
        if (error instanceof InvalidProtectedCredentialError) {
          throw new InvalidLocalSessionError();
        }
        throw asSecureStorageError(error, 'The protected session could not be restored');
      }
    }

    if (!snapshot.legacySession) {
      this.activeSession = null;
      if (snapshot.legacySessionStatus === 'recoverable-invalid') {
        throw new SecureStorageError(
          'A potentially recoverable legacy credential cannot yet be migrated; legacy evidence was preserved'
        );
      }
      if (snapshot.legacySessionStatus === 'invalid') {
        throw new InvalidLocalSessionError();
      }
      return null;
    }

    try {
      await this.saveSession(snapshot.legacySession, guard);
      assertCurrent(guard);
      return this.activeSession ? clone(this.activeSession) : null;
    } catch (error) {
      this.activeSession = null;
      throw asSecureStorageError(error, 'Legacy session migration to protected storage failed');
    }
  }

  public async saveSession(session: PersistedSession, guard?: StorageOperationGuard): Promise<void>;
  public async saveSession<T>(
    session: PersistedSession,
    guard: StorageOperationGuard | undefined,
    activate: () => T
  ): Promise<T>;
  public async saveSession<T>(
    session: PersistedSession,
    guard?: StorageOperationGuard,
    activate?: () => T
  ): Promise<T | void> {
    assertCurrent(guard);
    if (readPendingClear().present) throw new StorageOperationCancelledError();

    const normalized = normalizeSession(session);
    const credentialId = createCredentialId();
    const metadata = metadataForSession(normalized, credentialId);
    const binding = bindingForMetadata(metadata);
    const snapshot = inspectStorage();
    const previousRaw = snapshot.raw;
    const previousState = clone(this.state);
    const previousSession = this.activeSession ? clone(this.activeSession) : null;
    const priorCredentialId = snapshot.state.session?.credentialId ?? null;
    let staged = false;
    let activationAttempted = false;
    let activationFailure: unknown;

    try {
      await this.protectedStore.writeCredential(binding, normalized.accessToken, () => {
        assertCurrent(guard);
        if (readPendingClear().present) throw new StorageOperationCancelledError();
      });
      staged = true;
      assertCurrent(guard);

      // Read through the adapter again before any local plaintext is removed.
      const verifiedToken = await this.protectedStore.readCredential(binding);
      if (verifiedToken !== normalized.accessToken) {
        throw new Error('Protected credential readback did not match');
      }
      assertCurrent(guard);
      if (readPendingClear().present) throw new StorageOperationCancelledError();

      const next = clone(snapshot.rawKind === 'current' ? snapshot.state : this.state);
      next.session = metadata;
      next.lastServerUrl = metadata.serverUrl;
      mergeRecent(next, metadata.serverUrl);
      activationAttempted = true;
      writeStorage(next);

      const confirmed = inspectStorage();
      if (
        confirmed.rawKind !== 'current' ||
        confirmed.legacySession ||
        !sameMetadata(confirmed.state.session, metadata)
      ) {
        throw new Error('Protected session metadata activation could not be verified');
      }

      this.state = clone(confirmed.state);
      this.activeSession = clone(normalized);
      this.deviceId = normalized.deviceId;
      assertCurrent(guard);

      let activationResult: T | undefined;
      if (activate) {
        try {
          activationResult = activate();
        } catch (error) {
          activationFailure = error;
          throw error;
        }
      }

      if (priorCredentialId && priorCredentialId !== credentialId) {
        void this.protectedStore.deleteCredential(priorCredentialId).catch(() => {
          // A superseded encrypted record is not an authentication or plaintext risk.
        });
      }
      return activationResult;
    } catch (error) {
      let rollbackVerified = !activationAttempted;
      if (activationAttempted) {
        try {
          restoreRawStorage(previousRaw);
          rollbackVerified = true;
        } catch {
          // If activation outcome is ambiguous, the verified candidate remains
          // recoverable rather than deleting the only usable credential.
        }
      }
      if (staged && rollbackVerified) {
        try {
          await this.protectedStore.deleteCredential(credentialId);
        } catch {
          // An unreferenced encrypted candidate is preferable to deleting prior auth.
        }
      }
      this.state = previousState;
      this.activeSession = previousSession;
      if (activationFailure !== undefined) throw activationFailure;
      throw asSecureStorageError(error, 'The session could not be persisted in protected storage');
    }
  }

  /**
   * Writes the durable, non-secret logout barrier synchronously. Callers can
   * invalidate their auth epoch, arm this barrier, then clear in-memory UI state.
   */
  public armSessionClearBarrier(): void {
    try {
      const pending = readPendingClear();
      const snapshot = inspectStorage();
      const credentialIds = pending.valid ? [...pending.marker.credentialIds] : [];
      if (snapshot.state.session?.credentialId) credentialIds.push(snapshot.state.session.credentialId);
      writePendingClear(credentialIds);
    } catch (error) {
      throw asSecureStorageError(error, 'The durable session-clear barrier could not be written');
    }
  }

  public async clearSession(): Promise<void> {
    const pending = readPendingClear();
    if (!pending.present || !pending.valid) this.armSessionClearBarrier();
    this.activeSession = null;
    await this.completePendingSessionClear();
  }

  public async completePendingSessionClear(): Promise<void> {
    const pending = readPendingClear();
    if (!pending.present) {
      this.activeSession = null;
      return;
    }
    try {
      const snapshot = inspectStorage();

      const sanitized = clone(snapshot.state);
      sanitized.session = null;
      writeStorage(sanitized);
      const confirmedLocal = inspectStorage();
      if (confirmedLocal.state.session || confirmedLocal.legacySession) {
        throw new Error('Local authentication state could not be cleared');
      }

      await this.protectedStore.clearAllCredentialsAndKey();
      if (await this.protectedStore.hasAnyCredential()) {
        throw new Error('Protected credential deletion could not be verified');
      }
      if (await this.protectedStore.hasKey()) {
        throw new Error('Protected credential key deletion could not be verified');
      }

      removePendingClear();
      this.state = clone(confirmedLocal.state);
      this.activeSession = null;
    } catch (error) {
      this.activeSession = null;
      throw asSecureStorageError(error, 'Pending protected session clear did not complete');
    }
  }

  public updateSessionMetadata(update: SessionMetadataUpdate): void {
    const snapshot = inspectStorage();
    const current = snapshot.state.session;
    if (!current || readPendingClear().present) return;
    const nextSession: PersistedSessionMetadata = {
      ...current,
      userName: isNonEmptyString(update.userName) ? update.userName : current.userName,
      deviceName: isNonEmptyString(update.deviceName) ? update.deviceName : current.deviceName,
      applicationVersion: isNonEmptyString(update.applicationVersion)
        ? update.applicationVersion
        : current.applicationVersion,
      savedAt: Number.isFinite(update.savedAt) ? update.savedAt as number : current.savedAt
    };
    const next = clone(snapshot.state);
    next.session = nextSession;
    try {
      writeStorage(next);
      const confirmed = inspectStorage();
      if (!sameMetadata(confirmed.state.session, nextSession)) {
        throw new Error('Session metadata update could not be verified');
      }
      this.state = clone(confirmed.state);
      if (this.activeSession) {
        this.activeSession = sessionFromMetadata(nextSession, this.activeSession.accessToken);
      }
    } catch (error) {
      throw asSecureStorageError(error, 'Session metadata could not be updated');
    }
  }

  public getRecentServers(): string[] {
    return [...this.state.recentServers];
  }

  public setLastServer(serverUrl: string): void {
    const next = clone(this.state);
    const normalized = normalizeServerUrl(serverUrl);
    next.lastServerUrl = normalized;
    mergeRecent(next, normalized);
    this.commitMetadata(next);
  }

  public getLastServer(): string | null {
    return this.state.lastServerUrl ?? null;
  }

  public findServerByUrl(serverUrl: string): PtvServerSession | null {
    const normalized = normalizeServerUrl(serverUrl);
    const server = this.state.servers.find(entry => entry.baseUrl === normalized);
    return server ? clone(server) : null;
  }

  public async removeServerByUrl(serverUrl: string): Promise<void> {
    const normalized = normalizeServerUrl(serverUrl);
    const storedSessionUrl = this.getStoredSessionServerUrl();
    if (storedSessionUrl === normalized) await this.clearSession();
    const next = clone(this.state);
    next.servers = next.servers.filter(item => item.baseUrl !== normalized);
    next.recentServers = next.recentServers.filter(item => item !== normalized);
    if (next.lastServerUrl === normalized) next.lastServerUrl = next.recentServers[0];
    this.commitMetadata(next);
  }

  public upsertServer(session: PtvServerSession): void {
    const next = clone(this.state);
    const existingIndex = next.servers.findIndex(item => (
      item.serverId === session.serverId || item.baseUrl === session.baseUrl
    ));
    if (existingIndex >= 0) next.servers[existingIndex] = clone(session);
    else next.servers.push(clone(session));
    mergeRecent(next, session.baseUrl);
    next.lastServerUrl = session.baseUrl;
    this.commitMetadata(next);
  }

  public upsertServerCapabilities(serverId: string, capabilities: PtvServerCapabilities): void {
    const next = clone(this.state);
    next.serverCapabilities[serverId] = clone(capabilities);
    this.commitMetadata(next);
  }

  public getServerCapabilities(serverId: string): PtvServerCapabilities | null {
    const value = this.state.serverCapabilities[serverId];
    return value ? clone(value) : null;
  }

  public removeServerCapabilities(serverId: string): void {
    if (!this.state.serverCapabilities[serverId]) return;
    const next = clone(this.state);
    delete next.serverCapabilities[serverId];
    this.commitMetadata(next);
  }

  public async clearAuth(): Promise<void> {
    await this.clearSession();
  }

  public async removeAllUsersForServer(serverId: string): Promise<void> {
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (!server || this.getStoredSessionServerUrl() !== server.baseUrl) return;
    await this.clearSession();
  }

  public async removeUser(serverId: string, userId: string): Promise<void> {
    const session = this.activeSession;
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (session && server && session.serverUrl === server.baseUrl && session.userId === userId) {
      await this.clearSession();
    }
  }

  public findUser(serverId: string, userId?: string): PtvUserSession | null {
    const session = this.activeSession;
    const server = this.state.servers.find(entry => entry.serverId === serverId);
    if (!session || !server || session.serverUrl !== server.baseUrl) return null;
    if (userId && session.userId !== userId) return null;
    return {
      userId: session.userId,
      userName: session.userName,
      serverId,
      serverUrl: session.serverUrl,
      deviceId: session.deviceId,
      createdAt: session.savedAt,
      updatedAt: session.savedAt
    };
  }

  public findLatestUser(serverId: string): PtvUserSession | null {
    return this.findUser(serverId);
  }

  public getUsers(): PtvUserSession[] {
    const session = this.activeSession;
    if (!session) return [];
    const server = this.state.servers.find(entry => entry.baseUrl === session.serverUrl);
    if (!server) return [];
    const user = this.findUser(server.serverId);
    return user ? [user] : [];
  }
}
