export const HOME_PERFORMANCE_SHELVES = [
  'continue',
  'nextup',
  'movies',
  'shows'
] as const;

export type HomePerformanceShelf = (typeof HOME_PERFORMANCE_SHELVES)[number];
export type HomePerformanceCacheResult = 'hit' | 'miss';
export type HomePerformanceRowOutcome = 'pending' | 'success' | 'error' | 'cancelled';
export type HomePerformanceAttemptStatus = 'active' | 'complete' | 'route-hidden' | 'cancelled';

export interface HomePerformanceRowMetrics {
  readonly shelf: HomePerformanceShelf;
  readonly cache: HomePerformanceCacheResult;
  readonly durationMs: number | null;
  readonly outcome: HomePerformanceRowOutcome;
  readonly renderCount: number;
}

export interface HomePerformanceAttemptMetrics {
  readonly attemptId: string;
  readonly usableMs: number | null;
  readonly firstPopulatedMs: number | null;
  readonly maxActiveRequests: number;
  readonly imageFailures: number;
  readonly status: HomePerformanceAttemptStatus;
  readonly rows: Readonly<Record<HomePerformanceShelf, HomePerformanceRowMetrics>>;
}

export interface HomePerformanceRowUpdate {
  cache?: HomePerformanceCacheResult;
  durationMs?: number | null;
  outcome?: HomePerformanceRowOutcome;
  renderCount?: number;
}

export interface HomePerformanceAttemptUpdate {
  attemptId: string;
  usableMs?: number | null;
  firstPopulatedMs?: number | null;
  maxActiveRequests?: number;
  imageFailures?: number;
  status?: HomePerformanceAttemptStatus;
  rows?: Partial<Record<HomePerformanceShelf, HomePerformanceRowUpdate>>;
}

export interface HomePerformanceSnapshot {
  readonly latestAttempt: HomePerformanceAttemptMetrics | null;
  readonly recentAttempts: readonly HomePerformanceAttemptMetrics[];
}

interface MutableHomePerformanceRowMetrics {
  shelf: HomePerformanceShelf;
  cache: HomePerformanceCacheResult;
  durationMs: number | null;
  outcome: HomePerformanceRowOutcome;
  renderCount: number;
}

interface MutableHomePerformanceAttemptMetrics {
  attemptId: string;
  usableMs: number | null;
  firstPopulatedMs: number | null;
  maxActiveRequests: number;
  imageFailures: number;
  status: HomePerformanceAttemptStatus;
  rows: Record<HomePerformanceShelf, MutableHomePerformanceRowMetrics>;
}

const MAX_ATTEMPTS = 4;
const ATTEMPT_STATUSES = new Set<HomePerformanceAttemptStatus>([
  'active',
  'complete',
  'route-hidden',
  'cancelled'
]);
const ROW_OUTCOMES = new Set<HomePerformanceRowOutcome>([
  'pending',
  'success',
  'error',
  'cancelled'
]);
const CACHE_RESULTS = new Set<HomePerformanceCacheResult>(['hit', 'miss']);

function createRows(): Record<HomePerformanceShelf, MutableHomePerformanceRowMetrics> {
  return Object.fromEntries(HOME_PERFORMANCE_SHELVES.map(shelf => [
    shelf,
    {
      shelf,
      cache: 'miss',
      durationMs: null,
      outcome: 'pending',
      renderCount: 0
    }
  ])) as Record<HomePerformanceShelf, MutableHomePerformanceRowMetrics>;
}

