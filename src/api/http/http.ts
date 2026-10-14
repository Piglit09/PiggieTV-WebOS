import type { PtvError } from '../../types/ptv';
import { mapStatusToErrorKind, toPtvError } from '../../core/errors';
import type { RequestTracker } from '../../core/requestTracker';
import {
  PTV_APPLICATION_NAME,
  PTV_APPLICATION_VERSION,
  PTV_DEVICE_NAME
} from '../../config/app';

export type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Opaque authorization ownership captured by an API client before transport.
 * The HTTP layer only coordinates cancellation and raw 401 publication; the
 * provider remains authoritative for ticket identity and current-epoch rules.
 */
export interface AuthenticatedRequestContext {
  ticket: unknown;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onUnauthorized: (ticket: unknown) => void;
}

export interface RequestConfig {
  method?: RequestMethod;
  timeoutMs?: number;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
  onRequestStart?: (url: string) => void;
  onRequestComplete?: (payload: {
    url: string;
    status: number;
    durationMs: number;
    retried: boolean;
    contentType?: string;
    parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network';
  }) => void;
  onRequestFailure?: (payload: {
    url: string;
    errorKind: PtvError['kind'];
    message: string;
    contentType?: string;
    parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network';
    timedOut?: boolean;
    canceled?: boolean;
  }) => void;
  onResponseReceived?: (payload: {
    url: string;
    status: number;
    durationMs: number;
    contentType: string;
  }) => void;
  onBodyRead?: (payload: {
    url: string;
    status: number;
    durationMs: number;
    contentType: string;
    parseResult: 'json' | 'empty' | 'html' | 'invalid-json' | 'network';
  }) => void;
  onJsonParsed?: (payload: {
    url: string;
    status: number;
    durationMs: number;
    contentType: string;
  }) => void;
  requestTracker?: RequestTracker;
  requestCategory?: string;
  requestRoute?: string;
  authenticatedRequest?: AuthenticatedRequestContext;
}

export interface RequestDiagnostics {
  url: string;
  status: number;
  durationMs: number;
  retried?: boolean;
}

export interface JellyfinAuthorizationContext {
  accessToken?: string;
  clientName: string;
  deviceName: string;
  deviceId: string;
  applicationVersion: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

function buildUrl(base: string, query?: Record<string, string | number | boolean | undefined>) {
  const trimmed = base.replace(/\/$/, '');
  const url = new URL(trimmed);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

function escapeAuthorizationValue(value: string) {
  return value.replace(/["\\\r\n]/g, '');
}

function buildHeaders(
  headers?: Record<string, string>,
  authorization?: JellyfinAuthorizationContext | string
) {
  const context: JellyfinAuthorizationContext = typeof authorization === 'string'
      ? {
        accessToken: authorization,
        clientName: PTV_APPLICATION_NAME,
        deviceName: PTV_DEVICE_NAME,
        deviceId: 'unknown',
        applicationVersion: PTV_APPLICATION_VERSION
      }
    : authorization ?? {
        clientName: PTV_APPLICATION_NAME,
        deviceName: PTV_DEVICE_NAME,
        deviceId: 'unknown',
        applicationVersion: PTV_APPLICATION_VERSION
      };
  const embyAuth = [
    `MediaBrowser Client="${escapeAuthorizationValue(context.clientName)}"`,
    `Device="${escapeAuthorizationValue(context.deviceName)}"`,
    `DeviceId="${escapeAuthorizationValue(context.deviceId)}"`,
    `Version="${escapeAuthorizationValue(context.applicationVersion)}"`
  ].join(', ');
  const merged: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...headers
  };
  const accessToken = context.accessToken;
  const embyValue = accessToken ? `${embyAuth}, Token="${escapeAuthorizationValue(accessToken)}"` : embyAuth;
  merged.Authorization = embyValue;
  merged['X-Emby-Authorization'] = embyValue;
  if (accessToken) {
    merged['X-MediaBrowser-Token'] = accessToken;
  }

  return merged;
}

function cancelledRequestError() {
  return toPtvError('Request was cancelled', 'cancelled-request');
}

function isAuthenticatedRequestCurrent(context?: AuthenticatedRequestContext) {
  if (!context) return true;
  try {
    return context.isCurrent();
  } catch {
    return false;
  }
}

function requestCancellationSignals(config: RequestConfig) {
  const signals: AbortSignal[] = [];
  if (config.signal) signals.push(config.signal);
  const authenticatedSignal = config.authenticatedRequest?.signal;
  if (authenticatedSignal && !signals.includes(authenticatedSignal)) signals.push(authenticatedSignal);
  return signals;
}

class RequestCancellationForwarder {
  private readonly bindings: Array<{
    signal: AbortSignal;
    listener: EventListener;
  }>;

  public constructor(signals: AbortSignal[], controller: AbortController) {
    this.bindings = signals.map(signal => {
      const binding = {
        signal,
        listener: (() => controller.abort()) as EventListener
      };
      binding.signal.addEventListener('abort', binding.listener, { once: true });
      return binding;
    });

    if (this.bindings.some(binding => binding.signal.aborted)) controller.abort();
  }

  public detach() {
    this.bindings.forEach(binding => {
      binding.signal.removeEventListener('abort', binding.listener);
    });
  }
}

function assertRequestCurrent(config: RequestConfig) {
  if (
    requestCancellationSignals(config).some(signal => signal.aborted) ||
    !isAuthenticatedRequestCurrent(config.authenticatedRequest)
  ) {
    throw cancelledRequestError();
  }
}

function wait(ms: number, config: RequestConfig) {
  assertRequestCurrent(config);
  const signals = requestCancellationSignals(config);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signals.forEach(signal => signal.removeEventListener('abort', cancel));
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!isAuthenticatedRequestCurrent(config.authenticatedRequest)) {
        reject(cancelledRequestError());
        return;
      }
      resolve();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanup();
      reject(cancelledRequestError());
    };
    const timeoutHandle = setTimeout(complete, ms);
    signals.forEach(signal => signal.addEventListener('abort', cancel, { once: true }));
    if (signals.some(signal => signal.aborted)) cancel();
  });
}

function sanitizeTrackerUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const masked = new Set(['token', 'access_token', 'apikey', 'api_key', 'secret', 'code']);
    for (const [key] of Array.from(parsed.searchParams.entries())) {
      if (masked.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '***redacted***');
      }
    }
    parsed.hash = '';
    const suffix = parsed.searchParams.toString();
    return suffix ? `${parsed.origin}${parsed.pathname}?${suffix}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.replace(/([?&](token|access[_-]?token|api[_-]?key|secret|code)=)[^&]+/gi, '$1***redacted***');
  }
}

function toSafePtvError(error: unknown): PtvError {
  if (error && typeof error === 'object' && 'kind' in error) {
    const candidate = error as Partial<PtvError>;
    const kind = candidate.kind;
    if (
      kind === 'network-unavailable' ||
      kind === 'server-unreachable' ||
      kind === 'authentication-failed' ||
      kind === 'session-expired' ||
      kind === 'request-timeout' ||
      kind === 'server-error' ||
      kind === 'malformed-json' ||
      kind === 'cancelled-request' ||
      kind === 'stale-response' ||
      kind === 'invalid-server-response' ||
      kind === 'unsupported-media' ||
      kind === 'playback-failed' ||
      kind === 'transcode-failed' ||
      kind === 'image-failed' ||
      kind === 'plugin-unavailable' ||
      kind === 'permission-denied' ||
      kind === 'unknown'
    ) {
      return {
        kind,
        message: typeof candidate.message === 'string' && candidate.message.trim() ? candidate.message : 'Request failed',
        code: candidate.code,
        requestId: candidate.requestId,
        recoverable: candidate.recoverable ?? true
      };
    }
  }

  return toPtvError(error, 'unknown');
}

function classifyResponsePayload(payload: string, contentType: string): 'json' | 'empty' | 'html' | 'invalid-json' {
  if (!payload.trim()) {
    return 'empty';
  }
  if (contentType.includes('text/html') || payload.trim().startsWith('<') || payload.toLowerCase().includes('<!doctype html')) {
    return 'html';
  }
  return 'invalid-json';
}

function extractErrorMessage(payload: string): string | null {
  if (!payload.trim()) return null;

  const candidate: Record<string, unknown> = (() => {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const messageCandidate =
    typeof candidate.Message === 'string' ? candidate.Message :
    typeof candidate.ErrorMessage === 'string' ? candidate.ErrorMessage :
    typeof (candidate as { error?: unknown }).error === 'string' ? (candidate as { error?: string }).error :
    typeof candidate.message === 'string' ? candidate.message :
    typeof candidate.error === 'string' ? candidate.error : null;
  if (!messageCandidate) return null;
  const cleaned = messageCandidate.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function responseErrorMessage(
  payload: string,
  status: number,
  requestCategory: string | undefined,
  carriesCredential: boolean
): string {
  if (requestCategory === 'authentication' || carriesCredential) {
    return status === 400 || status === 401 || status === 403
      ? requestCategory === 'authentication'
        ? 'Authentication request was rejected'
        : `Authenticated request was rejected (${status})`
      : requestCategory === 'authentication'
        ? `Authentication request failed (${status})`
        : `Authenticated request failed (${status})`;
  }
  return extractErrorMessage(payload) ?? `Request failed (${status})`;
}

function mapTransportError(error: unknown): PtvError {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') {
      return toPtvError('Request was cancelled', 'cancelled-request');
    }
    return toPtvError(error.message, 'network-unavailable');
  }

  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('network request failed')
    ) {
      return toPtvError('PiggieTV could not reach the server', 'server-unreachable');
    }
    if (message.includes('certificate') || message.includes('ssl') || message.includes('tls')) {
      return toPtvError('A secure connection to the server could not be established', 'server-unreachable');
    }
  }

  return toSafePtvError(error);
}

function isTimeoutAbort(signalError: unknown, timeoutTriggered: boolean) {
  return signalError instanceof DOMException && signalError.name === 'AbortError' && timeoutTriggered;
}

function isCallerAbort(signalError: unknown, timeoutTriggered: boolean) {
  return signalError instanceof DOMException && signalError.name === 'AbortError' && !timeoutTriggered;
}

export async function requestJson<T>(
  url: string,
  config: RequestConfig = {},
  authorization?: JellyfinAuthorizationContext | string
): Promise<T> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.retries ?? MAX_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? RETRY_DELAY_MS;
  const method = config.method ?? 'GET';
  const preparedUrl = buildUrl(url, config.query);
  const safeUrl = sanitizeTrackerUrl(preparedUrl);
  const tracker = config.requestTracker;
  const requestCategory = config.requestCategory;
  const requestRoute = config.requestRoute;
  const carriesCredential = typeof authorization === 'string'
    ? authorization.trim().length > 0
    : Boolean(authorization?.accessToken?.trim());

  let attempt = 0;
  let lastError: PtvError = { kind: 'unknown', message: 'Request failed', recoverable: false };

  while (attempt <= maxRetries) {
    assertRequestCurrent(config);
    const startedAt = Date.now();
    const controller = new AbortController();
    let timeoutTriggered = false;
    let requestFinalized = false;
    const timeoutId = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      timeoutTriggered = true;
      controller.abort();
    }, timeoutMs);

    const cancellationSignals = requestCancellationSignals(config);
    const cancellationForwarder = new RequestCancellationForwarder(cancellationSignals, controller);

    const requestId = tracker?.start(safeUrl, method, requestCategory, requestRoute) ?? null;
    let parseResult: 'json' | 'empty' | 'html' | 'invalid-json' | 'network' | undefined;
    let contentType = 'unknown';
    if (config.onRequestStart) {
      config.onRequestStart(safeUrl);
    }

    try {
      const response = await fetch(preparedUrl, {
        method,
        headers: buildHeaders(config.headers, authorization),
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        signal: controller.signal
      });

      const durationMs = Math.max(1, Date.now() - startedAt);
      contentType = response.headers.get('content-type') ?? 'unknown';
      assertRequestCurrent(config);
      if (
        response.status === 401 &&
        config.authenticatedRequest &&
        isAuthenticatedRequestCurrent(config.authenticatedRequest)
      ) {
        try {
          config.authenticatedRequest.onUnauthorized(config.authenticatedRequest.ticket);
        } catch {
          // Rejection publication cannot replace the transport's HTTP result.
        }
      }
      if (config.onResponseReceived) {
        config.onResponseReceived({
          url: safeUrl,
          status: response.status,
          durationMs,
          contentType
        });
      }
      if (response.status !== 401) assertRequestCurrent(config);
      if (!response.ok) {
        const payload = await response.text().catch(() => '');
        parseResult = classifyResponsePayload(payload, contentType);
        const errorMessage = responseErrorMessage(
          payload,
          response.status,
          requestCategory,
          carriesCredential
        );
        lastError = toPtvError(
          { message: errorMessage, code: response.status },
          mapStatusToErrorKind(response.status)
        );
        if (requestId) {
          tracker?.fail(requestId, lastError, false, contentType, parseResult);
          requestFinalized = true;
        }
        throw lastError;
      }

      const rawBody = await response.text();
      assertRequestCurrent(config);
      if (config.onBodyRead) {
        const bodyResult = classifyResponsePayload(rawBody, contentType);
        parseResult = bodyResult === 'json' ? bodyResult : parseResult ?? bodyResult;
        config.onBodyRead({
          url: safeUrl,
          status: response.status,
          durationMs: Math.max(1, Date.now() - startedAt),
          contentType,
          parseResult: parseResult ?? bodyResult
        });
      }
      if (!rawBody) {
        parseResult = 'empty';
        if (config.onRequestComplete) {
          config.onRequestComplete({
            url: safeUrl,
            status: response.status,
            durationMs,
            retried: attempt > 0,
            contentType,
            parseResult
          });
        }
        if (requestId) {
          tracker?.complete(requestId, response.status, durationMs, attempt > 0, contentType, parseResult);
          requestFinalized = true;
        }
        return {} as T;
      }

      if (contentType.includes('text/html') || rawBody.trim().startsWith('<') || rawBody.toLowerCase().includes('<!doctype html')) {
        parseResult = 'html';
        lastError = toPtvError('Server returned an unexpected response.', 'invalid-server-response');
        if (requestId) {
          tracker?.fail(requestId, lastError, false, contentType, parseResult);
          requestFinalized = true;
        }
        throw lastError;
      }

      let data: T;
      try {
        data = JSON.parse(rawBody) as T;
        if (config.onJsonParsed) {
          config.onJsonParsed({
            url: safeUrl,
            status: response.status,
            durationMs: Math.max(1, Date.now() - startedAt),
            contentType
          });
        }
      } catch {
        lastError = toPtvError('Invalid JSON response from server', 'malformed-json');
        parseResult = 'invalid-json';
        if (requestId) {
          tracker?.fail(requestId, lastError, false, contentType, parseResult);
          requestFinalized = true;
        }
        throw lastError;
      }

      parseResult = 'json';
      if (config.onRequestComplete) {
        config.onRequestComplete({
          url: safeUrl,
          status: response.status,
          durationMs,
          retried: attempt > 0,
          contentType,
          parseResult
        });
      }
      if (requestId) {
        tracker?.complete(requestId, response.status, durationMs, attempt > 0, contentType, parseResult);
        requestFinalized = true;
      }

      return data;
    } catch (error) {
      // Legacy webOS Chromium can surface an aborted fetch as TypeError while
      // newer engines use DOMException/AbortError. The controller state is the
      // reliable cross-engine source for distinguishing our timeout from a
      // caller/credential-epoch cancellation.
      const legacyFetchAbort = controller.signal.aborted && error instanceof TypeError;
      const requestTimedOut = isTimeoutAbort(error, timeoutTriggered) || (timeoutTriggered && legacyFetchAbort);
      const requestCancelled = !requestTimedOut && (legacyFetchAbort || isCallerAbort(error, timeoutTriggered) || (
        error !== null &&
        typeof error === 'object' &&
        'kind' in error &&
        (error as { kind?: unknown }).kind === 'cancelled-request'
      ));
      if (requestTimedOut) {
        lastError = toPtvError('The server took too long to respond', 'request-timeout');
      } else if (requestCancelled) {
        lastError = toPtvError('Request was cancelled', 'cancelled-request');
      } else if (error !== lastError) {
        lastError = mapTransportError(error);
      }

      if (requestId && !requestFinalized && !requestTimedOut && !requestCancelled) {
        if (parseResult) {
          tracker?.fail(requestId, lastError, false, contentType, parseResult);
        } else {
          tracker?.fail(requestId, lastError, false, contentType, 'network');
        }
      } else if (requestId && requestTimedOut) {
        tracker?.fail(requestId, lastError, true, contentType, parseResult ?? 'network');
      } else if (requestId && requestCancelled) {
        tracker?.cancel(requestId);
      }

      const shouldRetry =
        attempt < maxRetries &&
        (requestTimedOut || ['network-unavailable', 'server-unreachable', 'request-timeout'].includes(lastError.kind));

      if (config.onRequestFailure) {
        config.onRequestFailure({
          url: safeUrl,
          errorKind: lastError.kind,
          message: lastError.message,
          contentType,
          parseResult,
          timedOut: requestTimedOut,
          canceled: requestCancelled
        });
      }

      if (!shouldRetry) {
        throw lastError;
      }

      attempt += 1;
      await wait(retryDelayMs * attempt, config);
    } finally {
      clearTimeout(timeoutId);
      cancellationForwarder.detach();
    }
  }

  throw lastError;
}
