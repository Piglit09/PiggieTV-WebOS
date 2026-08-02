import { normalizeServerUrl } from '../api/jellyfin/normalizeUrl';
import type { PtvQuickConnectStateResponse } from '../api/jellyfin/client';

export const AUTH_REQUEST_TIMEOUT_MS = 15_000;
export const QUICK_CONNECT_TIMEOUT_MS = 120_000;
export const SESSION_SCHEMA_VERSION = 1;

type Awaitable<T> = T | Promise<T>;

export type SessionWorkflow = 'password' | 'quick-connect';

export type SessionControllerStage =
  | 'IDLE'
  | 'VALIDATING_INPUT'
  | 'REQUEST_STARTED'
  | 'RESPONSE_RECEIVED'
  | 'AUTH_JSON_PARSED'
  | 'AUTH_RESULT_VALIDATED'
  | 'SESSION_PERSIST_STARTED'
  | 'SESSION_PERSISTED'
  | 'API_CONTEXT_UPDATED'
  | 'AUTH_STATE_COMMITTED'
  | 'NAVIGATION_REQUESTED'
  | 'COMPLETE'
  | 'FAILED'
  | 'CANCELLED';

export type SessionControllerStatus = 'idle' | 'pending' | 'success' | 'error';

export type SessionResultClassification =
  | 'pending'
  | 'success'
  | 'invalid-input'
  | 'invalid-credentials'
  | 'invalid-response'
  | 'network-error'
  | 'server-error'
  | 'timeout'
  | 'storage-failure'
  | 'api-context-failure'
  | 'state-commit-failure'
  | 'navigation-failure'
  | 'quick-connect-pending'
  | 'cancelled'
  | 'stale'
  | 'unknown';

export interface SessionDeviceIdentity {
  deviceId: string;
  deviceName: string;
  applicationVersion: string;
}

export interface PersistedAuthenticatedSession extends SessionDeviceIdentity {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  serverUrl: string;
  serverId: string;
  accessToken: string;
  userId: string;
  userName: string;
  savedAt: number;
}

export interface AuthenticationResponse {
  AccessToken?: unknown;
  ServerId?: unknown;
  User?: {
    Id?: unknown;
    Name?: unknown;
  } | null;
}

export interface SessionResponseMetadata {
  status?: number;
  contentType?: string;
}

export interface SessionRequestHooks {
  onResponseReceived?: (metadata: SessionResponseMetadata) => void;
  onJsonParsed?: (metadata: SessionResponseMetadata) => void;
}

