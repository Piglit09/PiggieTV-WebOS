import type { PtvError } from '../types/ptv';
import { redactSensitiveText } from './redaction';

export interface RequestTrackerEntry {
  id: string;
  url: string;
  method: string;
  category?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  retried?: boolean;
  duplicate?: boolean;
  contentType?: string;
  parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network';
}

export class RequestTracker {
  private readonly activeRequests = new Map<string, RequestTrackerEntry>();
  private readonly completedRequests: RequestTrackerEntry[] = [];
  private sequence = 1;
  private cancelledRequests = 0;
  private timeoutRequests = 0;
  private duplicateCompletions = 0;
  private peakConcurrency = 0;

  private static readonly MAX_HISTORY = 160;

  public start(url: string, method: string, category?: string, route?: string) {
    const id = `req_${this.sequence++}`;
    const entry: RequestTrackerEntry = {
      id,
      url: redactSensitiveText(url),
      method,
      category,
      route,
      startedAt: Date.now()
    };
    this.activeRequests.set(id, entry);
    if (this.activeRequests.size > this.peakConcurrency) {
      this.peakConcurrency = this.activeRequests.size;
    }
    return id;
  }

  public complete(
    id: string,
    status: number,
    durationMs: number,
    retried = false,
    contentType?: string,
    parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network'
  ) {
    const entry = this.resolveActive(id, existing => {
      existing.status = status;
      existing.durationMs = durationMs;
      existing.endedAt = Date.now();
      existing.retried = retried;
      if (contentType) {
        existing.contentType = contentType;
      }
      if (parseResult) {
        existing.parseResult = parseResult;
      }
    });
    return entry;
  }

  public fail(
    id: string,
    error: PtvError | unknown,
    timedOut = false,
    contentType?: string,
    parseResult?: 'json' | 'empty' | 'html' | 'invalid-json' | 'network'
  ) {
    if (timedOut) {
      this.timeoutRequests += 1;
    }
    const entry = this.resolveActive(id, existing => {
      existing.error = this.formatErrorMessage(error);
      existing.timedOut = timedOut;
      existing.endedAt = Date.now();
      if (contentType) {
        existing.contentType = contentType;
      }
      if (parseResult) {
        existing.parseResult = parseResult;
      }
    });
    return entry;
  }

  private formatErrorMessage(error: unknown) {
    if (error instanceof Error) return redactSensitiveText(error.message);

    if (error && typeof error === 'object') {
      const candidate = error as Partial<{
        message?: unknown;
        kind?: unknown;
        code?: unknown;
        status?: unknown;
      }>;
      const status = typeof candidate.code === 'number' ? candidate.code : typeof candidate.status === 'number' ? candidate.status : null;
      const kind = typeof candidate.kind === 'string' ? candidate.kind : null;
      const message = typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? candidate.message.trim()
        : null;
      if (message && status) return redactSensitiveText(`${status}: ${message}`);
      if (message) return redactSensitiveText(message);
      if (kind) return kind;
    }

    return redactSensitiveText(String(error));
  }

  public cancel(id: string, reason = 'Request cancelled') {
    const entry = this.resolveActive(id, existing => {
      existing.cancelled = true;
      existing.error = redactSensitiveText(reason);
      existing.endedAt = Date.now();
      this.cancelledRequests += 1;
    });
    return entry;
  }

  public resetPeakConcurrency() {
    this.peakConcurrency = this.activeRequests.size;
  }

  public clear() {
    this.activeRequests.clear();
    this.completedRequests.length = 0;
    this.sequence = 1;
    this.cancelledRequests = 0;
    this.timeoutRequests = 0;
    this.duplicateCompletions = 0;
    this.peakConcurrency = 0;
  }

  public getActiveCount() {
    return this.activeRequests.size;
  }

  public getActive() {
    return Array.from(this.activeRequests.values());
  }

  public getFailureCount() {
    return this.completedRequests.filter(item => !!item.error && item.cancelled !== true).length;
  }

  public getPeakConcurrency() {
    return this.peakConcurrency;
  }

  public getDuplicateCompletions() {
    return this.duplicateCompletions;
  }

  public getRecentRequests(limit = 30) {
    return this.completedRequests.slice(-limit).concat(Array.from(this.activeRequests.values()));
  }

  public getAverageDuration() {
    const completed = this.completedRequests.filter(item => typeof item.durationMs === 'number');
    if (!completed.length) return 0;
    const sum = completed.reduce((acc, item) => acc + (item.durationMs ?? 0), 0);
    return Math.round(sum / completed.length);
  }

  public getRecentErrors(limit = 15) {
    return this.completedRequests
      .filter(item => !!item.error && item.cancelled !== true)
      .slice(-limit)
      .map(item => `${item.url} -> ${item.error}`);
  }

  public getRecentDurations(limit = 25) {
    return this.completedRequests
      .filter(item => typeof item.durationMs === 'number')
      .slice(-limit)
      .map(item => item.durationMs as number);
  }

  public getRecentCompletions(limit = 10) {
    const completed = this.completedRequests.filter(entry => typeof entry.status === 'number');
    return completed.slice(-limit);
  }

  public getDuplicateCount() {
    return this.duplicateCompletions;
  }

  public getTimeoutCount() {
    return this.timeoutRequests;
  }

  public getCancelledCount() {
    return this.cancelledRequests;
  }

  private resolveActive(id: string, mutator: (entry: RequestTrackerEntry) => void) {
    const entry = this.activeRequests.get(id);
    if (!entry) {
      if (this.completedRequests.find(item => item.id === id)) {
        this.duplicateCompletions += 1;
        const duplicate = this.completedRequests.find(item => item.id === id);
        if (duplicate) duplicate.duplicate = true;
        return null;
      }
      return null;
    }
    this.activeRequests.delete(id);
    mutator(entry);
    this.pushHistory(entry);
    return entry;
  }

  private pushHistory(entry: RequestTrackerEntry) {
    this.completedRequests.push(entry);
    if (this.completedRequests.length > RequestTracker.MAX_HISTORY) {
      this.completedRequests.shift();
    }
  }
}
