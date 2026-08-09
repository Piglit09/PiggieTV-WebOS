export interface PtvSearchTask<T> {
  id: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export interface PtvSearchProgress<T> {
  responses: readonly T[];
  completed: number;
  failed: number;
  pending: number;
  timedOut: boolean;
}

export interface PtvSearchSummary<T> extends PtvSearchProgress<T> {
  errors: readonly unknown[];
  cancelled: boolean;
}

interface RunPtvSearchTasksOptions<T> {
  signal?: AbortSignal;
  maxConcurrency?: number;
  budgetMs?: number;
  onProgress?: (progress: PtvSearchProgress<T>) => void;
}

const DEFAULT_SEARCH_CONCURRENCY = 2;
const DEFAULT_SEARCH_BUDGET_MS = 7_000;

/**
 * Runs search branches in completion order without allowing a wide fan-out to
 * overload a busy media server. Successful branches are published as soon as
 * they finish, while the remaining work continues within one bounded budget.
 */
export function runPtvSearchTasks<T>(
  tasks: readonly PtvSearchTask<T>[],
  options: RunPtvSearchTasksOptions<T> = {}
): Promise<PtvSearchSummary<T>> {
  const maxConcurrency = Math.max(
    1,
    Math.min(tasks.length || 1, Math.floor(options.maxConcurrency ?? DEFAULT_SEARCH_CONCURRENCY))
  );
  const budgetMs = Math.max(1, Math.floor(options.budgetMs ?? DEFAULT_SEARCH_BUDGET_MS));
  const requestController = new AbortController();
  const responses = new Map<number, T>();
  const errors: unknown[] = [];
  let active = 0;
  let completed = 0;
  let nextTask = 0;
  let failed = 0;
  let finished = false;
  let timedOut = false;

  return new Promise(resolve => {
    const snapshot = (): PtvSearchProgress<T> => ({
      responses: [...responses.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, response]) => response),
      completed,
      failed,
      pending: Math.max(0, tasks.length - completed),
      timedOut
    });
    const publish = () => options.onProgress?.(snapshot());
    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(budgetTimer);
      options.signal?.removeEventListener('abort', onCallerAbort);
      if (!requestController.signal.aborted) requestController.abort(cancelled ? 'search-cancelled' : 'search-finished');
      const progress = snapshot();
      resolve({ ...progress, errors: [...errors], cancelled });
    };
    const startNext = () => {
      if (finished) return;
      while (active < maxConcurrency && nextTask < tasks.length) {
        const taskIndex = nextTask++;
        const task = tasks[taskIndex]!;
        active += 1;
        void task.run(requestController.signal)
          .then(response => {
            if (finished) return;
            responses.set(taskIndex, response);
          })
          .catch(cause => {
            if (finished || requestController.signal.aborted) return;
            failed += 1;
            errors.push(cause);
          })
          .finally(() => {
            if (finished) return;
            active -= 1;
            completed += 1;
            publish();
            if (completed >= tasks.length) {
              finish(false);
              return;
            }
            startNext();
          });
      }
    };
    const onCallerAbort = () => finish(true);
    const budgetTimer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      publish();
      finish(false);
    }, budgetMs);

    if (options.signal?.aborted) {
      finish(true);
      return;
    }
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (!tasks.length) {
      finish(false);
      return;
    }
    startNext();
  });
}
