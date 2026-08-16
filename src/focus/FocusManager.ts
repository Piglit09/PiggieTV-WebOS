import type { PtvFocusDirection } from '../types/ptv';

export interface FocusNodeRegistration {
  id: string;
  group?: string;
  preferredRow?: string;
  routeId?: string;
  ref: HTMLElement;
  activate?: () => boolean | void;
}

export type FocusTransitionReason =
  | 'register'
  | 'direct'
  | 'dom-focus'
  | 'pointer'
  | 'directional'
  | 'directional-fallback'
  | 'directional-boundary'
  | 'history-restore'
  | 'route-change'
  | 'route-restore'
  | 'route-fallback'
  | 'unregister-fallback'
  | 'pending-focus-fallback'
  | 'missing-focus-fallback'
  | 'activate';

export interface FocusMoveMetadata {
  inputKey?: string | null;
  reason?: FocusTransitionReason;
  routeId?: string | null;
}

interface InternalFocusMetadata extends FocusMoveMetadata {
  direction?: PtvFocusDirection | null;
  fallbackUsed?: boolean;
  remember?: boolean;
}

export interface FocusTransition {
  timestamp: number;
  routeId: string | null;
  previousRouteId: string | null;
  previousFocusId: string | null;
  nextFocusId: string | null;
  inputKey: string | null;
  reason: FocusTransitionReason;
  direction: PtvFocusDirection | null;
  fallbackUsed: boolean;
}

export type FocusReconciliationEventType =
  | 'directional-target-calculated'
  | 'focus-requested'
  | 'native-focus-applied'
  | 'native-focus-failed'
  | 'dom-focus-accepted'
  | 'dom-focus-reconciled'
  | 'register'
  | 'unregister'
  | 'pending-focus-created'
  | 'pending-focus-restored'
  | 'pending-focus-failed'
  | 'fallback-applied'
  | 'reconciliation-violation'
  | 'render-window-commit';

export interface FocusReconciliationEvent {
  timestamp: number;
  type: FocusReconciliationEventType;
  routeId: string | null;
  focusId: string | null;
  requestedFocusId: string | null;
  registeredFocusId: string | null;
  unregisteredFocusId: string | null;
  logicalFocusId: string | null;
  nativeFocusId: string | null;
  pendingFocusId: string | null;
  inputKey: string | null;
  reason: FocusTransitionReason | string | null;
  direction: PtvFocusDirection | null;
  targetMounted: boolean;
  interactionMode: FocusInteractionMode;
  pendingToken: number | null;
  fallbackReason: string | null;
  nativeFocusApplied: boolean | null;
  reconciliationViolation: boolean;
  renderWindowStart: number | null;
}

interface FocusReconciliationMetadata {
  direction?: PtvFocusDirection | null;
  fallbackReason?: string | null;
  focusId?: string | null;
  inputKey?: string | null;
  nativeFocusApplied?: boolean | null;
  pendingFocusId?: string | null;
  pendingToken?: number | null;
  reason?: FocusTransitionReason | string | null;
  reconciliationViolation?: boolean;
  registeredFocusId?: string | null;
  renderWindowStart?: number | null;
  requestedFocusId?: string | null;
  routeId?: string | null;
  targetMounted?: boolean;
  unregisteredFocusId?: string | null;
}

export interface FocusNavigationResult {
  current: string | null;
  nativeFocusApplied?: boolean;
  previous: string | null;
  transition?: FocusTransition;
}

export type FocusInteractionMode = 'remote' | 'pointer';

export interface FocusInteractionState {
  mode: FocusInteractionMode;
  lastPointerX: number | null;
  lastPointerY: number | null;
  lastPointerMotionTimestamp: number | null;
  pointerBaselinePending: boolean;
}

export interface FocusRouteOptions {
  restore?: boolean;
  fallbackFocusId?: string | null;
  focusFirstIfUnremembered?: boolean;
  inputKey?: string | null;
}

interface PendingRouteRestore {
  routeId: string;
  targetId: string | null;
  fallbackFocusId: string | null;
}

interface DirectionalFocusReservation {
  direction: PtvFocusDirection;
  inputKey: string | null;
  routeId: string | null;
  settled: boolean;
  targetId: string;
}

interface PendingDirectionalFocus extends DirectionalFocusReservation {
  token: number;
}

const MIN_DELTA_PX = 12;
const MAX_ROUTE_MEMORY = 24;

