import type { PtvError, PtvErrorKind } from '../types/ptv';

export function toPtvError(input: unknown, kind: PtvErrorKind): PtvError {
  if (input && typeof input === 'object') {
    const error = input as Partial<{ message?: unknown; status?: unknown; code?: unknown }>;
    return {
      kind,
      message: typeof error.message === 'string' && error.message.trim() ? error.message : 'Request failed',
      code: typeof error.code === 'number' ? error.code : typeof error.status === 'number' ? error.status : undefined,
      recoverable: !['invalid-server-response', 'malformed-json', 'permission-denied'].includes(kind)
    };
  }

  return {
    kind,
    message: typeof input === 'string' && input.trim() ? input : 'Request failed',
    recoverable: true
  };
}

export function mapStatusToErrorKind(status: number): PtvErrorKind {
  if (status === 401 || status === 403) return 'authentication-failed';
  if (status === 400) return 'authentication-failed';
  if (status === 404 || status === 410) return 'server-unreachable';
  if (status === 408) return 'request-timeout';
  if (status === 415 || status === 422) return 'invalid-server-response';
  if (status >= 500) return 'server-error';
  return 'unknown';
}

export function isRecoverableError(error: PtvError): boolean {
  return error.recoverable;
}
