import type { PtvError } from '../../types/ptv';
import { mapStatusToErrorKind, toPtvError } from '../../core/errors';
import type { RequestTracker } from '../../core/requestTracker';
import {
  PTV_APPLICATION_NAME,
  PTV_APPLICATION_VERSION,
  PTV_DEVICE_NAME
} from '../../config/app';

export type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

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

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  let attempt = 0;
  let lastError: PtvError = { kind: 'unknown', message: 'Request failed', recoverable: false };

  while (attempt <= maxRetries) {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timeoutTriggered = false;
    let requestFinalized = false;
    const timeoutId = window.setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, timeoutMs);

    const onParentAbort = () => {
      controller.abort();
    };

    if (config.signal) {
      if (config.signal.aborted) {
        clearTimeout(timeoutId);
        throw toPtvError('Request cancelled', 'cancelled-request');
      }
      config.signal.addEventListener('abort', onParentAbort, { once: true });
    }

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
      if (config.onResponseReceived) {
        config.onResponseReceived({
          url: safeUrl,
          status: response.status,
          durationMs,
          contentType
        });
      }
      if (!response.ok) {
        const payload = await response.text().catch(() => '');
        parseResult = classifyResponsePayload(payload, contentType);
        const errorMessage = extractErrorMessage(payload) ?? `Request failed (${response.status})`;
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
      const requestTimedOut = isTimeoutAbort(error, timeoutTriggered);
      const requestCancelled = isCallerAbort(error, timeoutTriggered);
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
      await wait(retryDelayMs * attempt);
    } finally {
      clearTimeout(timeoutId);
      if (config.signal) {
        config.signal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  throw lastError;
}
