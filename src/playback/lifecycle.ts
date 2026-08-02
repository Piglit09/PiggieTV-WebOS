import type { PlaybackStopReason } from './engine';

export class PlaybackLifecycle {
  private stopOwner: ((reason: PlaybackStopReason) => Promise<void> | void) | null = null;

  public registerStopOwner(owner: (reason: PlaybackStopReason) => Promise<void> | void) {
    this.stopOwner = owner;
    return () => {
      if (this.stopOwner === owner) this.stopOwner = null;
    };
  }

  public async stop(reason: PlaybackStopReason = 'user') {
    await this.stopOwner?.(reason);
  }
}
