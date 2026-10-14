export type AuthSessionState =
  | 'UNAUTHENTICATED'
  | 'RESTORING'
  | 'VALIDATING'
  | 'AUTHENTICATING'
  | 'QUICK_CONNECT_WAITING'
  | 'AUTHENTICATED'
  | 'CONNECTIVITY_ERROR'
  | 'STORAGE_ERROR'
  | 'AUTH_REJECTED'
  | 'LOGGING_OUT';

export type AuthOperationKind = 'restore' | 'password' | 'quick-connect' | 'logout';

export type AuthFailureState = 'CONNECTIVITY_ERROR' | 'STORAGE_ERROR' | 'AUTH_REJECTED';

declare const authOperationLeaseBrand: unique symbol;
declare const authenticatedSessionTicketBrand: unique symbol;

/**
 * A lease identifies one coordinator-owned operation. Consumers must check
 * `isCurrent()` after each asynchronous boundary before committing effects.
 */
export interface AuthOperationLease {
  readonly generation: number;
  readonly kind: AuthOperationKind;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly [authOperationLeaseBrand]: true;
}

/**
 * An opaque, per-commit credential identity. Runtime identity, rather than the
 * credential value, separates two logins that happen to receive the same token.
 */
export interface AuthenticatedSessionTicket {
  readonly credentialEpoch: number;
  readonly [authenticatedSessionTicketBrand]: true;
}

export interface AuthenticatedRequestContext {
  readonly ticket: AuthenticatedSessionTicket;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface AuthSessionSnapshot {
  readonly state: AuthSessionState;
  readonly generation: number;
  readonly activeOperation: AuthOperationKind | null;
  readonly authenticated: boolean;
  readonly credentialEpoch: number | null;
  readonly lastFailure: AuthFailureState | null;
}

export interface CurrentSessionRejection {
  readonly reason: 'runtime-401';
  readonly credentialEpoch: number;
}

export type CurrentSessionRejectionHandler = (
  rejection: CurrentSessionRejection
) => void | Promise<void>;

export interface AuthSessionCoordinatorOptions {
  onCurrentSessionRejected?: CurrentSessionRejectionHandler;
}

interface ActiveOperation {
  readonly lease: AuthOperationLease;
  readonly controller: AbortController;
}

interface AuthenticatedBinding {
  readonly ticket: AuthenticatedSessionTicket;
  readonly controller: AbortController;
}

function abort(controller: AbortController) {
  if (!controller.signal.aborted) {
    controller.abort();
  }
}

/**
 * Owns authentication lifecycle authority without knowing how credentials are
 * transported or persisted. In particular, it never accepts or stores a token.
 */
export class AuthSessionCoordinator {
  private readonly listeners = new Set<(snapshot: AuthSessionSnapshot) => void>();
  private activeOperation: ActiveOperation | null = null;
  private authenticatedBinding: AuthenticatedBinding | null = null;
  private rejectionHandler: CurrentSessionRejectionHandler | null;
  private rejectedTicket: AuthenticatedSessionTicket | null = null;
  private rejectedTicketPromise: Promise<boolean> | null = null;
  private operationGeneration = 0;
  private credentialEpoch = 0;
  private snapshot: AuthSessionSnapshot = {
    state: 'UNAUTHENTICATED',
    generation: 0,
    activeOperation: null,
    authenticated: false,
    credentialEpoch: null,
    lastFailure: null
  };

  public constructor(options: AuthSessionCoordinatorOptions = {}) {
    this.rejectionHandler = options.onCurrentSessionRejected ?? null;
  }

  public setCurrentSessionRejectionHandler(handler: CurrentSessionRejectionHandler | null) {
    this.rejectionHandler = handler;
  }

  public getSnapshot(): AuthSessionSnapshot {
    return { ...this.snapshot };
  }

  public subscribe(listener: (snapshot: AuthSessionSnapshot) => void) {
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      // A subscriber cannot interrupt authentication ownership.
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  public beginRestore(): AuthOperationLease {
    return this.beginOperation('restore', 'RESTORING');
  }

  public markValidating(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease)) return false;
    this.transition('VALIDATING');
    return true;
  }

  public beginPasswordAuthentication(): AuthOperationLease {
    return this.beginOperation('password', 'AUTHENTICATING');
  }

