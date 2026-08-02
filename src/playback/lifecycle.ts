export class PlaybackLifecycle {
  private stopOwner: (() => Promise<void> | void) | null = null;

  public registerStopOwner(owner: () => Promise<void> | void) {
    this.stopOwner = owner;
    return () => {
      if (this.stopOwner === owner) this.stopOwner = null;
    };
  }

  public async stop() {
    await this.stopOwner?.();
  }
}