export interface PasswordAuthenticationRequest extends SessionRequestHooks {
  attemptId: string;
  serverUrl: string;
  username: string;
  password: string;
  device: SessionDeviceIdentity;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface QuickConnectInitiateRequest {
  attemptId: string;
  serverUrl: string;
  device: SessionDeviceIdentity;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface QuickConnectAuthenticationRequest extends SessionRequestHooks {
  attemptId: string;
  serverUrl: string;
  secret: string;
  device: SessionDeviceIdentity;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface QuickConnectStateRequest extends SessionRequestHooks {
  attemptId: string;
  serverUrl: string;
  secret: string;
  device: SessionDeviceIdentity;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface QuickConnectInitiateResponse {
  Secret?: unknown;
  Code?: unknown;
}

export interface SessionOperationContext {
  attemptId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface SessionApi {
  authenticateByName(request: PasswordAuthenticationRequest): Promise<AuthenticationResponse>;
  initiateQuickConnect?(request: QuickConnectInitiateRequest): Promise<QuickConnectInitiateResponse>;
  getQuickConnectState?(request: QuickConnectStateRequest): Promise<PtvQuickConnectStateResponse>;
  authenticateWithQuickConnect?(
    request: QuickConnectAuthenticationRequest
  ): Promise<AuthenticationResponse>;
  setAuthenticationContext(
    session: PersistedAuthenticatedSession,
    context: SessionOperationContext
  ): Awaitable<void>;
}

export interface SessionPersistence {
  persistSessionAtomically(
    session: PersistedAuthenticatedSession,
    context: SessionOperationContext
  ): Awaitable<void>;
}

export interface SessionStateCommitter {
  commitAuthenticatedSession(
    session: PersistedAuthenticatedSession,
    context: SessionOperationContext
  ): Awaitable<void>;
}

export interface SessionNavigation {
  navigateHome(context: SessionOperationContext): Awaitable<void>;
}

export interface SessionDiagnosticSnapshot {
  attemptId: string;
  workflow: SessionWorkflow;
  stage: SessionControllerStage;
  status: SessionControllerStatus;
  resultClassification: SessionResultClassification;
  serverOrigin: string;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  httpStatus?: number;
  contentType?: string;
  userIdSuffix?: string;
  persistenceSucceeded: boolean;
  apiContextUpdated: boolean;
  authStateCommitted: boolean;
  navigationRequested: boolean;
  stale: boolean;
  cancelled: boolean;
  errorMessage?: string;
}

export interface SessionDiagnosticsSink {
  record(snapshot: SessionDiagnosticSnapshot): void;
}

export interface SessionControllerState {
  status: SessionControllerStatus;
  stage: SessionControllerStage;
  activeAttemptId: string | null;
  lastAttemptId: string | null;
  workflow: SessionWorkflow | null;
  errorMessage: string | null;
  quickConnectCode: string | null;
  userName: string | null;
}

export interface SessionControllerResult {
  attemptId: string;
  status: Exclude<SessionControllerStatus, 'pending'>;
  classification: SessionResultClassification;
  errorMessage?: string;
  userName?: string;
  userIdSuffix?: string;
}

export interface PasswordAuthenticationInput {
  serverUrl: string;
  serverId?: string | null;
  username: string;
  password: string;
}

export interface QuickConnectInput {
  serverUrl: string;
  serverId?: string | null;
}

export interface SessionControllerDependencies {
  api: SessionApi;
  persistence: SessionPersistence;
  state: SessionStateCommitter;
  navigation: SessionNavigation;
  getDeviceIdentity: () => Awaitable<SessionDeviceIdentity>;
  diagnostics?: SessionDiagnosticsSink;
  now?: () => number;
  sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  authTimeoutMs?: number;
  quickConnectTimeoutMs?: number;
  quickConnectPollIntervalMs?: number;
}

type DuplicateKey =
  | {
    workflow: 'password';
    serverUrl: string;
    serverId: string;
    username: string;
    password: string;
  }
  | {
    workflow: 'quick-connect';
    serverUrl: string;
    serverId: string;
  };

interface InternalAttempt {
  id: string;
  workflow: SessionWorkflow;
  startedAt: number;
  serverOrigin: string;
  controller: AbortController;
  duplicateKey: DuplicateKey | null;
  promise?: Promise<SessionControllerResult>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  cancelReason?: 'cancelled' | 'superseded' | 'timeout';
  terminalResult?: SessionControllerResult;
  httpStatus?: number;
  contentType?: string;
  userIdSuffix?: string;
  persistenceSucceeded: boolean;
  apiContextUpdated: boolean;
  authStateCommitted: boolean;
  navigationRequested: boolean;
  sensitiveValues: Set<string>;
}

class ControllerFailure extends Error {
  public constructor(
    public readonly classification: SessionResultClassification,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ControllerFailure';
  }
}

class AttemptAbortedError extends Error {
  public constructor() {
    super('Authentication attempt was cancelled');
    this.name = 'AttemptAbortedError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function serverOrigin(normalizedUrl: string) {
  try {
    return new URL(normalizedUrl).origin;
  } catch {
    return '[invalid-server]';
  }
}

function userIdSuffix(userId: string) {
  return `...${userId.slice(-6)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeMessage(input: unknown, sensitiveValues: Iterable<string>) {
  const initial = input instanceof Error
    ? input.message
    : typeof input === 'string'
      ? input
      : input && typeof input === 'object' && 'message' in input && typeof input.message === 'string'
        ? input.message
        : 'Authentication failed';

  let safe = initial
    .replace(/([?&](?:token|access[_-]?token|api[_-]?key|secret|password)=)[^&\s]+/gi, '$1***redacted***')
    .replace(/(["']?(?:token|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi, '$1***redacted***');

  for (const value of sensitiveValues) {
    if (!value) continue;
    safe = safe.replace(new RegExp(escapeRegExp(value), 'g'), '***redacted***');
  }

  return safe || 'Authentication failed';
}

function extractStatus(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
}

function extractKind(error: unknown) {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { kind?: unknown; name?: unknown };
  if (typeof candidate.kind === 'string') return candidate.kind.toLowerCase();
  if (typeof candidate.name === 'string') return candidate.name.toLowerCase();
  return '';
}

function defaultSleep(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AttemptAbortedError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new AttemptAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AttemptAbortedError());
      return;
    }

    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new AttemptAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export class SessionController {
  private readonly listeners = new Set<(state: SessionControllerState) => void>();
  private readonly now: () => number;
  private readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
  private readonly authTimeoutMs: number;
  private readonly quickConnectTimeoutMs: number;
  private readonly quickConnectPollIntervalMs: number;
  private activeAttempt: InternalAttempt | null = null;
  private sequence = 0;
  private latestDiagnostic: SessionDiagnosticSnapshot | null = null;
  private controllerState: SessionControllerState = {
    status: 'idle',
    stage: 'IDLE',
    activeAttemptId: null,
    lastAttemptId: null,
    workflow: null,
    errorMessage: null,
    quickConnectCode: null,
    userName: null
  };

  public constructor(private readonly dependencies: SessionControllerDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.authTimeoutMs = dependencies.authTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS;
    this.quickConnectTimeoutMs = dependencies.quickConnectTimeoutMs ?? QUICK_CONNECT_TIMEOUT_MS;
    this.quickConnectPollIntervalMs = dependencies.quickConnectPollIntervalMs ?? 3_000;
  }

  public getState(): SessionControllerState {
    return { ...this.controllerState };
  }

  public getDiagnosticSnapshot(): SessionDiagnosticSnapshot | null {
    return this.latestDiagnostic ? { ...this.latestDiagnostic } : null;
  }

  public subscribe(listener: (state: SessionControllerState) => void) {
    this.listeners.add(listener);
    try {
      listener(this.getState());
    } catch {
      // A subscriber cannot interrupt controller ownership.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public authenticateByName(input: PasswordAuthenticationInput): Promise<SessionControllerResult> {
    const normalizedUsername = input.username.trim();
    const duplicateKey: DuplicateKey = {
      workflow: 'password',
      serverUrl: this.normalizeForDuplicateCheck(input.serverUrl),
      serverId: input.serverId?.trim() ?? '',
      username: normalizedUsername,
      password: input.password
    };

    if (this.isDuplicate(duplicateKey)) {
      return this.activeAttempt?.promise as Promise<SessionControllerResult>;
    }

    this.supersedeActiveAttempt();
    const attempt = this.createAttempt('password', duplicateKey, this.authTimeoutMs, [input.password]);
    const promise = this.runPasswordAttempt(attempt, input, normalizedUsername);
    attempt.promise = promise;
    return promise;
  }

  public startQuickConnect(input: QuickConnectInput): Promise<SessionControllerResult> {
    const duplicateKey: DuplicateKey = {
      workflow: 'quick-connect',
      serverUrl: this.normalizeForDuplicateCheck(input.serverUrl),
      serverId: input.serverId?.trim() ?? ''
    };

    if (this.isDuplicate(duplicateKey)) {
      return this.activeAttempt?.promise as Promise<SessionControllerResult>;
    }

    this.supersedeActiveAttempt();
    const attempt = this.createAttempt('quick-connect', duplicateKey, this.quickConnectTimeoutMs);
    const promise = this.runQuickConnectAttempt(attempt, input);
    attempt.promise = promise;
    return promise;
  }

  public cancelCurrentAttempt() {
    if (!this.activeAttempt) return;
    this.cancelAttempt(this.activeAttempt, 'cancelled');
  }

  private async runPasswordAttempt(
    attempt: InternalAttempt,
    input: PasswordAuthenticationInput,
    normalizedUsername: string
  ): Promise<SessionControllerResult> {
    try {
      this.emit(attempt, 'VALIDATING_INPUT', 'pending');
      const normalizedServerUrl = this.validateServerUrl(input.serverUrl);
      if (!normalizedUsername) {
        throw new ControllerFailure('invalid-input', 'Username is required');
      }
      if (input.password.length === 0) {
        throw new ControllerFailure('invalid-input', 'Password is required');
      }
      const device = await this.resolveDeviceIdentity(attempt);
      this.assertCurrent(attempt);

      this.emit(attempt, 'REQUEST_STARTED', 'pending');
      const observation = this.createResponseObservation(attempt);
      const request = this.dependencies.api.authenticateByName({
        attemptId: attempt.id,
        serverUrl: normalizedServerUrl,
        username: normalizedUsername,
        password: input.password,
        device,
        timeoutMs: this.authTimeoutMs,
        signal: attempt.controller.signal,
        onResponseReceived: observation.onResponseReceived,
        onJsonParsed: observation.onJsonParsed
      });
      const response = await raceWithAbort(request, attempt.controller.signal);
      this.assertCurrent(attempt);
      observation.ensureResponseReceived();
      observation.ensureJsonParsed();

      return await this.validateAndCommit(attempt, response, {
        normalizedServerUrl,
        validatedServerId: input.serverId,
        device
      });
    } catch (error) {
      return this.finishFromError(attempt, error);
    } finally {
      this.cleanupAttempt(attempt);
    }
  }

  private async runQuickConnectAttempt(
    attempt: InternalAttempt,
    input: QuickConnectInput
  ): Promise<SessionControllerResult> {
    try {
      this.emit(attempt, 'VALIDATING_INPUT', 'pending');
      const normalizedServerUrl = this.validateServerUrl(input.serverUrl);
      const initiate = this.dependencies.api.initiateQuickConnect;
      const getState = this.dependencies.api.getQuickConnectState;
      const authenticate = this.dependencies.api.authenticateWithQuickConnect;
      if (!initiate || !getState || !authenticate) {
        throw new ControllerFailure('invalid-input', 'Quick Connect is not available');
      }
      const device = await this.resolveDeviceIdentity(attempt);
      this.assertCurrent(attempt);

      this.emit(attempt, 'REQUEST_STARTED', 'pending');
      const initiation = await raceWithAbort(
        initiate({
          attemptId: attempt.id,
          serverUrl: normalizedServerUrl,
          device,
          timeoutMs: this.authTimeoutMs,
          signal: attempt.controller.signal
        }),
        attempt.controller.signal
      );
      this.assertCurrent(attempt);
      this.emit(attempt, 'RESPONSE_RECEIVED', 'quick-connect-pending');

      if (!isNonEmptyString(initiation.Secret) || !isNonEmptyString(initiation.Code)) {
        throw new ControllerFailure('invalid-response', 'Quick Connect returned an invalid response');
      }
      const secret = initiation.Secret;
      attempt.sensitiveValues.add(secret);
      this.updateQuickConnectCode(attempt, initiation.Code);

      while (this.isCurrent(attempt)) {
        await raceWithAbort(
          this.sleep(this.quickConnectPollIntervalMs, attempt.controller.signal),
          attempt.controller.signal
        );
        this.assertCurrent(attempt);
        this.emit(attempt, 'REQUEST_STARTED', 'quick-connect-pending');
        const observation = this.createResponseObservation(attempt, 'quick-connect-pending', false);
        const state = await raceWithAbort(
          getState({
            attemptId: attempt.id,
            serverUrl: normalizedServerUrl,
            secret,
            device,
            timeoutMs: this.authTimeoutMs,
            signal: attempt.controller.signal,
            onResponseReceived: observation.onResponseReceived,
            onJsonParsed: observation.onJsonParsed
          }),
          attempt.controller.signal
        );
        this.assertCurrent(attempt);
        observation.ensureResponseReceived();
        observation.ensureJsonParsed();
        if (!state || typeof state.Authenticated !== 'boolean') {
          throw new ControllerFailure('invalid-response', 'Quick Connect returned an invalid state response');
        }
        if (isNonEmptyString(state.Secret) && state.Secret !== secret) {
          throw new ControllerFailure('invalid-response', 'Quick Connect state belongs to another request');
        }
        if (!state.Authenticated) {
          continue;
        }
        break;
      }

      this.assertCurrent(attempt);
      this.emit(attempt, 'REQUEST_STARTED', 'pending');
      const observation = this.createResponseObservation(attempt);
      const response = await raceWithAbort(
        authenticate({
          attemptId: attempt.id,
          serverUrl: normalizedServerUrl,
          secret,
          device,
          timeoutMs: this.authTimeoutMs,
          signal: attempt.controller.signal,
          onResponseReceived: observation.onResponseReceived,
          onJsonParsed: observation.onJsonParsed
        }),
        attempt.controller.signal
      );
      this.assertCurrent(attempt);
      observation.ensureResponseReceived();
      observation.ensureJsonParsed();
      return await this.validateAndCommit(attempt, response, {
        normalizedServerUrl,
        validatedServerId: input.serverId,
        device
      });
    } catch (error) {
      return this.finishFromError(attempt, error);
    } finally {
      this.cleanupAttempt(attempt);
    }
  }

  private async validateAndCommit(
    attempt: InternalAttempt,
    response: AuthenticationResponse,
    context: {
      normalizedServerUrl: string;
      validatedServerId?: string | null;
      device: SessionDeviceIdentity;
    }
  ): Promise<SessionControllerResult> {
    this.assertCurrent(attempt);
    const responseServerId = isNonEmptyString(response.ServerId) ? response.ServerId.trim() : '';
    const validatedServerId = context.validatedServerId?.trim() ?? '';
    if (responseServerId && validatedServerId && responseServerId !== validatedServerId) {
      throw new ControllerFailure('invalid-response', 'Authentication response belongs to another server');
    }

    if (
      !isNonEmptyString(response.AccessToken) ||
      !isNonEmptyString(response.User?.Id) ||
      !isNonEmptyString(response.User?.Name)
    ) {
      throw new ControllerFailure('invalid-response', 'Authentication response is missing required session data');
    }
    const serverId = responseServerId || validatedServerId;
    if (!serverId) {
      throw new ControllerFailure('invalid-response', 'Authentication response is missing a server ID');
    }

    const accessToken = response.AccessToken;
    const userId = response.User.Id;
    const userName = response.User.Name;
    attempt.sensitiveValues.add(accessToken);
    attempt.userIdSuffix = userIdSuffix(userId);
    this.emit(attempt, 'AUTH_RESULT_VALIDATED', 'pending');

    const session: PersistedAuthenticatedSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      serverUrl: context.normalizedServerUrl,
      serverId,
      accessToken,
      userId,
      userName,
      deviceId: context.device.deviceId,
      deviceName: context.device.deviceName,
      applicationVersion: context.device.applicationVersion,
      savedAt: this.now()
    };
    const operationContext = this.operationContext(attempt);

    this.emit(attempt, 'SESSION_PERSIST_STARTED', 'pending');
    try {
      await raceWithAbort(
        Promise.resolve(this.dependencies.persistence.persistSessionAtomically(session, operationContext)),
        attempt.controller.signal
      );
    } catch (error) {
      throw new ControllerFailure(
        'storage-failure',
        sanitizeMessage(error, attempt.sensitiveValues),
        extractStatus(error)
      );
    }
    this.assertCurrent(attempt);
    attempt.persistenceSucceeded = true;
    this.emit(attempt, 'SESSION_PERSISTED', 'pending');

    try {
      await raceWithAbort(
        Promise.resolve(this.dependencies.api.setAuthenticationContext(session, operationContext)),
        attempt.controller.signal
      );
    } catch (error) {
      throw new ControllerFailure(
        'api-context-failure',
        sanitizeMessage(error, attempt.sensitiveValues),
        extractStatus(error)
      );
    }
    this.assertCurrent(attempt);
    attempt.apiContextUpdated = true;
    this.emit(attempt, 'API_CONTEXT_UPDATED', 'pending');

    try {
      await raceWithAbort(
        Promise.resolve(this.dependencies.state.commitAuthenticatedSession(session, operationContext)),
        attempt.controller.signal
      );
    } catch (error) {
      throw new ControllerFailure(
        'state-commit-failure',
        sanitizeMessage(error, attempt.sensitiveValues),
        extractStatus(error)
      );
    }
    this.assertCurrent(attempt);
    attempt.authStateCommitted = true;
    this.emit(attempt, 'AUTH_STATE_COMMITTED', 'pending');

    attempt.navigationRequested = true;
    this.emit(attempt, 'NAVIGATION_REQUESTED', 'pending');
    try {
      await raceWithAbort(
        Promise.resolve(this.dependencies.navigation.navigateHome(operationContext)),
        attempt.controller.signal
      );
    } catch (error) {
      throw new ControllerFailure(
        'navigation-failure',
        sanitizeMessage(error, attempt.sensitiveValues),
        extractStatus(error)
      );
    }
    this.assertCurrent(attempt);

    const result: SessionControllerResult = {
      attemptId: attempt.id,
      status: 'success',
      classification: 'success',
      userName,
      userIdSuffix: attempt.userIdSuffix
    };
    attempt.terminalResult = result;
    this.emit(attempt, 'COMPLETE', 'success', { userName });
    return result;
  }

  private createAttempt(
    workflow: SessionWorkflow,
    duplicateKey: DuplicateKey,
    timeoutMs: number,
    sensitiveValues: string[] = []
  ) {
    const id = workflow === 'password' ? `auth-${++this.sequence}` : `quick-connect-${++this.sequence}`;
    const normalizedServer = duplicateKey.serverUrl;
    const attempt: InternalAttempt = {
      id,
      workflow,
      startedAt: this.now(),
      serverOrigin: serverOrigin(normalizedServer),
      controller: new AbortController(),
      duplicateKey,
      persistenceSucceeded: false,
      apiContextUpdated: false,
      authStateCommitted: false,
      navigationRequested: false,
      sensitiveValues: new Set(sensitiveValues.filter(Boolean))
    };
    this.activeAttempt = attempt;
    this.controllerState = {
      status: 'pending',
      stage: 'VALIDATING_INPUT',
      activeAttemptId: attempt.id,
      lastAttemptId: attempt.id,
      workflow,
      errorMessage: null,
      quickConnectCode: null,
      userName: null
    };
    this.notifySubscribers();
    attempt.timeoutHandle = setTimeout(() => {
      if (!this.isCurrent(attempt) || attempt.terminalResult) return;
      attempt.cancelReason = 'timeout';
      attempt.controller.abort();
    }, timeoutMs);
    return attempt;
  }

  private createResponseObservation(
    attempt: InternalAttempt,
    classification: SessionResultClassification = 'pending',
    emitAuthJsonParsed = true
  ) {
    let responseReceived = false;
    let jsonParsed = false;
    const recordMetadata = (metadata: SessionResponseMetadata) => {
      if (typeof metadata.status === 'number') attempt.httpStatus = metadata.status;
      if (typeof metadata.contentType === 'string') attempt.contentType = metadata.contentType;
    };

    return {
      onResponseReceived: (metadata: SessionResponseMetadata) => {
        responseReceived = true;
        recordMetadata(metadata);
        if (this.isCurrent(attempt)) {
          this.emit(attempt, 'RESPONSE_RECEIVED', classification);
        }
      },
      onJsonParsed: (metadata: SessionResponseMetadata) => {
        jsonParsed = true;
        recordMetadata(metadata);
        if (this.isCurrent(attempt)) {
          if (!responseReceived) {
            responseReceived = true;
            this.emit(attempt, 'RESPONSE_RECEIVED', classification);
          }
          if (emitAuthJsonParsed) {
            this.emit(attempt, 'AUTH_JSON_PARSED', classification);
          }
        }
      },
      ensureResponseReceived: () => {
        if (responseReceived) return;
        responseReceived = true;
        this.emit(attempt, 'RESPONSE_RECEIVED', classification);
      },
      ensureJsonParsed: () => {
        if (jsonParsed) return;
        jsonParsed = true;
        if (emitAuthJsonParsed) {
          this.emit(attempt, 'AUTH_JSON_PARSED', classification);
        }
      }
    };
  }

  private emit(
    attempt: InternalAttempt,
    stage: SessionControllerStage,
    classification: SessionResultClassification,
    options: { httpStatus?: number; userName?: string; errorMessage?: string } = {}
  ) {
    if (typeof options.httpStatus === 'number') attempt.httpStatus = options.httpStatus;
    const terminal = stage === 'COMPLETE' || stage === 'FAILED' || stage === 'CANCELLED';
    const status: SessionControllerStatus = stage === 'COMPLETE'
      ? 'success'
      : stage === 'FAILED'
        ? 'error'
        : stage === 'CANCELLED'
          ? 'idle'
          : 'pending';
    const now = this.now();
    const snapshot: SessionDiagnosticSnapshot = {
      attemptId: attempt.id,
      workflow: attempt.workflow,
      stage,
      status,
      resultClassification: classification,
      serverOrigin: attempt.serverOrigin,
      startedAt: attempt.startedAt,
      endedAt: terminal ? now : undefined,
      durationMs: Math.max(0, now - attempt.startedAt),
      httpStatus: attempt.httpStatus,
      contentType: attempt.contentType,
      userIdSuffix: attempt.userIdSuffix,
      persistenceSucceeded: attempt.persistenceSucceeded,
      apiContextUpdated: attempt.apiContextUpdated,
      authStateCommitted: attempt.authStateCommitted,
      navigationRequested: attempt.navigationRequested,
      stale: attempt.cancelReason === 'superseded',
      cancelled: stage === 'CANCELLED',
      errorMessage: options.errorMessage
    };

    try {
      this.dependencies.diagnostics?.record({ ...snapshot });
    } catch {
      // Diagnostics must never interrupt session ownership.
    }

    if (this.activeAttempt !== attempt) return;
    this.latestDiagnostic = snapshot;
    this.controllerState = {
      ...this.controllerState,
      status,
      stage,
      activeAttemptId: terminal ? null : attempt.id,
      lastAttemptId: attempt.id,
      workflow: attempt.workflow,
      errorMessage: options.errorMessage ?? null,
      quickConnectCode: terminal ? null : this.controllerState.quickConnectCode,
      userName: options.userName ?? (stage === 'COMPLETE' ? this.controllerState.userName : null)
    };
    this.notifySubscribers();
  }

  private finishFromError(attempt: InternalAttempt, error: unknown): SessionControllerResult {
    if (attempt.terminalResult) return attempt.terminalResult;

    if (error instanceof AttemptAbortedError || attempt.controller.signal.aborted || !this.isCurrent(attempt)) {
      if (attempt.cancelReason === 'timeout') {
        return this.finishFailure(attempt, 'timeout', 'Authentication request timed out');
      }
      return this.finishCancelled(attempt, attempt.cancelReason === 'superseded' ? 'stale' : 'cancelled');
    }

    if (error instanceof ControllerFailure) {
      if (typeof error.status === 'number') attempt.httpStatus = error.status;
      return this.finishFailure(attempt, error.classification, error.message);
    }

    const status = extractStatus(error);
    if (typeof status === 'number') attempt.httpStatus = status;
    const kind = extractKind(error);
    const classification: SessionResultClassification = status === 400 || status === 401 || status === 403 || kind.includes('authentication') || kind.includes('session-expired')
      ? 'invalid-credentials'
      : status !== undefined && status >= 500
        ? 'server-error'
      : kind.includes('timeout')
        ? 'timeout'
        : kind.includes('invalid-server-response') || (kind.includes('invalid') && kind.includes('response'))
          ? 'invalid-response'
        : kind.includes('network') || kind.includes('unreachable') || error instanceof TypeError
          ? 'network-error'
          : 'unknown';
    const fallback = classification === 'invalid-credentials'
      ? 'The username or password was not accepted'
      : classification === 'timeout'
        ? 'Authentication request timed out'
        : 'Authentication failed';
    const message = sanitizeMessage(error, attempt.sensitiveValues);
    return this.finishFailure(attempt, classification, message === 'Authentication failed' ? fallback : message);
  }

  private finishFailure(
    attempt: InternalAttempt,
    classification: SessionResultClassification,
    message: string
  ): SessionControllerResult {
    if (attempt.terminalResult) return attempt.terminalResult;
    const safeMessage = sanitizeMessage(message, attempt.sensitiveValues);
    const result: SessionControllerResult = {
      attemptId: attempt.id,
      status: 'error',
      classification,
      errorMessage: safeMessage,
      userIdSuffix: attempt.userIdSuffix
    };
    attempt.terminalResult = result;
    this.emit(attempt, 'FAILED', classification, { errorMessage: safeMessage });
    return result;
  }

  private finishCancelled(
    attempt: InternalAttempt,
    classification: 'cancelled' | 'stale'
  ): SessionControllerResult {
    if (attempt.terminalResult) return attempt.terminalResult;
    const result: SessionControllerResult = {
      attemptId: attempt.id,
      status: 'idle',
      classification
    };
    attempt.terminalResult = result;
    this.emit(attempt, 'CANCELLED', classification);
    return result;
  }

  private cancelAttempt(attempt: InternalAttempt, reason: 'cancelled' | 'superseded') {
    if (attempt.terminalResult) return;
    attempt.cancelReason = reason;
    attempt.controller.abort();
    this.finishCancelled(attempt, reason === 'superseded' ? 'stale' : 'cancelled');
    this.cleanupAttempt(attempt);
  }

  private supersedeActiveAttempt() {
    if (this.activeAttempt) {
      this.cancelAttempt(this.activeAttempt, 'superseded');
    }
  }

  private cleanupAttempt(attempt: InternalAttempt) {
    if (attempt.timeoutHandle !== undefined) {
      clearTimeout(attempt.timeoutHandle);
      attempt.timeoutHandle = undefined;
    }
    attempt.duplicateKey = null;
    attempt.sensitiveValues.clear();
    if (this.activeAttempt === attempt && attempt.terminalResult) {
      this.activeAttempt = null;
    }
  }

  private isDuplicate(key: DuplicateKey) {
    const active = this.activeAttempt;
    if (!active || !active.promise || !active.duplicateKey || active.terminalResult) return false;
    if (active.duplicateKey.workflow !== key.workflow) return false;
    if (key.workflow === 'password' && active.duplicateKey.workflow === 'password') {
      return (
        active.duplicateKey.serverUrl === key.serverUrl &&
        active.duplicateKey.serverId === key.serverId &&
        active.duplicateKey.username === key.username &&
        active.duplicateKey.password === key.password
      );
    }
    return (
      key.workflow === 'quick-connect' &&
      active.duplicateKey.workflow === 'quick-connect' &&
      active.duplicateKey.serverUrl === key.serverUrl &&
      active.duplicateKey.serverId === key.serverId
    );
  }

  private isCurrent(attempt: InternalAttempt) {
    return this.activeAttempt === attempt && !attempt.terminalResult && !attempt.controller.signal.aborted;
  }

  private assertCurrent(attempt: InternalAttempt) {
    if (!this.isCurrent(attempt)) throw new AttemptAbortedError();
  }

  private operationContext(attempt: InternalAttempt): SessionOperationContext {
    return {
      attemptId: attempt.id,
      signal: attempt.controller.signal,
      isCurrent: () => this.isCurrent(attempt)
    };
  }

  private normalizeForDuplicateCheck(rawUrl: string) {
    try {
      return normalizeServerUrl(rawUrl);
    } catch {
      return rawUrl.trim();
    }
  }

  private validateServerUrl(rawUrl: string) {
    try {
      return normalizeServerUrl(rawUrl);
    } catch {
      throw new ControllerFailure('invalid-input', 'Server URL is not valid');
    }
  }

  private async resolveDeviceIdentity(attempt: InternalAttempt) {
    let device: SessionDeviceIdentity;
    try {
      device = await raceWithAbort(
        Promise.resolve(this.dependencies.getDeviceIdentity()),
        attempt.controller.signal
      );
    } catch {
      throw new ControllerFailure('invalid-input', 'Device identity is unavailable');
    }
    if (
      !isNonEmptyString(device?.deviceId) ||
      !isNonEmptyString(device?.deviceName) ||
      !isNonEmptyString(device?.applicationVersion)
    ) {
      throw new ControllerFailure('invalid-input', 'Device identity is incomplete');
    }
    return device;
  }

  private updateQuickConnectCode(attempt: InternalAttempt, code: string) {
    if (!this.isCurrent(attempt)) return;
    this.controllerState = {
      ...this.controllerState,
      quickConnectCode: code
    };
    this.notifySubscribers();
  }

  private notifySubscribers() {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A view subscriber cannot take ownership of or interrupt authentication.
      }
    }
  }
}