  public beginQuickConnect(): AuthOperationLease {
    return this.beginOperation('quick-connect', 'QUICK_CONNECT_WAITING');
  }

  public markAuthenticating(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease) || lease.kind !== 'quick-connect') return false;
    this.transition('AUTHENTICATING');
    return true;
  }

  /**
   * Binds a new authenticated epoch. Call only after protected persistence and
   * its readback verification have both succeeded.
   */
  public commitAuthenticated(lease: AuthOperationLease): AuthenticatedSessionTicket | null {
    if (!this.isLeaseCurrent(lease) || lease.kind === 'logout') return null;

    this.activeOperation = null;
    this.invalidateAuthenticatedBinding();

    const ticket = Object.freeze({
      credentialEpoch: ++this.credentialEpoch
    }) as AuthenticatedSessionTicket;
    this.authenticatedBinding = {
      ticket,
      controller: new AbortController()
    };
    this.transition('AUTHENTICATED');
    return ticket;
  }

  /**
   * Captures the exact credential epoch for an authenticated request. The one
   * signal shared by that epoch is aborted on replacement, rejection, or logout.
   */
  public captureAuthenticatedRequest(): AuthenticatedRequestContext | null {
    const binding = this.authenticatedBinding;
    if (!binding || binding.controller.signal.aborted) return null;

    const context = Object.freeze({
      ticket: binding.ticket,
      signal: binding.controller.signal,
      isCurrent: () => this.isRequestContextCurrent(binding.ticket, binding.controller.signal)
    }) as AuthenticatedRequestContext;
    return context;
  }

  /**
   * Handles only a current authenticated epoch's HTTP 401. Invalidation and
   * cancellation happen synchronously; durable cleanup/routing is invoked once.
   */
  public handleRuntimeStatus(
    context: AuthenticatedRequestContext,
    status: number
  ): Promise<boolean> {
    if (status !== 401) return Promise.resolve(false);

    if (context.ticket === this.rejectedTicket && this.rejectedTicketPromise) {
      return this.rejectedTicketPromise;
    }

    if (!this.isRequestContextCurrent(context.ticket, context.signal)) {
      return Promise.resolve(false);
    }

    const ticket = context.ticket;
    this.abortActiveOperation();
    this.invalidateAuthenticatedBinding();
    this.transition('AUTH_REJECTED');

    this.rejectedTicket = ticket;
    let handlerResult: void | Promise<void>;
    try {
      handlerResult = this.rejectionHandler?.({
        reason: 'runtime-401',
        credentialEpoch: ticket.credentialEpoch
      });
    } catch {
      handlerResult = Promise.reject(new Error('Current-session rejection cleanup failed'));
    }

    const rejectionGeneration = this.operationGeneration;
    const promise = Promise.resolve(handlerResult).then(
      () => {
        if (
          this.rejectedTicket === ticket &&
          this.operationGeneration === rejectionGeneration &&
          !this.activeOperation &&
          !this.authenticatedBinding
        ) {
          this.rejectedTicket = null;
          this.rejectedTicketPromise = null;
          this.transition('UNAUTHENTICATED');
        }
        return true;
      },
      () => {
        if (
          this.rejectedTicket === ticket &&
          this.operationGeneration === rejectionGeneration &&
          !this.activeOperation &&
          !this.authenticatedBinding
        ) {
          this.transition('STORAGE_ERROR', 'STORAGE_ERROR');
        }
        return true;
      }
    );
    if (this.rejectedTicket === ticket) {
      this.rejectedTicketPromise = promise;
    }
    return promise;
  }

  /**
   * Logout is fail-closed: the current ticket and every earlier operation are
   * invalidated before asynchronous local cleanup or server revocation starts.
   */
  public beginLogout(): AuthOperationLease {
    return this.beginOperation('logout', 'LOGGING_OUT', true);
  }

  public completeLogout(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease) || lease.kind !== 'logout') return false;
    this.activeOperation = null;
    this.invalidateAuthenticatedBinding();
    this.transition('UNAUTHENTICATED');
    return true;
  }

  public completeUnauthenticated(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease) || lease.kind === 'logout') return false;
    this.finishOperation(lease, this.authenticatedBinding ? 'AUTHENTICATED' : 'UNAUTHENTICATED');
    return true;
  }

  public failConnectivity(lease: AuthOperationLease): boolean {
    return this.finishWithFailure(lease, 'CONNECTIVITY_ERROR');
  }

  public failStorage(lease: AuthOperationLease): boolean {
    if (lease.kind === 'logout') {
      if (!this.isLeaseCurrent(lease)) return false;
      this.finishOperation(lease, 'STORAGE_ERROR', 'STORAGE_ERROR');
      return true;
    }
    return this.finishWithFailure(lease, 'STORAGE_ERROR');
  }

  public rejectAuthentication(lease: AuthOperationLease): boolean {
    if (
      !this.isLeaseCurrent(lease) ||
      (lease.kind !== 'password' && lease.kind !== 'quick-connect')
    ) {
      return false;
    }
    this.finishOperation(
      lease,
      this.authenticatedBinding ? 'AUTHENTICATED' : 'UNAUTHENTICATED',
      'AUTH_REJECTED'
    );
    return true;
  }

  /**
   * Marks a restored credential as rejected while its durable removal is in
   * progress. The restore lease remains current until cleanup completes or fails.
   */
  public rejectRestoredCredential(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease) || lease.kind !== 'restore') return false;
    this.transition('AUTH_REJECTED', 'AUTH_REJECTED');
    return true;
  }

  public cancel(lease: AuthOperationLease): boolean {
    if (!this.isLeaseCurrent(lease)) return false;
    const operation = this.activeOperation;
    this.activeOperation = null;
    if (operation) abort(operation.controller);
    this.transition(this.authenticatedBinding ? 'AUTHENTICATED' : 'UNAUTHENTICATED');
    return true;
  }

  private beginOperation(
    kind: AuthOperationKind,
    state: AuthSessionState,
    invalidateAuthenticatedSession = false
  ): AuthOperationLease {
    this.abortActiveOperation();
    this.rejectedTicket = null;
    this.rejectedTicketPromise = null;
    if (invalidateAuthenticatedSession) {
      this.invalidateAuthenticatedBinding();
    }
    const generation = ++this.operationGeneration;
    const controller = new AbortController();
    let lease: AuthOperationLease;
    lease = Object.freeze({
      generation,
      kind,
      signal: controller.signal,
      isCurrent: () => this.activeOperation?.lease === lease && !controller.signal.aborted
    }) as AuthOperationLease;
    this.activeOperation = { lease, controller };
    this.transition(state);
    return lease;
  }

  private finishWithFailure(lease: AuthOperationLease, failure: AuthFailureState): boolean {
    if (!this.isLeaseCurrent(lease) || lease.kind === 'logout') return false;
    const state = this.authenticatedBinding ? 'AUTHENTICATED' : failure;
    this.finishOperation(lease, state, failure);
    return true;
  }

  private finishOperation(
    lease: AuthOperationLease,
    state: AuthSessionState,
    failure: AuthFailureState | null = null
  ) {
    const operation = this.activeOperation;
    if (!operation || operation.lease !== lease) return;
    this.activeOperation = null;
    abort(operation.controller);
    this.transition(state, failure);
  }

  private abortActiveOperation() {
    const operation = this.activeOperation;
    if (!operation) return;
    this.activeOperation = null;
    abort(operation.controller);
  }

  private invalidateAuthenticatedBinding() {
    const binding = this.authenticatedBinding;
    this.authenticatedBinding = null;
    if (binding) abort(binding.controller);
  }

  private isLeaseCurrent(lease: AuthOperationLease) {
    return this.activeOperation?.lease === lease && !lease.signal.aborted;
  }

  private isRequestContextCurrent(ticket: AuthenticatedSessionTicket, signal: AbortSignal) {
    const binding = this.authenticatedBinding;
    return Boolean(
      binding &&
      binding.ticket === ticket &&
      binding.controller.signal === signal &&
      !signal.aborted
    );
  }

  private transition(state: AuthSessionState, failure: AuthFailureState | null = null) {
    this.snapshot = {
      state,
      generation: this.operationGeneration,
      activeOperation: this.activeOperation?.lease.kind ?? null,
      authenticated: Boolean(this.authenticatedBinding),
      credentialEpoch: this.authenticatedBinding?.ticket.credentialEpoch ?? null,
      lastFailure: failure
    };
    this.emitSnapshot();
  }

  private emitSnapshot() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber cannot interrupt authentication ownership.
      }
    }
  }
}
