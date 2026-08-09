import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupRestoreCoordinator } from '../src/app/startupRestoreCoordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('StartupRestoreCoordinator', () => {
  it('reuses a released flight when StrictMode reacquires it before deferred cleanup', async () => {
    vi.useFakeTimers();
    const coordinator = new StartupRestoreCoordinator();
    const task = vi.fn(() => new Promise<void>(() => undefined));

    const first = coordinator.acquire('bootstrap-0', task);
    await Promise.resolve();
    first.release();
    const second = coordinator.acquire('bootstrap-0', task);

    expect(second.generation).toBe(first.generation);
    expect(second.signal).toBe(first.signal);
    expect(task).toHaveBeenCalledTimes(1);
    expect(first.signal.aborted).toBe(false);

    second.release();
    vi.runOnlyPendingTimers();

    expect(first.signal.aborted).toBe(true);
  });

  it('immediately supersedes an older generation when the retry key changes', async () => {
    const coordinator = new StartupRestoreCoordinator();
    const task = vi.fn(() => new Promise<void>(() => undefined));
    const first = coordinator.acquire('bootstrap-0', task);
    await Promise.resolve();

    const retry = coordinator.acquire('bootstrap-1', task);
    await Promise.resolve();

    expect(first.signal.aborted).toBe(true);
    expect(retry.generation).toBe(first.generation + 1);
    expect(task).toHaveBeenCalledTimes(2);

    first.release();
    retry.release();
  });
});