function sanitizeMeasurement(value: unknown, fallback: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function sanitizeCount(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.floor(Math.max(0, value));
}

function isAttemptStatus(value: unknown): value is HomePerformanceAttemptStatus {
  return ATTEMPT_STATUSES.has(value as HomePerformanceAttemptStatus);
}

function isRowOutcome(value: unknown): value is HomePerformanceRowOutcome {
  return ROW_OUTCOMES.has(value as HomePerformanceRowOutcome);
}

function isCacheResult(value: unknown): value is HomePerformanceCacheResult {
  return CACHE_RESULTS.has(value as HomePerformanceCacheResult);
}

function immutableAttempt(
  attempt: MutableHomePerformanceAttemptMetrics
): HomePerformanceAttemptMetrics {
  const rows = Object.fromEntries(HOME_PERFORMANCE_SHELVES.map(shelf => [
    shelf,
    Object.freeze({ ...attempt.rows[shelf] })
  ])) as Record<HomePerformanceShelf, HomePerformanceRowMetrics>;

  return Object.freeze({
    attemptId: attempt.attemptId,
    usableMs: attempt.usableMs,
    firstPopulatedMs: attempt.firstPopulatedMs,
    maxActiveRequests: attempt.maxActiveRequests,
    imageFailures: attempt.imageFailures,
    status: attempt.status,
    rows: Object.freeze(rows)
  });
}

/**
 * Retains privacy-safe Home timings for diagnostics. Session keys are used only
 * as an invalidation boundary and are never included in returned snapshots.
 */
export class HomePerformanceStore {
  #sessionKey: string | null = null;
  #attempts: MutableHomePerformanceAttemptMetrics[] = [];
  #validAttemptIds = new Set<string>();
  #attemptSequence = 0;

  public synchronizeSession(sessionKey: string | null) {
    const nextSessionKey = typeof sessionKey === 'string' && sessionKey.length > 0
      ? sessionKey
      : null;
    if (nextSessionKey === this.#sessionKey) return;

    this.#sessionKey = nextSessionKey;
    this.#attempts = [];
    this.#validAttemptIds.clear();
  }

  public beginAttempt() {
    if (!this.#sessionKey) return null;

    const attemptId = `home_${(++this.#attemptSequence).toString(36)}`;
    const attempt: MutableHomePerformanceAttemptMetrics = {
      attemptId,
      usableMs: null,
      firstPopulatedMs: null,
      maxActiveRequests: 0,
      imageFailures: 0,
      status: 'active',
      rows: createRows()
    };

    this.#attempts.push(attempt);
    this.#validAttemptIds.add(attemptId);
    while (this.#attempts.length > MAX_ATTEMPTS) {
      const removed = this.#attempts.shift();
      if (removed) this.#validAttemptIds.delete(removed.attemptId);
    }

    return attemptId;
  }

  public upsert(update: HomePerformanceAttemptUpdate) {
    if (!this.#sessionKey || !this.#validAttemptIds.has(update.attemptId)) return false;
    const attempt = this.#attempts.find(candidate => candidate.attemptId === update.attemptId);
    if (!attempt) return false;

    if (attempt.usableMs === null && update.usableMs !== null) {
      attempt.usableMs = sanitizeMeasurement(update.usableMs, null);
    }
    if (attempt.firstPopulatedMs === null && update.firstPopulatedMs !== null) {
      attempt.firstPopulatedMs = sanitizeMeasurement(update.firstPopulatedMs, null);
    }
    attempt.maxActiveRequests = Math.max(
      attempt.maxActiveRequests,
      sanitizeCount(update.maxActiveRequests, attempt.maxActiveRequests)
    );
    attempt.imageFailures = Math.max(
      attempt.imageFailures,
      sanitizeCount(update.imageFailures, attempt.imageFailures)
    );

    if (isAttemptStatus(update.status) && (attempt.status === 'active' || update.status !== 'active')) {
      attempt.status = update.status;
    }

    for (const shelf of HOME_PERFORMANCE_SHELVES) {
      const rowUpdate = update.rows?.[shelf];
      if (!rowUpdate) continue;
      const row = attempt.rows[shelf];

      if (isCacheResult(rowUpdate.cache)) row.cache = rowUpdate.cache;
      if (rowUpdate.durationMs !== null) {
        row.durationMs = sanitizeMeasurement(rowUpdate.durationMs, row.durationMs);
      }
      if (isRowOutcome(rowUpdate.outcome) && (row.outcome === 'pending' || rowUpdate.outcome !== 'pending')) {
        row.outcome = rowUpdate.outcome;
      }
      row.renderCount = Math.max(
        row.renderCount,
        sanitizeCount(rowUpdate.renderCount, row.renderCount)
      );
    }

    return true;
  }

  public getLatest() {
    const latest = this.#attempts[this.#attempts.length - 1];
    return latest ? immutableAttempt(latest) : null;
  }

  public getRecent() {
    return Object.freeze(this.#attempts.map(immutableAttempt));
  }

  public snapshot(): HomePerformanceSnapshot {
    const recentAttempts = this.getRecent();
    return Object.freeze({
      latestAttempt: recentAttempts[recentAttempts.length - 1] ?? null,
      recentAttempts
    });
  }

  public clear() {
    this.#sessionKey = null;
    this.#attempts = [];
    this.#validAttemptIds.clear();
  }
}
