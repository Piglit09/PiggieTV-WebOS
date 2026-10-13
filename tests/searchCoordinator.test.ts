import { describe, expect, it, vi } from 'vitest';
import { runPtvSearchTasks, type PtvSearchTask } from '../src/screens/search/searchCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('WebOS progressive search coordinator', () => {
  it('limits server fan-out to two branches and publishes results in completion order', async () => {
    const deferredTasks = Array.from({ length: 4 }, () => deferred<string>());
    const progress: Array<{ responses: readonly string[]; pending: number }> = [];
    let active = 0;
    let peak = 0;
    const tasks: Array<PtvSearchTask<string>> = deferredTasks.map((entry, index) => ({
      id: `branch-${index}`,
      run: () => {
        active += 1;
        peak = Math.max(peak, active);
        return entry.promise.finally(() => { active -= 1; });
      }
    }));

    const result = runPtvSearchTasks(tasks, {
      maxConcurrency: 2,
      budgetMs: 10_000,
      onProgress: snapshot => progress.push({ responses: [...snapshot.responses], pending: snapshot.pending })
    });

    expect(active).toBe(2);
    deferredTasks[1]!.resolve('music genre');
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    expect(peak).toBe(2);
    expect(active).toBe(2);
    expect(progress[0]).toEqual({ responses: ['music genre'], pending: 3 });

    deferredTasks[0]!.resolve('content');
    deferredTasks[2]!.resolve('genre');
    await Promise.resolve();
    await Promise.resolve();
    deferredTasks[3]!.resolve('studio');

    await expect(result).resolves.toMatchObject({
      responses: ['content', 'music genre', 'genre', 'studio'],
      completed: 4,
      failed: 0,
      pending: 0,
      timedOut: false,
      cancelled: false
    });
    expect(peak).toBe(2);
  });

  it('aborts stragglers at the shared search budget without discarding completed work', async () => {
    vi.useFakeTimers();
    const fast = deferred<string>();
    const stalled = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const result = runPtvSearchTasks([
      { id: 'content', run: () => fast.promise },
      { id: 'taxonomy', run: stalled },
      { id: 'studio', run: stalled }
    ], { maxConcurrency: 2, budgetMs: 100 });

    fast.resolve('content');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toMatchObject({
      responses: ['content'],
      timedOut: true,
      cancelled: false
    });
    vi.useRealTimers();
  });
});