function rectDistance(a: DOMRect, b: DOMRect, direction: PtvFocusDirection) {
  if (direction === 'left' || direction === 'right') {
    if (direction === 'left' && b.right <= a.left + MIN_DELTA_PX) {
      const x = a.left - b.right;
      const y = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
      return x + y / 2;
    }
    if (direction === 'right' && b.left >= a.right - MIN_DELTA_PX) {
      const x = b.left - a.right;
      const y = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
      return x + y / 2;
    }
  } else {
    if (direction === 'up' && b.bottom <= a.top + MIN_DELTA_PX) {
      const y = a.top - b.bottom;
      const x = Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
      return y + x / 2;
    }
    if (direction === 'down' && b.top >= a.bottom - MIN_DELTA_PX) {
      const y = b.top - a.bottom;
      const x = Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
      return y + x / 2;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function normalizeRouteId(routeId?: string | null) {
  const normalized = routeId?.trim();
  return normalized ? normalized : null;
}

export class FocusManager {
  private nodes = new Map<string, FocusNodeRegistration>();
  private focusOrder: string[] = [];
  private currentFocus: string | null = null;
  private interactionModeValue: FocusInteractionMode = 'remote';
  private lastPointerX: number | null = null;
  private lastPointerY: number | null = null;
  private lastPointerMotionTimestamp: number | null = null;
  private pointerBaselinePending = true;
  private listeners = new Set<(current: string | null, previous: string | null) => void>();
  private transitionListeners = new Set<(transition: FocusTransition) => void>();
  private reconciliationListeners = new Set<(event: FocusReconciliationEvent) => void>();
  private lastInteractive: string | null = null;
  private lastFocusTransition: FocusTransition | null = null;
  private activeRouteId: string | null = null;
  private pendingRouteRestore: PendingRouteRestore | null = null;
  private directionalReservation: DirectionalFocusReservation | null = null;
  private pendingDirectionalFocus: PendingDirectionalFocus | null = null;
  private nextPendingFocusToken = 1;
  private currentRenderWindowStart: number | null = null;
  private routeFocusMemory = new Map<string, string>();
  private readonly maxHistory = 18;
  private lastPreviousFocusId: string | null = null;

  public register(node: FocusNodeRegistration): () => void {
    node.ref.tabIndex = -1;

    const isReplace = this.nodes.has(node.id);
    if (isReplace) {
      this.nodes.delete(node.id);
      this.focusOrder = this.focusOrder.filter(candidate => candidate !== node.id);
    }
    this.nodes.set(node.id, node);

    this.publishReconciliationEvent('register', {
      focusId: node.id,
      registeredFocusId: node.id,
      routeId: node.routeId,
      targetMounted: node.ref.isConnected
    });

    const restoredPendingDirectional = this.tryPendingDirectionalFocus(node);

    const restoredPendingRoute = !restoredPendingDirectional && this.tryPendingRouteRestore(node);
    if (
      !restoredPendingDirectional
      && !restoredPendingRoute
      && !this.currentFocus
      && this.isInActiveRoute(node)
      && !this.isWaitingForAnotherNode(node)
    ) {
      this.applyFocus(node.id, { reason: 'register', routeId: node.routeId });
    } else if (!restoredPendingDirectional && !restoredPendingRoute && this.currentFocus === node.id) {
      this.pushHistory(node.id);
      this.focusNodeIfAllowed(node.id, {
        focusId: node.id,
        reason: 'register',
        routeId: node.routeId
      });
      this.notify(this.currentFocus);
    }

    return () => {
      this.unregister(node.id, node.ref);
    };
  }

  public unregister(id: string, expectedRef?: HTMLElement) {
    const registeredNode = this.nodes.get(id);
    if (!registeredNode || (expectedRef && registeredNode.ref !== expectedRef)) {
      return;
    }

    this.nodes.delete(id);
    this.focusOrder = this.focusOrder.filter(candidate => candidate !== id);
    this.publishReconciliationEvent('unregister', {
      focusId: id,
      routeId: registeredNode.routeId,
      targetMounted: false,
      unregisteredFocusId: id
    });

    if (this.currentFocus !== id) {
      if (this.pendingDirectionalFocus?.targetId === this.currentFocus) {
        this.notify();
        return;
      }
      if (this.currentFocus && !this.nodes.has(this.currentFocus)) {
        this.moveToFallback(this.currentFocus);
      } else {
        this.notify();
      }
      return;
    }

    const previous = this.currentFocus;
    const previousRouteId = registeredNode.routeId ?? this.activeRouteId;

    if (this.directionalReservation?.targetId === id && !this.directionalReservation.settled) {
      const token = this.nextPendingFocusToken;
      this.nextPendingFocusToken += 1;
      this.pendingDirectionalFocus = {
        ...this.directionalReservation,
        token
      };
      this.publishReconciliationEvent('pending-focus-created', {
        direction: this.directionalReservation.direction,
        focusId: id,
        inputKey: this.directionalReservation.inputKey,
        pendingFocusId: id,
        pendingToken: token,
        reason: 'directional',
        routeId: this.directionalReservation.routeId,
        targetMounted: false
      });
      this.notify(previous);
      return { current: previous, previous };
    }

    this.currentFocus = null;
    const fallback = this.findValidFallbackId(previous, this.activeRouteId);
    if (fallback) {
      this.publishReconciliationEvent('fallback-applied', {
        fallbackReason: 'focused-node-unregistered-without-directional-reservation',
        focusId: fallback,
        reason: 'unregister-fallback',
        requestedFocusId: previous,
        routeId: this.activeRouteId,
        targetMounted: true
      });
      this.applyFocus(fallback, {
        reason: 'unregister-fallback',
        routeId: this.activeRouteId,
        fallbackUsed: true,
        remember: false
      }, previous, previousRouteId ?? null);
      return;
    }

    const transition = this.publishTransition(previous, null, {
      reason: 'unregister-fallback',
      routeId: this.activeRouteId,
      fallbackUsed: false
    }, previousRouteId ?? null);
    this.notify(previous);
    return { current: null, previous, transition };
  }

  public recordPointerMovement(clientX: number, clientY: number, timestamp = Date.now()) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

    const moved = this.lastPointerX === null
      || this.lastPointerY === null
      || this.lastPointerX !== clientX
      || this.lastPointerY !== clientY;
    this.lastPointerX = clientX;
    this.lastPointerY = clientY;
    if (!moved) return false;

    this.lastPointerMotionTimestamp = timestamp;
    if (this.pointerBaselinePending) {
      // webOS/Chromium can emit one coordinate-changing mousemove when a
      // runner-owned window is activated or content shifts under the OS
      // cursor. Re-baseline that first sample after DPAD; a subsequent
      // coordinate change is required to prove ongoing pointer intent.
      this.pointerBaselinePending = false;
      return false;
    }
    this.interactionModeValue = 'pointer';
    return true;
  }

  public claimPointerInteraction() {
    this.clearDirectionalFocusState();
    this.pointerBaselinePending = false;
    this.interactionModeValue = 'pointer';
  }

  public claimRemoteInteraction() {
    const wasPointer = this.interactionModeValue === 'pointer';
    this.interactionModeValue = 'remote';
    this.pointerBaselinePending = true;
    if (wasPointer && this.currentFocus) {
      this.focusNodeIfAllowed(this.currentFocus);
    }
  }

  public focusFromPointer(id: string, metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    if (this.interactionModeValue !== 'pointer') {
      return { current: this.currentFocus, previous: this.currentFocus };
    }
    return this.focus(id, { ...metadata, reason: metadata.reason ?? 'pointer' });
  }

  public subscribe(listener: (current: string | null, previous: string | null) => void) {
    this.listeners.add(listener);
    listener(this.currentFocus, this.previousFocusId);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeTransitions(listener: (transition: FocusTransition) => void) {
    this.transitionListeners.add(listener);
    return () => {
      this.transitionListeners.delete(listener);
    };
  }

  public subscribeReconciliationEvents(listener: (event: FocusReconciliationEvent) => void) {
    this.reconciliationListeners.add(listener);
    return () => {
      this.reconciliationListeners.delete(listener);
    };
  }

  public clearListeners() {
    this.listeners.clear();
    this.transitionListeners.clear();
    this.reconciliationListeners.clear();
  }

  public get focusId() {
    return this.currentFocus || null;
  }

  public get interactionMode() {
    return this.interactionModeValue;
  }

  public get interactionState(): FocusInteractionState {
    return {
      mode: this.interactionModeValue,
      lastPointerX: this.lastPointerX,
      lastPointerY: this.lastPointerY,
      lastPointerMotionTimestamp: this.lastPointerMotionTimestamp,
      pointerBaselinePending: this.pointerBaselinePending
    };
  }

  public get previousFocusId() {
    if (this.focusOrder.length >= 2) {
      return this.focusOrder[this.focusOrder.length - 2] ?? null;
    }
    return this.lastPreviousFocusId;
  }

  public get activeRoute() {
    return this.activeRouteId;
  }

  public get lastTransition() {
    return this.lastFocusTransition ? { ...this.lastFocusTransition } : null;
  }

  public get pendingFocusId() {
    return this.pendingDirectionalFocus?.targetId ?? null;
  }

  public clearFocusHistory() {
    this.focusOrder.length = 0;
    this.lastInteractive = this.currentFocus;
  }

  public setActiveRoute(routeId: string | null, options: FocusRouteOptions = {}): FocusNavigationResult {
    const normalizedRouteId = normalizeRouteId(routeId);
    const previous = this.currentFocus;
    const previousNode = previous ? this.nodes.get(previous) : undefined;
    // Shell controls can re-register with the next route before this effect runs.
    // The manager's active route is therefore the authoritative previous route;
    // using the node's freshly updated route would poison the new route's memory.
    const previousRouteId = this.activeRouteId ?? previousNode?.routeId;

    // During a route render, persistent shell controls can re-register for the
    // destination before this effect runs. Do not let that destination node
    // replace the source route's remembered content focus.
    const previousBelongsToPreviousRoute = !previousNode?.routeId
      || previousNode.routeId === previousRouteId;
    if (previous && previousRouteId && previousBelongsToPreviousRoute) {
      this.rememberRouteFocus(previousRouteId, previous);
    }

    this.activeRouteId = normalizedRouteId;
    this.pendingRouteRestore = null;
    this.clearDirectionalFocusState();
    this.currentRenderWindowStart = null;

    if (!normalizedRouteId) {
      const transition = this.publishTransition(previous, this.currentFocus, {
        reason: 'route-change',
        routeId: null,
        inputKey: options.inputKey
      }, previousRouteId ?? null);
      return { current: this.currentFocus, previous, transition };
    }

    const restore = options.restore !== false;
    const rememberedTarget = restore ? this.routeFocusMemory.get(normalizedRouteId) ?? null : null;
    const fallbackFocusId = options.fallbackFocusId ?? null;
    const currentNode = this.currentFocus ? this.nodes.get(this.currentFocus) : undefined;

    if (!currentNode || !this.isInteractive(currentNode) || !this.nodeMatchesRoute(currentNode, normalizedRouteId)) {
      this.currentFocus = null;
    }

    if (rememberedTarget && this.canFocusForRoute(rememberedTarget, normalizedRouteId)) {
      return this.applyFocus(rememberedTarget, {
        reason: 'route-restore',
        routeId: normalizedRouteId,
        inputKey: options.inputKey,
        fallbackUsed: false
      }, previous, previousRouteId ?? null);
    }

    if (rememberedTarget || fallbackFocusId) {
      this.pendingRouteRestore = {
        routeId: normalizedRouteId,
        targetId: rememberedTarget,
        fallbackFocusId
      };
    }

    if (!rememberedTarget && fallbackFocusId && this.canFocusForRoute(fallbackFocusId, normalizedRouteId)) {
      this.pendingRouteRestore = null;
      return this.applyFocus(fallbackFocusId, {
        reason: 'route-fallback',
        routeId: normalizedRouteId,
        inputKey: options.inputKey,
        fallbackUsed: true
      }, previous, previousRouteId ?? null);
    }

    if (!rememberedTarget && options.focusFirstIfUnremembered !== false) {
      const first = this.findValidFallbackId(undefined, normalizedRouteId);
      if (first) {
        this.pendingRouteRestore = null;
        return this.applyFocus(first, {
          reason: 'route-fallback',
          routeId: normalizedRouteId,
          inputKey: options.inputKey,
          fallbackUsed: true
        }, previous, previousRouteId ?? null);
      }
    }

    const transition = this.publishTransition(previous, this.currentFocus, {
      reason: 'route-change',
      routeId: normalizedRouteId,
      inputKey: options.inputKey,
      fallbackUsed: false
    }, previousRouteId ?? null);
    this.notify(previous);
    return { current: this.currentFocus, previous, transition };
  }

  public restoreRouteFocus(routeId: string, fallbackFocusId?: string | null): FocusNavigationResult {
    const normalizedRouteId = normalizeRouteId(routeId);
    const previous = this.currentFocus;
    if (!normalizedRouteId) {
      return { current: this.currentFocus, previous };
    }

    if (this.activeRouteId !== normalizedRouteId) {
      return this.setActiveRoute(normalizedRouteId, { fallbackFocusId });
    }

    const rememberedTarget = this.routeFocusMemory.get(normalizedRouteId) ?? null;
    if (rememberedTarget && this.canFocusForRoute(rememberedTarget, normalizedRouteId)) {
      this.pendingRouteRestore = null;
      return this.applyFocus(rememberedTarget, {
        reason: 'route-restore',
        routeId: normalizedRouteId,
        fallbackUsed: false
      });
    }

    const fallback = fallbackFocusId && this.canFocusForRoute(fallbackFocusId, normalizedRouteId)
      ? fallbackFocusId
      : this.findValidFallbackId(undefined, normalizedRouteId);
    if (fallback) {
      this.pendingRouteRestore = null;
      return this.applyFocus(fallback, {
        reason: 'route-fallback',
        routeId: normalizedRouteId,
        fallbackUsed: true
      });
    }

    this.pendingRouteRestore = {
      routeId: normalizedRouteId,
      targetId: rememberedTarget,
      fallbackFocusId: fallbackFocusId ?? null
    };
    return { current: this.currentFocus, previous };
  }

  public rememberRouteFocus(routeId: string, focusId: string | null = this.currentFocus) {
    const normalizedRouteId = normalizeRouteId(routeId);
    if (!normalizedRouteId || !focusId) return;
    this.routeFocusMemory.delete(normalizedRouteId);
    this.routeFocusMemory.set(normalizedRouteId, focusId);
    while (this.routeFocusMemory.size > MAX_ROUTE_MEMORY) {
      const oldestRoute = this.routeFocusMemory.keys().next().value as string | undefined;
      if (!oldestRoute) break;
      this.routeFocusMemory.delete(oldestRoute);
    }
  }

  public getRememberedRouteFocus(routeId: string) {
    const normalizedRouteId = normalizeRouteId(routeId);
    return normalizedRouteId ? this.routeFocusMemory.get(normalizedRouteId) ?? null : null;
  }

  public clearRouteFocus(routeId?: string | null) {
    const normalizedRouteId = normalizeRouteId(routeId);
    if (normalizedRouteId) {
      this.routeFocusMemory.delete(normalizedRouteId);
      if (this.pendingRouteRestore?.routeId === normalizedRouteId) {
        this.pendingRouteRestore = null;
      }
      return;
    }
    this.routeFocusMemory.clear();
    this.pendingRouteRestore = null;
  }

  public focus(id: string, metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    if (metadata.reason === 'dom-focus') {
      return this.handleDomFocus(id, metadata);
    }
    const node = this.nodes.get(id);
    if (!node || !this.isInteractive(node) || !this.isInActiveRoute(node)) {
      return { current: this.currentFocus, previous: this.currentFocus };
    }
    if (metadata.reason !== 'directional') {
      this.clearDirectionalFocusState();
    }
    return this.applyFocus(id, { reason: metadata.reason ?? 'direct', ...metadata });
  }

  public handleDomFocus(id: string, metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    const previous = this.currentFocus;
    const node = this.nodes.get(id);
    if (!node || !this.isInteractive(node) || !this.isInActiveRoute(node)) {
      this.publishReconciliationEvent('reconciliation-violation', {
        focusId: id,
        reason: metadata.reason ?? 'dom-focus',
        reconciliationViolation: true,
        requestedFocusId: id,
        routeId: metadata.routeId,
        targetMounted: Boolean(node?.ref.isConnected)
      });
      return { current: previous, previous };
    }

    if (id === previous) {
      this.publishReconciliationEvent('dom-focus-accepted', {
        focusId: id,
        reason: metadata.reason ?? 'dom-focus',
        requestedFocusId: id,
        routeId: metadata.routeId ?? node.routeId,
        targetMounted: true
      });
      return { current: previous, previous };
    }

    const reservation = this.directionalReservation ?? this.pendingDirectionalFocus;
    const authoritativeId = reservation?.targetId ?? null;
    const authoritativeNode = authoritativeId ? this.nodes.get(authoritativeId) : undefined;
    const isPendingAuthoritativeHandoff = Boolean(
      this.pendingDirectionalFocus
      && authoritativeId
      && authoritativeId === previous
    );
    const canRestoreAuthoritative = Boolean(
      authoritativeNode
      && this.isInteractive(authoritativeNode)
      && this.isInActiveRoute(authoritativeNode)
    );
    if (
      this.interactionModeValue === 'remote'
      && authoritativeId
      && authoritativeId === previous
      && authoritativeId !== id
      && (canRestoreAuthoritative || isPendingAuthoritativeHandoff)
    ) {
      this.publishReconciliationEvent('reconciliation-violation', {
        direction: reservation?.direction,
        focusId: id,
        inputKey: reservation?.inputKey,
        reason: metadata.reason ?? 'dom-focus',
        reconciliationViolation: true,
        requestedFocusId: authoritativeId,
        routeId: reservation?.routeId ?? metadata.routeId,
        targetMounted: canRestoreAuthoritative
      });
      if (isPendingAuthoritativeHandoff && node.ref.ownerDocument.activeElement === node.ref) {
        node.ref.blur();
      }
      const restored = canRestoreAuthoritative
        ? this.focusNodeIfAllowed(authoritativeId, {
          direction: reservation?.direction,
          focusId: authoritativeId,
          inputKey: reservation?.inputKey,
          pendingFocusId: this.pendingDirectionalFocus?.targetId,
          pendingToken: this.pendingDirectionalFocus?.token,
          reason: 'directional',
          requestedFocusId: authoritativeId,
          routeId: reservation?.routeId ?? metadata.routeId
        })
        : false;
      this.publishReconciliationEvent('dom-focus-reconciled', {
        direction: reservation?.direction,
        focusId: authoritativeId,
        inputKey: reservation?.inputKey,
        nativeFocusApplied: restored,
        pendingFocusId: this.pendingDirectionalFocus?.targetId,
        pendingToken: this.pendingDirectionalFocus?.token,
        reason: 'directional',
        reconciliationViolation: canRestoreAuthoritative && !restored,
        requestedFocusId: authoritativeId,
        routeId: reservation?.routeId ?? metadata.routeId,
        targetMounted: canRestoreAuthoritative
      });
      return { current: this.currentFocus, previous: this.currentFocus };
    }

    this.clearDirectionalFocusState();
    this.publishReconciliationEvent('dom-focus-accepted', {
      focusId: id,
      reason: metadata.reason ?? 'dom-focus',
      requestedFocusId: id,
      routeId: metadata.routeId ?? node.routeId,
      targetMounted: true
    });
    return this.applyFocus(id, { reason: 'dom-focus', ...metadata });
  }

  public failPendingDirectionalFocus(
    reason: string,
    fallbackFocusId?: string | null
  ): FocusNavigationResult {
    const pending = this.pendingDirectionalFocus;
    const previous = this.currentFocus;
    if (!pending) return { current: previous, previous };

    this.publishReconciliationEvent('pending-focus-failed', {
      direction: pending.direction,
      fallbackReason: reason,
      focusId: pending.targetId,
      inputKey: pending.inputKey,
      pendingFocusId: pending.targetId,
      pendingToken: pending.token,
      reason: 'pending-focus-fallback',
      requestedFocusId: pending.targetId,
      routeId: pending.routeId,
      targetMounted: false
    });
    this.clearDirectionalFocusState();
    const fallback = fallbackFocusId && this.canFocusForRoute(fallbackFocusId, pending.routeId ?? '')
      ? fallbackFocusId
      : this.findValidFallbackId(previous, pending.routeId);
    if (!fallback) {
      this.currentFocus = null;
      const transition = this.publishTransition(previous, null, {
        reason: 'pending-focus-fallback',
        inputKey: pending.inputKey,
        routeId: pending.routeId,
        direction: pending.direction,
        fallbackUsed: false
      });
      this.notify(previous);
      return { current: null, previous, transition };
    }
    this.currentFocus = null;
    this.publishReconciliationEvent('fallback-applied', {
      direction: pending.direction,
      fallbackReason: reason,
      focusId: fallback,
      inputKey: pending.inputKey,
      reason: 'pending-focus-fallback',
      requestedFocusId: pending.targetId,
      routeId: pending.routeId,
      targetMounted: true
    });
    return this.applyFocus(fallback, {
      reason: 'pending-focus-fallback',
      inputKey: pending.inputKey,
      routeId: pending.routeId,
      direction: pending.direction,
      fallbackUsed: true,
      remember: false
    }, previous);
  }

  public reconcileCurrentFocus(
    reason = 'render-window-commit',
    renderWindowStart?: number | null
  ) {
    if (renderWindowStart !== undefined) {
      this.currentRenderWindowStart = renderWindowStart;
    }
    const focusId = this.currentFocus;
    const node = focusId ? this.nodes.get(focusId) : undefined;
    const mounted = Boolean(node && this.isInteractive(node));
    const nativeFocusId = this.readNativeFocusId();
    const agrees = Boolean(focusId && mounted && nativeFocusId === focusId);
    this.publishReconciliationEvent(
      agrees ? 'render-window-commit' : 'reconciliation-violation',
      {
        focusId,
        nativeFocusApplied: agrees,
        reason,
        reconciliationViolation: !agrees,
        renderWindowStart,
        requestedFocusId: focusId,
        routeId: node?.routeId ?? this.activeRouteId,
        targetMounted: mounted
      }
    );
    if (focusId && mounted && !agrees) {
      const restored = this.focusNodeIfAllowed(focusId, {
        focusId,
        reason,
        renderWindowStart,
        requestedFocusId: focusId,
        routeId: node?.routeId ?? this.activeRouteId
      });
      if (restored && this.directionalReservation?.targetId === focusId) {
        this.directionalReservation.settled = true;
      }
      return restored;
    }
    if (agrees && this.directionalReservation?.targetId === focusId) {
      this.directionalReservation.settled = true;
    }
    return agrees;
  }

  public activateCurrent(metadata: FocusMoveMetadata = {}) {
    if (metadata.reason === 'activate' || metadata.inputKey === 'Enter') {
      this.claimRemoteInteraction();
    }
    const currentFocus = this.currentFocus;
    if (!currentFocus) return false;
    const current = this.nodes.get(currentFocus);
    if (!current || !this.isInteractive(current) || !this.isInActiveRoute(current)) return false;

    let activated = false;
    if (current.activate) {
      activated = current.activate() !== false;
    } else if (typeof current.ref.click === 'function') {
      current.ref.click();
      activated = true;
    }

    if (activated) {
      this.publishTransition(currentFocus, currentFocus, {
        reason: metadata.reason ?? 'activate',
        routeId: metadata.routeId ?? current.routeId,
        inputKey: metadata.inputKey,
        fallbackUsed: false
      }, current.routeId ?? this.activeRouteId);
    }
    return activated;
  }

  public move(direction: PtvFocusDirection, metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    this.claimRemoteInteraction();
    const currentFocus = this.currentFocus;
    if (!currentFocus) return this.focusDirectionFallback(direction, metadata);
    const current = this.nodes.get(currentFocus);
    if (!current) return this.moveFromMissingFocus(direction, metadata);
    const bounds = current.ref.getBoundingClientRect();
    const routeId = current.routeId ?? this.activeRouteId;

    let bestId = '';
    let bestScore = Number.POSITIVE_INFINITY;

    const candidates = Array.from(this.nodes.values()).filter(candidate => (
      candidate.id !== this.currentFocus && this.isInteractive(candidate) && this.nodeMatchesRoute(candidate, routeId)
    ));
    for (const candidate of candidates) {
      const candidateBounds = candidate.ref.getBoundingClientRect();
      const score = rectDistance(bounds, candidateBounds, direction);
      if (Number.isFinite(score) && score < bestScore) {
        bestScore = score;
        bestId = candidate.id;
      }
    }

    if (!bestId) return this.focusDirectionFallback(direction, metadata);
    this.publishReconciliationEvent('directional-target-calculated', {
      direction,
      focusId: currentFocus,
      inputKey: metadata.inputKey,
      reason: metadata.reason ?? 'directional',
      requestedFocusId: bestId,
      routeId: metadata.routeId ?? routeId,
      targetMounted: Boolean(this.nodes.get(bestId)?.ref.isConnected)
    });
    this.directionalReservation = {
      direction,
      inputKey: metadata.inputKey ?? null,
      routeId: normalizeRouteId(metadata.routeId) ?? normalizeRouteId(routeId),
      settled: false,
      targetId: bestId
    };
    this.pendingDirectionalFocus = null;
    return this.applyFocus(bestId, {
      reason: metadata.reason ?? 'directional',
      inputKey: metadata.inputKey,
      routeId: metadata.routeId ?? routeId,
      direction,
      fallbackUsed: false
    });
  }

  public restorePrevious(metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    this.clearDirectionalFocusState();
    if (!this.currentFocus) {
      return { current: null, previous: null };
    }

    const previous = this.currentFocus;
    const currentIndex = this.focusOrder.lastIndexOf(previous);
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = this.focusOrder[index];
      if (!candidate) continue;
      const candidateNode = this.nodes.get(candidate);
      if (!candidateNode || !this.isInteractive(candidateNode) || !this.isInActiveRoute(candidateNode)) continue;
      this.focusOrder = this.focusOrder.slice(0, index + 1);
      return this.applyFocus(candidate, {
        reason: metadata.reason ?? 'history-restore',
        inputKey: metadata.inputKey,
        routeId: metadata.routeId ?? candidateNode.routeId,
        fallbackUsed: false
      });
    }

    const fallback = this.findValidFallbackId(previous, this.activeRouteId);
    if (!fallback) {
      return { current: previous, previous };
    }

    this.focusOrder = [];
    return this.applyFocus(fallback, {
      reason: metadata.reason ?? 'history-restore',
      inputKey: metadata.inputKey,
      routeId: metadata.routeId ?? this.activeRouteId,
      fallbackUsed: true
    });
  }

  public focusDirectionFallback(direction: PtvFocusDirection, metadata: FocusMoveMetadata = {}): FocusNavigationResult {
    this.clearDirectionalFocusState();
    const currentFocus = this.currentFocus;
    const currentNode = currentFocus ? this.nodes.get(currentFocus) : undefined;
    const routeId = currentNode?.routeId ?? this.activeRouteId;
    const rowFocused = currentNode?.preferredRow;
    const sameRow = rowFocused
      ? Array.from(this.nodes.values()).filter(candidate => (
        candidate.preferredRow === rowFocused && this.isInteractive(candidate) && this.nodeMatchesRoute(candidate, routeId)
      ))
      : [];

    if (currentFocus && sameRow.length) {
      const sameRowFocusedIndex = sameRow.findIndex(item => item.id === currentFocus);
      if (sameRowFocusedIndex >= 0) {
        const delta = direction === 'left' || direction === 'up' ? -1 : 1;
        const fallback = sameRow[sameRowFocusedIndex + delta];
        if (fallback) {
          return this.applyFocus(fallback.id, {
            reason: metadata.reason ?? 'directional-fallback',
            inputKey: metadata.inputKey,
            routeId: metadata.routeId ?? routeId,
            direction,
            fallbackUsed: true
          });
        }
      }
    }

    if (!currentFocus) {
      const first = this.findValidFallbackId(undefined, routeId);
      if (!first) return { current: null, previous: null };
      return this.applyFocus(first, {
        reason: metadata.reason ?? 'missing-focus-fallback',
        inputKey: metadata.inputKey,
        routeId: metadata.routeId ?? routeId,
        direction,
        fallbackUsed: true
      });
    }

    const transition = this.publishTransition(currentFocus, currentFocus, {
      reason: 'directional-boundary',
      inputKey: metadata.inputKey,
      routeId: metadata.routeId ?? routeId,
      direction,
      fallbackUsed: false
    }, currentNode?.routeId ?? this.activeRouteId);
    return { current: currentFocus, previous: currentFocus, transition };
  }

  public getReturnTarget(): string | null {
    const historyTarget = this.focusOrder.at(-2);
    return historyTarget ?? this.lastInteractive;
  }

  private applyFocus(
    id: string,
    metadata: InternalFocusMetadata,
    previousOverride?: string | null,
    previousRouteOverride?: string | null
  ): FocusNavigationResult {
    const node = this.nodes.get(id);
    if (!node || !this.isInteractive(node) || !this.isInActiveRoute(node)) {
      this.publishReconciliationEvent('reconciliation-violation', {
        direction: metadata.direction,
        focusId: id,
        inputKey: metadata.inputKey,
        reason: metadata.reason,
        reconciliationViolation: true,
        requestedFocusId: id,
        routeId: metadata.routeId,
        targetMounted: Boolean(node?.ref.isConnected)
      });
      return { current: this.currentFocus, previous: this.currentFocus };
    }

    const previous = previousOverride === undefined ? this.currentFocus : previousOverride;
    if (this.currentFocus === id && previous === id) {
      // The logical ID can survive while virtualization replaces its DOM
      // registration. Re-apply native focus to the currently registered node.
      const nativeFocusApplied = this.focusNodeIfAllowed(id, {
        direction: metadata.direction,
        focusId: id,
        inputKey: metadata.inputKey,
        pendingFocusId: this.pendingDirectionalFocus?.targetId,
        pendingToken: this.pendingDirectionalFocus?.token,
        reason: metadata.reason,
        requestedFocusId: id,
        routeId: metadata.routeId ?? node.routeId
      });
      this.notify(previous);
      return {
        current: this.currentFocus,
        nativeFocusApplied,
        previous: this.currentFocus
      };
    }

    const previousNode = previous ? this.nodes.get(previous) : undefined;
    if (previous) {
      this.lastPreviousFocusId = previous;
    }
    this.currentFocus = id;
    this.lastInteractive = id;
    this.pushHistory(id);
    if (metadata.remember !== false && node.routeId) {
      this.rememberRouteFocus(node.routeId, id);
    }
    this.publishReconciliationEvent('focus-requested', {
      direction: metadata.direction,
      focusId: id,
      inputKey: metadata.inputKey,
      pendingFocusId: this.pendingDirectionalFocus?.targetId,
      pendingToken: this.pendingDirectionalFocus?.token,
      reason: metadata.reason,
      requestedFocusId: id,
      routeId: metadata.routeId ?? node.routeId,
      targetMounted: true
    });
    const nativeFocusApplied = this.focusNodeIfAllowed(id, {
      direction: metadata.direction,
      focusId: id,
      inputKey: metadata.inputKey,
      pendingFocusId: this.pendingDirectionalFocus?.targetId,
      pendingToken: this.pendingDirectionalFocus?.token,
      reason: metadata.reason,
      requestedFocusId: id,
      routeId: metadata.routeId ?? node.routeId
    });
    const transition = nativeFocusApplied
      ? this.publishTransition(
        previous ?? null,
        id,
        metadata,
        previousRouteOverride ?? previousNode?.routeId ?? null
      )
      : undefined;
    this.notify(previous ?? null);

    if (!nativeFocusApplied) {
      this.publishReconciliationEvent('reconciliation-violation', {
        direction: metadata.direction,
        focusId: id,
        inputKey: metadata.inputKey,
        nativeFocusApplied: false,
        reason: metadata.reason,
        reconciliationViolation: true,
        requestedFocusId: id,
        routeId: metadata.routeId ?? node.routeId,
        targetMounted: true
      });
    }

    return {
      current: this.currentFocus,
      nativeFocusApplied,
      previous: previous ?? null,
      transition
    };
  }

  private moveFromMissingFocus(direction: PtvFocusDirection, metadata: FocusMoveMetadata): FocusNavigationResult {
    const previous = this.currentFocus;
    this.currentFocus = null;
    this.focusOrder.length = 0;
    if (!this.findValidFallbackId(undefined, this.activeRouteId)) {
      return { current: null, previous };
    }
    return this.focusDirectionFallback(direction, {
      ...metadata,
      reason: metadata.reason ?? 'missing-focus-fallback'
    });
  }

  private moveToFallback(previous: string | null) {
    const fallback = this.findValidFallbackId(previous, this.activeRouteId);
    const nextFocus = fallback ?? null;
    const wasCurrent = this.currentFocus;
    this.currentFocus = null;
    if (nextFocus) {
      this.publishReconciliationEvent('fallback-applied', {
        fallbackReason: 'logical-focus-missing-from-registry',
        focusId: nextFocus,
        reason: 'unregister-fallback',
        requestedFocusId: previous,
        routeId: this.activeRouteId,
        targetMounted: true
      });
      this.applyFocus(nextFocus, {
        reason: 'unregister-fallback',
        routeId: this.activeRouteId,
        fallbackUsed: true,
        remember: false
      }, previous ?? wasCurrent);
      return;
    }
    this.publishTransition(previous ?? wasCurrent, null, {
      reason: 'unregister-fallback',
      routeId: this.activeRouteId,
      fallbackUsed: false
    });
    this.notify(previous ?? wasCurrent);
  }

  private tryPendingRouteRestore(node: FocusNodeRegistration) {
    const pending = this.pendingRouteRestore;
    if (!pending || !this.nodeMatchesRoute(node, pending.routeId)) return false;

    if (pending.targetId === node.id) {
      if (!this.isInteractive(node)) return false;
      this.pendingRouteRestore = null;
      this.applyFocus(node.id, {
        reason: 'route-restore',
        routeId: pending.routeId,
        fallbackUsed: false
      });
      return true;
    }

    if (!pending.targetId && pending.fallbackFocusId === node.id) {
      if (!this.isInteractive(node)) return false;
      this.pendingRouteRestore = null;
      this.applyFocus(node.id, {
        reason: 'route-fallback',
        routeId: pending.routeId,
        fallbackUsed: true
      });
      return true;
    }

    return false;
  }

  private tryPendingDirectionalFocus(node: FocusNodeRegistration) {
    const pending = this.pendingDirectionalFocus;
    if (!pending || pending.targetId !== node.id || !this.nodeMatchesRoute(node, pending.routeId)) {
      return false;
    }
    if (!this.isInteractive(node)) return false;

    const previous = this.currentFocus;
    this.pendingDirectionalFocus = null;
    this.directionalReservation = {
      direction: pending.direction,
      inputKey: pending.inputKey,
      routeId: pending.routeId,
      settled: false,
      targetId: pending.targetId
    };
    const result = this.applyFocus(node.id, {
      direction: pending.direction,
      fallbackUsed: false,
      inputKey: pending.inputKey,
      reason: 'directional',
      routeId: pending.routeId
    }, previous);
    this.publishReconciliationEvent('pending-focus-restored', {
      direction: pending.direction,
      focusId: pending.targetId,
      inputKey: pending.inputKey,
      nativeFocusApplied: this.readNativeFocusId() === pending.targetId,
      pendingFocusId: pending.targetId,
      pendingToken: pending.token,
      reason: 'directional',
      requestedFocusId: pending.targetId,
      routeId: pending.routeId,
      targetMounted: true
    });
    return result.current === node.id;
  }

  private clearDirectionalFocusState() {
    this.directionalReservation = null;
    this.pendingDirectionalFocus = null;
  }

  private isWaitingForAnotherNode(node: FocusNodeRegistration) {
    const pendingDirectional = this.pendingDirectionalFocus;
    if (
      pendingDirectional
      && this.nodeMatchesRoute(node, pendingDirectional.routeId)
      && pendingDirectional.targetId !== node.id
    ) return true;
    const pending = this.pendingRouteRestore;
    if (!pending || !this.nodeMatchesRoute(node, pending.routeId)) return false;
    const requestedId = pending.targetId ?? pending.fallbackFocusId;
    return Boolean(requestedId && requestedId !== node.id);
  }

  private pushHistory(id: string) {
    this.focusOrder = this.focusOrder.filter(item => item !== id);
    this.focusOrder.push(id);
    if (this.focusOrder.length > this.maxHistory) {
      this.focusOrder.shift();
    }
  }

  private findValidFallbackId(exclude?: string | null, routeId?: string | null) {
    return this.firstAvailable(exclude, routeId)?.id ?? null;
  }

  private canFocusForRoute(id: string, routeId: string) {
    const node = this.nodes.get(id);
    return Boolean(node && this.isInteractive(node) && this.nodeMatchesRoute(node, routeId));
  }

  private isInActiveRoute(node: FocusNodeRegistration) {
    return this.nodeMatchesRoute(node, this.activeRouteId);
  }

  private nodeMatchesRoute(node: FocusNodeRegistration, routeId?: string | null) {
    const normalizedRouteId = normalizeRouteId(routeId);
    if (!normalizedRouteId || !node.routeId) return true;
    return node.routeId === normalizedRouteId;
  }

  private isInteractive(node: FocusNodeRegistration) {
    const ref = node.ref;
    if (!ref.isConnected) return false;
    if (ref.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    if ('disabled' in ref && (ref as HTMLButtonElement).disabled) return false;
    if (ref.getAttribute('aria-disabled') === 'true') return false;

    const view = ref.ownerDocument?.defaultView;
    if (view?.getComputedStyle) {
      let candidate: HTMLElement | null = ref;
      while (candidate) {
        const style = view.getComputedStyle(candidate);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
        candidate = candidate.parentElement;
      }
    }
    return true;
  }

  private firstAvailable(exclude?: string | null, routeId?: string | null) {
    return Array.from(this.nodes.values()).find(candidate => (
      candidate.id !== exclude && this.isInteractive(candidate) && this.nodeMatchesRoute(candidate, routeId)
    ));
  }

  private focusNodeIfAllowed(id: string, metadata: FocusReconciliationMetadata = {}) {
    const node = this.nodes.get(id);
    if (!node || !this.isInteractive(node) || typeof node.ref.focus !== 'function') {
      this.publishReconciliationEvent('native-focus-failed', {
        ...metadata,
        focusId: id,
        nativeFocusApplied: false,
        requestedFocusId: metadata.requestedFocusId ?? id,
        targetMounted: Boolean(node?.ref.isConnected)
      });
      return false;
    }
    try {
      node.ref.focus({ preventScroll: true });
    } catch {
      this.publishReconciliationEvent('native-focus-failed', {
        ...metadata,
        focusId: id,
        nativeFocusApplied: false,
        requestedFocusId: metadata.requestedFocusId ?? id,
        targetMounted: true
      });
      return false;
    }
    const nativeFocusApplied = node.ref.ownerDocument.activeElement === node.ref;
    this.publishReconciliationEvent(
      nativeFocusApplied ? 'native-focus-applied' : 'native-focus-failed',
      {
        ...metadata,
        focusId: id,
        nativeFocusApplied,
        reconciliationViolation: !nativeFocusApplied,
        requestedFocusId: metadata.requestedFocusId ?? id,
        targetMounted: true
      }
    );
    return nativeFocusApplied;
  }

  private readNativeFocusId() {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.getAttribute('data-focus-id') : null;
  }

  private publishReconciliationEvent(
    type: FocusReconciliationEventType,
    metadata: FocusReconciliationMetadata = {}
  ) {
    if (this.reconciliationListeners.size === 0) return null;
    const requestedFocusId = metadata.requestedFocusId ?? null;
    const requestedNode = requestedFocusId ? this.nodes.get(requestedFocusId) : undefined;
    const event: FocusReconciliationEvent = {
      timestamp: Date.now(),
      type,
      routeId: normalizeRouteId(metadata.routeId) ?? this.activeRouteId,
      focusId: metadata.focusId ?? null,
      requestedFocusId,
      registeredFocusId: metadata.registeredFocusId ?? null,
      unregisteredFocusId: metadata.unregisteredFocusId ?? null,
      logicalFocusId: this.currentFocus,
      nativeFocusId: this.readNativeFocusId(),
      pendingFocusId: metadata.pendingFocusId ?? this.pendingDirectionalFocus?.targetId ?? null,
      inputKey: metadata.inputKey ?? null,
      reason: metadata.reason ?? null,
      direction: metadata.direction ?? null,
      targetMounted: metadata.targetMounted ?? Boolean(requestedNode?.ref.isConnected),
      interactionMode: this.interactionModeValue,
      pendingToken: metadata.pendingToken ?? this.pendingDirectionalFocus?.token ?? null,
      fallbackReason: metadata.fallbackReason ?? null,
      nativeFocusApplied: metadata.nativeFocusApplied ?? null,
      reconciliationViolation: metadata.reconciliationViolation ?? false,
      renderWindowStart: metadata.renderWindowStart ?? this.currentRenderWindowStart
    };
    for (const listener of Array.from(this.reconciliationListeners)) {
      listener(event);
    }
    return event;
  }

  private publishTransition(
    previousFocusId: string | null,
    nextFocusId: string | null,
    metadata: InternalFocusMetadata,
    previousRouteId: string | null = null
  ) {
    const nextNode = nextFocusId ? this.nodes.get(nextFocusId) : undefined;
    const transition: FocusTransition = {
      timestamp: Date.now(),
      routeId: normalizeRouteId(metadata.routeId) ?? nextNode?.routeId ?? this.activeRouteId,
      previousRouteId,
      previousFocusId,
      nextFocusId,
      inputKey: metadata.inputKey ?? null,
      reason: metadata.reason ?? 'direct',
      direction: metadata.direction ?? null,
      fallbackUsed: metadata.fallbackUsed ?? false
    };
    this.lastFocusTransition = transition;
    for (const listener of Array.from(this.transitionListeners)) {
      listener(transition);
    }
    return transition;
  }

  private notify(previous: string | null = this.previousFocusId) {
    for (const listener of Array.from(this.listeners)) {
      listener(this.currentFocus || null, previous);
    }
  }
}
