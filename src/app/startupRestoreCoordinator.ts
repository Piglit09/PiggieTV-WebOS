export interface StartupRestoreContext {
  signal: AbortSignal;
  generation: number;
  isCurrent: () => boolean;
}

export interface StartupRestoreLease {
  signal: AbortSignal;
  generation: number;
  promise: Promise<void>;
  isCurrent: () => boolean;
  release: () => void;
}

interface StartupRestoreFlight {
  key: string;
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
  owners: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

type StartupRestoreTask = (context: StartupRestoreContext) => Promise<void> | void;

/**
 * Keeps startup session restoration single-flight while React StrictMode briefly
 * releases and reacquires effects. A real unmount still aborts the request on the
 * next task, and an explicit retry immediately supersedes the previous generation.
 */
export class StartupRestoreCoordinator {
  private current: StartupRestoreFlight | null = null;
  private nextGeneration = 0;

  public constructor(private readonly releaseDelayMs = 0) {}

  public acquire(key: string, task: StartupRestoreTask): StartupRestoreLease {
    let flight = this.current;
    if (!flight || flight.key !== key) {
      if (flight) {
        this.abortFlight(flight, 'startup-superseded');
      }

      const controller = new AbortController();
      flight = {
        key,
        generation: ++this.nextGeneration,
        controller,
        promise: Promise.resolve(),
        owners: 0,
        releaseTimer: null
      };
      this.current = flight;

      const createdFlight = flight;
      createdFlight.promise = Promise.resolve().then(() => task({
        signal: createdFlight.controller.signal,
        generation: createdFlight.generation,
        isCurrent: () => this.isCurrent(createdFlight)
      }));
    }

    if (flight.releaseTimer !== null) {
      clearTimeout(flight.releaseTimer);
      flight.releaseTimer = null;
    }
    flight.owners += 1;

    const acquiredFlight = flight;
    let released = false;
    return {
      signal: acquiredFlight.controller.signal,
      generation: acquiredFlight.generation,
      promise: acquiredFlight.promise,
      isCurrent: () => this.isCurrent(acquiredFlight),
      release: () => {
        if (released) return;
        released = true;
        this.release(acquiredFlight);
      }
    };
  }

  private isCurrent(flight: StartupRestoreFlight) {
    return this.current === flight && !flight.controller.signal.aborted;
  }

  private release(flight: StartupRestoreFlight) {
    flight.owners = Math.max(0, flight.owners - 1);
    if (flight.owners > 0 || flight.releaseTimer !== null || this.current !== flight) return;

    flight.releaseTimer = setTimeout(() => {
      flight.releaseTimer = null;
      if (flight.owners > 0 || this.current !== flight) return;
      this.abortFlight(flight, 'startup-unmounted');
      if (this.current === flight) {
        this.current = null;
      }
    }, this.releaseDelayMs);
  }

  private abortFlight(flight: StartupRestoreFlight, reason: string) {
    if (flight.releaseTimer !== null) {
      clearTimeout(flight.releaseTimer);
      flight.releaseTimer = null;
    }
    if (!flight.controller.signal.aborted) {
      flight.controller.abort(reason);
    }
    if (this.current === flight) {
      this.current = null;
    }
  }
}
