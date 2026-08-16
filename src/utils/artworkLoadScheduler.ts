export interface ArtworkLoadPermit {
  cancel: () => void;
  prioritize: () => void;
  release: () => void;
}

interface ArtworkLoadTask {
  cancelled: boolean;
  settled: boolean;
  started: boolean;
  start: () => void;
}

export class ArtworkLoadScheduler {
  private activeLoads = 0;
  private readonly pending: ArtworkLoadTask[] = [];

  public constructor(public readonly maxConcurrent: number) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('ArtworkLoadScheduler requires at least one concurrent load.');
    }
  }

  public schedule(start: () => void): ArtworkLoadPermit {
    const task: ArtworkLoadTask = {
      cancelled: false,
      settled: false,
      started: false,
      start
    };

    const settle = (cancelled: boolean) => {
      if (task.settled) return;
      task.cancelled = task.cancelled || cancelled;
      task.settled = true;
      if (task.started) {
        this.activeLoads = Math.max(0, this.activeLoads - 1);
      } else {
        const pendingIndex = this.pending.indexOf(task);
        if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
      }
      this.drain();
    };

    const prioritize = () => {
      if (task.started || task.settled) return;
      const index = this.pending.indexOf(task);
      if (index <= 0) return;
      this.pending.splice(index, 1);
      this.pending.unshift(task);
      this.drain();
    };

    this.pending.push(task);
    this.drain();

    return {
      cancel: () => settle(true),
      prioritize,
      release: () => settle(false)
    };
  }

  public clear() {
    for (const task of this.pending) {
      if (!task.started) {
        task.cancelled = true;
        task.settled = true;
      }
    }
    this.pending.length = 0;
  }

  public get activeCount() {
    return this.activeLoads;
  }

  public get pendingCount() {
    let count = 0;
    for (const task of this.pending) {
      if (!task.started && !task.settled && !task.cancelled) count += 1;
    }
    return count;
  }

  private drain() {
    while (this.activeLoads < this.maxConcurrent && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task || task.cancelled || task.settled) continue;
      task.started = true;
      this.activeLoads += 1;
      try {
        task.start();
      } catch (error) {
        task.settled = true;
        this.activeLoads = Math.max(0, this.activeLoads - 1);
        this.drain();
        throw error;
      }
    }
  }
}
