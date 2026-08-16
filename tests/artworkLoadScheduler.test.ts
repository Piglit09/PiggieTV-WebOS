import { describe, expect, it, vi } from 'vitest';
import { ArtworkLoadScheduler } from '../src/utils/artworkLoadScheduler';

function scheduleTasks(scheduler: ArtworkLoadScheduler, count: number) {
  const starts: number[] = [];
  const permits = Array.from({ length: count }, (_, index) => scheduler.schedule(() => {
    starts.push(index + 1);
  }));
  return { permits, starts };
}

describe('ArtworkLoadScheduler', () => {
  it('starts at most six tasks and releases capacity for success and error-equivalent completion', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const { permits, starts } = scheduleTasks(scheduler, 8);

    expect(starts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(2);

    permits[0]?.release();
    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(1);

    // CardTile releases the same permit after either an image load or image error.
    permits[1]?.release();
    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('removes a cancelled queued task and advances the next eligible task', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const { permits, starts } = scheduleTasks(scheduler, 8);

    permits[6]?.cancel();
    expect(scheduler.pendingCount).toBe(1);

    permits[0]?.release();
    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('cancels an active task exactly like a release and starts the next queued task', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const { permits, starts } = scheduleTasks(scheduler, 7);

    permits[2]?.cancel();

    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('settles permits idempotently without losing additional capacity', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const { permits, starts } = scheduleTasks(scheduler, 7);

    permits[0]?.release();
    permits[0]?.release();
    permits[0]?.cancel();

    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(scheduler.activeCount).toBe(6);

    for (const permit of permits.slice(1)) permit.release();
    for (const permit of permits) permit.cancel();
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('prioritizes a focused queued task ahead of older pending work', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const { permits, starts } = scheduleTasks(scheduler, 9);

    permits[8]?.prioritize();
    permits[0]?.release();
    permits[1]?.release();

    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 9, 7]);
    expect(scheduler.activeCount).toBe(6);
    expect(scheduler.pendingCount).toBe(1);
  });

  it('does not leak capacity when a task throws while starting', () => {
    const scheduler = new ArtworkLoadScheduler(6);
    const startAfterError = vi.fn();

    expect(() => scheduler.schedule(() => {
      throw new Error('image setup failed');
    })).toThrow('image setup failed');
    expect(scheduler.activeCount).toBe(0);

    scheduler.schedule(startAfterError);
    expect(startAfterError).toHaveBeenCalledOnce();
    expect(scheduler.activeCount).toBe(1);
  });
});
