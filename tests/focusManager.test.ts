import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FocusManager,
  type FocusReconciliationEvent,
  type FocusTransition
} from '../src/focus/FocusManager';

type Bounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

function makeBounds(bounds: Bounds) {
  return {
    ...bounds,
    x: bounds.left,
    y: bounds.top,
    toJSON() {
      return this;
    }
  };
}

function createFocusNode(id: string, bounds: Bounds, hidden = false, disabled = false) {
  const node = document.createElement('button');
  node.id = id;
  node.setAttribute('data-focus-id', id);
  node.tabIndex = -1;
  node.getBoundingClientRect = () => makeBounds(bounds);
  if (hidden) {
    node.setAttribute('hidden', 'true');
  }
  if (disabled) {
    (node as HTMLButtonElement).disabled = true;
  }
  document.body.appendChild(node);
  return node;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('FocusManager', () => {
  it('registers and focuses nodes', () => {
    const manager = new FocusManager();
    const node = createFocusNode('item-1', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const unregister = manager.register({ id: 'item-1', ref: node });

    expect(manager.focusId).toBe('item-1');
    expect(manager.previousFocusId).toBeNull();
    unregister();
    expect(manager.focusId).toBeNull();
  });

  it('handles duplicate IDs deterministically by replacement', () => {
    const manager = new FocusManager();
    const first = createFocusNode('dup', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const cleanupFirst = manager.register({ id: 'dup', ref: first });
    const second = createFocusNode('dup', { left: 110, top: 0, right: 210, bottom: 80, width: 100, height: 80 });
    const cleanupSecond = manager.register({ id: 'dup', ref: second });

    expect(manager.focusId).toBe('dup');
    const moveResult = manager.move('right');
    expect(moveResult.current).toBe('dup');
    cleanupSecond();
    cleanupFirst();
  });

  it('moves by geometry and skips hidden or disabled targets', () => {
    const manager = new FocusManager();
    const left = createFocusNode('left', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const rightHidden = createFocusNode('right-hidden', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 }, true);
    const rightDisabled = createFocusNode('right-disabled', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 }, false, true);

    manager.register({ id: 'left', ref: left });
    manager.register({ id: 'right-hidden', ref: rightHidden });
    manager.register({ id: 'right-disabled', ref: rightDisabled });

    const moved = manager.move('right');
    expect(moved.current).toBe('left');
    expect(moved.previous).toBe('left');
  });

  it('does not report a directional transition as reconciled when native focus fails', () => {
    const manager = new FocusManager();
    manager.setActiveRoute('shows');
    const source = createFocusNode('source', {
      left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80
    });
    const target = createFocusNode('target', {
      left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80
    });
    const nativeFocus = target.focus.bind(target);
    target.focus = vi.fn();
    const events: FocusReconciliationEvent[] = [];
    manager.subscribeReconciliationEvents(event => events.push(event));
    manager.register({ id: 'source', routeId: 'shows', ref: source });
    manager.register({ id: 'target', routeId: 'shows', ref: target });
    manager.focus('source');

    const result = manager.move('right', {
      inputKey: 'ArrowRight',
      reason: 'directional',
      routeId: 'shows'
    });

    expect(result.current).toBe('target');
    expect(result.nativeFocusApplied).toBe(false);
    expect(result.transition).toBeUndefined();
    expect(manager.focusId).toBe('target');
    expect(document.activeElement).toBe(source);
    expect(events.some(event => (
      event.type === 'reconciliation-violation'
      && event.logicalFocusId === 'target'
      && event.nativeFocusId === 'source'
    ))).toBe(true);

    target.focus = nativeFocus;
    expect(manager.reconcileCurrentFocus('render-window-commit', 0)).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  it('tracks previous focus and supports history restore', () => {
    const manager = new FocusManager();
    const first = createFocusNode('first', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const second = createFocusNode('second', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });

    manager.register({ id: 'first', ref: first });
    manager.register({ id: 'second', ref: second });

    expect(manager.focus('first').current).toBe('first');
    expect(manager.focus('second').current).toBe('second');
    expect(manager.previousFocusId).toBe('first');

    const restored = manager.restorePrevious();
    expect(restored.current).toBe('first');
    expect(restored.previous).toBe('second');
  });

  it('restores fallback when active item is removed', () => {
    const manager = new FocusManager();
    const first = createFocusNode('first', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const second = createFocusNode('second', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    const cleanupFirst = manager.register({ id: 'first', ref: first });
    const cleanupSecond = manager.register({ id: 'second', ref: second });

    manager.focus('second');
    cleanupSecond();

    expect(manager.focusId).toBe('first');
    cleanupFirst();
  });

  it('keeps a known directional target pending across an explicit unregister and replacement registration', () => {
    const manager = new FocusManager();
    manager.setActiveRoute('shows');
    const filter = createFocusNode('browse-filter-recent', {
      left: 0,
      top: 0,
      right: 180,
      bottom: 60,
      width: 180,
      height: 60
    });
    const card568 = createFocusNode('browse-shows-card-568', {
      left: 0,
      top: 100,
      right: 180,
      bottom: 422,
      width: 180,
      height: 322
    });
    const card576 = createFocusNode('browse-shows-card-576', {
      left: 0,
      top: 452,
      right: 180,
      bottom: 774,
      width: 180,
      height: 322
    });
    manager.register({ id: 'browse-filter-recent', routeId: 'shows', ref: filter });
    manager.register({ id: 'browse-shows-card-568', routeId: 'shows', ref: card568 });
    const unregisterOriginalTarget = manager.register({
      id: 'browse-shows-card-576',
      routeId: 'shows',
      ref: card576
    });
    manager.focus('browse-shows-card-568');

    const transitions: FocusTransition[] = [];
    const unsubscribe = manager.subscribeTransitions(transition => transitions.push(transition));
    let renderWindowStart = 512;
    const moved = manager.move('down', {
      inputKey: 'ArrowDown',
      reason: 'directional',
      routeId: 'shows'
    });
    expect(moved.current).toBe('browse-shows-card-576');
    expect(manager.focusId).toBe('browse-shows-card-576');
    expect(document.activeElement).toBe(card576);

    // This is a synthetic registry contract. The real 512 -> 520 window keeps
    // card 576 mounted; this separately proves transient unregistration must
    // not make a route fallback authoritative when the target is known.
    renderWindowStart = 520;
    unregisterOriginalTarget();
    card576.remove();
    filter.focus();
    manager.handleDomFocus('browse-filter-recent', {
      reason: 'dom-focus',
      routeId: 'shows'
    });
    expect(manager.focusId).toBe('browse-shows-card-576');
    expect(manager.pendingFocusId).toBe('browse-shows-card-576');
    expect(document.activeElement).not.toBe(filter);
    expect(transitions.some(transition => transition.reason === 'unregister-fallback')).toBe(false);

    const replacement576 = createFocusNode('browse-shows-card-576-replacement', {
      left: 0,
      top: 452,
      right: 180,
      bottom: 774,
      width: 180,
      height: 322
    });
    replacement576.setAttribute('data-focus-id', 'browse-shows-card-576');
    manager.register({
      id: 'browse-shows-card-576',
      routeId: 'shows',
      ref: replacement576
    });
    unsubscribe();

    expect(renderWindowStart).toBe(520);
    expect(manager.focusId).toBe('browse-shows-card-576');
    expect(manager.pendingFocusId).toBeNull();
    expect(document.activeElement).toBe(replacement576);
    expect(document.querySelectorAll('[data-focus-id]:focus')).toHaveLength(1);
    expect(transitions.some(transition => transition.reason === 'unregister-fallback')).toBe(false);
  });

  it('uses an explicit deterministic failure path when a pending target is permanently unavailable', () => {
    const manager = new FocusManager();
    manager.setActiveRoute('shows');
    const filter = createFocusNode('browse-filter-recent', {
      left: 0, top: 0, right: 180, bottom: 60, width: 180, height: 60
    });
    const source = createFocusNode('browse-shows-card-568', {
      left: 0, top: 100, right: 180, bottom: 422, width: 180, height: 322
    });
    const target = createFocusNode('browse-shows-card-576', {
      left: 0, top: 452, right: 180, bottom: 774, width: 180, height: 322
    });
    manager.register({ id: 'browse-filter-recent', routeId: 'shows', ref: filter });
    manager.register({ id: 'browse-shows-card-568', routeId: 'shows', ref: source });
    const unregisterTarget = manager.register({
      id: 'browse-shows-card-576', routeId: 'shows', ref: target
    });
    manager.focus('browse-shows-card-568');
    manager.move('down', { inputKey: 'ArrowDown', routeId: 'shows' });
    unregisterTarget();
    target.remove();

    expect(manager.focusId).toBe('browse-shows-card-576');
    expect(manager.pendingFocusId).toBe('browse-shows-card-576');
    expect(document.activeElement).not.toBe(filter);

    const result = manager.failPendingDirectionalFocus(
      'target-permanently-removed',
      'browse-filter-recent'
    );

    expect(result.current).toBe('browse-filter-recent');
    expect(manager.focusId).toBe('browse-filter-recent');
    expect(manager.pendingFocusId).toBeNull();
    expect(document.activeElement).toBe(filter);
    expect(result.transition).toMatchObject({
      fallbackUsed: true,
      reason: 'pending-focus-fallback'
    });
  });

  it('reconciles native displacement after the retained 568 to 576 target crosses 512 to 520', () => {
    const manager = new FocusManager();
    manager.setActiveRoute('shows');
    const filter = createFocusNode('browse-filter-recent', {
      left: 0,
      top: 0,
      right: 180,
      bottom: 60,
      width: 180,
      height: 60
    });
    const outgoing512 = createFocusNode('browse-shows-card-512', {
      left: 0,
      top: -2_364,
      right: 180,
      bottom: -2_042,
      width: 180,
      height: 322
    });
    const card568 = createFocusNode('browse-shows-card-568', {
      left: 0,
      top: 100,
      right: 180,
      bottom: 422,
      width: 180,
      height: 322
    });
    const card576 = createFocusNode('browse-shows-card-576', {
      left: 0,
      top: 452,
      right: 180,
      bottom: 774,
      width: 180,
      height: 322
    });
    manager.register({ id: 'browse-filter-recent', routeId: 'shows', ref: filter });
    const unregister512 = manager.register({
      id: 'browse-shows-card-512',
      routeId: 'shows',
      ref: outgoing512
    });
    manager.register({ id: 'browse-shows-card-568', routeId: 'shows', ref: card568 });
    manager.register({ id: 'browse-shows-card-576', routeId: 'shows', ref: card576 });
    manager.focus('browse-shows-card-568');
    expect(manager.reconcileCurrentFocus('render-window-commit', 512)).toBe(true);

    let renderWindowStart = 512;
    const targetIdentity = card576;
    const reconciliationEvents: FocusReconciliationEvent[] = [];
    const unsubscribe = manager.subscribeReconciliationEvents(event => {
      reconciliationEvents.push(event);
    });
    expect(manager.move('down', {
      inputKey: 'ArrowDown',
      reason: 'directional',
      routeId: 'shows'
    }).current).toBe('browse-shows-card-576');
    expect(document.activeElement).toBe(targetIdentity);

    // Model [512, 608) -> [520, 616): the outgoing edge is pruned while the
    // directional target is deliberately retained with the same DOM identity.
    renderWindowStart = 520;
    unregister512();
    outgoing512.remove();
    const incoming608 = createFocusNode('browse-shows-card-608', {
      left: 0,
      top: 1_860,
      right: 180,
      bottom: 2_182,
      width: 180,
      height: 322
    });
    manager.register({ id: 'browse-shows-card-608', routeId: 'shows', ref: incoming608 });
    expect(manager.reconcileCurrentFocus('render-window-commit', renderWindowStart)).toBe(true);

    expect(renderWindowStart).toBe(520);
    expect(card576).toBe(targetIdentity);
    expect(card576.isConnected).toBe(true);
    expect(manager.focusId).toBe('browse-shows-card-576');

    // Reproduce the observed one-owner filter signature: native focus lands
    // on the filter and its DOM-focus handler reports that displacement.
    filter.focus();
    manager.focus('browse-filter-recent', { reason: 'dom-focus', routeId: 'shows' });
    unsubscribe();

    expect(manager.focusId).toBe('browse-shows-card-576');
    expect(document.activeElement).toBe(targetIdentity);
    expect(document.querySelectorAll('[data-focus-id]:focus')).toHaveLength(1);
    expect(reconciliationEvents.map(event => event.type)).toEqual(expect.arrayContaining([
      'directional-target-calculated',
      'focus-requested',
      'native-focus-applied',
      'unregister',
      'register',
      'render-window-commit',
      'reconciliation-violation',
      'dom-focus-reconciled'
    ]));
    expect(reconciliationEvents.every(event => (
      Number.isFinite(event.timestamp)
      && event.routeId === 'shows'
      && (event.renderWindowStart === 512 || event.renderWindowStart === 520)
      && event.interactionMode === 'remote'
    ))).toBe(true);
    expect(reconciliationEvents.at(-1)).toMatchObject({
      type: 'dom-focus-reconciled',
      requestedFocusId: 'browse-shows-card-576',
      logicalFocusId: 'browse-shows-card-576',
      nativeFocusId: 'browse-shows-card-576',
      targetMounted: true,
      nativeFocusApplied: true,
      renderWindowStart: 520
    });
  });

  it('preserves exact columns and one native/logical owner across adjacent Shows window boundaries', () => {
    const columns = [0, 1, 3, 7];
    const transitions = [
      { from: 504, to: 512, sourceRowStart: 560 },
      { from: 512, to: 520, sourceRowStart: 568 },
      { from: 520, to: 528, sourceRowStart: 576 }
    ];

    for (const boundary of transitions) {
      for (const column of columns) {
        document.body.innerHTML = '';
        const manager = new FocusManager();
        manager.setActiveRoute('shows');
        const cleanups = new Map<number, () => void>();
        const nodes = new Map<number, HTMLElement>();
        const registerCard = (index: number) => {
          const row = Math.floor(index / 8);
          const cardColumn = index % 8;
          const node = createFocusNode(`browse-shows-card-${index}`, {
            left: 80 + cardColumn * 216,
            top: 100 + row * 352,
            right: 260 + cardColumn * 216,
            bottom: 422 + row * 352,
            width: 180,
            height: 322
          });
          nodes.set(index, node);
          cleanups.set(index, manager.register({
            id: `browse-shows-card-${index}`,
            routeId: 'shows',
            ref: node
          }));
        };
        for (let index = boundary.from; index < boundary.from + 96; index += 1) {
          registerCard(index);
        }
        const filter = createFocusNode('browse-filter-recent', {
          left: 80, top: -1_000, right: 260, bottom: -940, width: 180, height: 60
        });
        const header = createFocusNode('shell-shows', {
          left: 80, top: -2_000, right: 260, bottom: -1_940, width: 180, height: 60
        });
        manager.register({ id: 'browse-filter-recent', routeId: 'shows', ref: filter });
        manager.register({ id: 'shell-shows', routeId: 'shows', ref: header });

        const sourceIndex = boundary.sourceRowStart + column;
        const targetIndex = sourceIndex + 8;
        const source = nodes.get(sourceIndex);
        const target = nodes.get(targetIndex);
        if (!source || !target) throw new Error('Boundary fixture is incomplete');
        manager.focus(`browse-shows-card-${sourceIndex}`, { routeId: 'shows' });
        expect(manager.move('down', {
          inputKey: 'ArrowDown', routeId: 'shows'
        }).current).toBe(`browse-shows-card-${targetIndex}`);

        const targetIdentity = target;
        for (let index = boundary.from; index < boundary.to; index += 1) {
          cleanups.get(index)?.();
          nodes.get(index)?.remove();
        }
        for (let index = boundary.from + 96; index < boundary.to + 96; index += 1) {
          registerCard(index);
        }
        expect(manager.reconcileCurrentFocus('render-window-commit', boundary.to)).toBe(true);
        expect(manager.focusId).toBe(`browse-shows-card-${targetIndex}`);
        expect(document.activeElement).toBe(targetIdentity);
        expect(targetIdentity.isConnected).toBe(true);
        expect(targetIndex % 8).toBe(column);
        expect(filter.matches(':focus')).toBe(false);
        expect(header.matches(':focus')).toBe(false);
        expect(document.querySelectorAll('[data-focus-id]:focus')).toHaveLength(1);

        expect(manager.move('up', {
          inputKey: 'ArrowUp', routeId: 'shows'
        }).current).toBe(`browse-shows-card-${sourceIndex}`);
        for (let index = boundary.from + 96; index < boundary.to + 96; index += 1) {
          cleanups.get(index)?.();
          nodes.get(index)?.remove();
        }
        for (let index = boundary.from; index < boundary.to; index += 1) {
          registerCard(index);
        }
        expect(manager.reconcileCurrentFocus('render-window-commit', boundary.from)).toBe(true);
        expect(manager.focusId).toBe(`browse-shows-card-${sourceIndex}`);
        expect(document.activeElement).toBe(source);
        expect(source.isConnected).toBe(true);
        expect(sourceIndex % 8).toBe(column);
        expect(filter.matches(':focus')).toBe(false);
        expect(header.matches(':focus')).toBe(false);
        expect(document.querySelectorAll('[data-focus-id]:focus')).toHaveLength(1);
      }
    }
  });

  it('supports focus subscriptions and cleanup', () => {
    const manager = new FocusManager();
    const nodeA = createFocusNode('a', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const nodeB = createFocusNode('b', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });

    const updates: Array<{ current: string | null; previous: string | null }> = [];
    const unsubscribe = manager.subscribe((current, previous) => {
      updates.push({ current, previous });
    });

    manager.register({ id: 'a', ref: nodeA });
    manager.register({ id: 'b', ref: nodeB });
    manager.focus('b');
    manager.unregister('a');

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].current).toBe('b');

    unsubscribe();
    manager.clearListeners();
    manager.focus('b');

    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps directional flow predictable during pointer interaction', () => {
    const manager = new FocusManager();
    const left = createFocusNode('left', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const right = createFocusNode('right', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    const nodeRef = vi.spyOn(right, 'focus');

    manager.register({ id: 'left', ref: left });
    manager.register({ id: 'right', ref: right });
    manager.focus('left');

    manager.claimPointerInteraction();
    manager.move('right');
    expect(manager.focusId).toBe('right');
    expect(manager.previousFocusId).toBe('left');

    manager.claimRemoteInteraction();
    expect(nodeRef).toHaveBeenCalledTimes(1);
  });

  it('requires coordinate-changing pointer movement before pointer focus can resume after remote input', () => {
    const manager = new FocusManager();
    const remote = createFocusNode('remote', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const pointer = createFocusNode('pointer', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    manager.register({ id: 'remote', ref: remote });
    manager.register({ id: 'pointer', ref: pointer });
    manager.focus('remote');

    expect(manager.interactionMode).toBe('remote');
    expect(manager.recordPointerMovement(319, 180, 5)).toBe(false);
    expect(manager.interactionMode).toBe('remote');
    expect(manager.recordPointerMovement(320, 180, 10)).toBe(true);
    expect(manager.focusFromPointer('pointer').current).toBe('pointer');
    expect(manager.interactionState).toEqual({
      mode: 'pointer',
      lastPointerX: 320,
      lastPointerY: 180,
      lastPointerMotionTimestamp: 10,
      pointerBaselinePending: false
    });

    manager.claimRemoteInteraction();
    manager.claimRemoteInteraction();
    expect(manager.interactionMode).toBe('remote');
    expect(manager.interactionState.pointerBaselinePending).toBe(true);
    expect(document.activeElement).toBe(pointer);
    expect(manager.recordPointerMovement(Number.NaN, 180, 15)).toBe(false);
    expect(manager.interactionState.pointerBaselinePending).toBe(true);
    expect(manager.recordPointerMovement(320, 180, 20)).toBe(false);
    expect(manager.interactionState.pointerBaselinePending).toBe(true);
    expect(manager.focusFromPointer('remote').current).toBe('pointer');

    // A single coordinate jump after DPAD can be generated by webOS window
    // activation. It establishes the new baseline but cannot steal focus.
    expect(manager.recordPointerMovement(321, 180, 30)).toBe(false);
    expect(manager.interactionMode).toBe('remote');
    expect(manager.interactionState).toMatchObject({
      lastPointerMotionTimestamp: 30,
      pointerBaselinePending: false
    });
    expect(manager.focusFromPointer('remote').current).toBe('pointer');

    expect(manager.recordPointerMovement(322, 180, 40)).toBe(true);
    expect(manager.focusFromPointer('remote').current).toBe('remote');
    expect(manager.interactionMode).toBe('pointer');
  });

  it.each([
    ['up', 'up', { left: 100, top: 0, right: 200, bottom: 80, width: 100, height: 80 }],
    ['down', 'down', { left: 100, top: 200, right: 200, bottom: 280, width: 100, height: 80 }],
    ['left', 'left', { left: 0, top: 100, right: 80, bottom: 180, width: 80, height: 80 }],
    ['right', 'right', { left: 220, top: 100, right: 300, bottom: 180, width: 80, height: 80 }]
  ] as const)('switches pointer ownership to remote before an Arrow%s move', (_label, direction, targetBounds) => {
    const manager = new FocusManager();
    const center = createFocusNode('center', { left: 100, top: 100, right: 200, bottom: 180, width: 100, height: 80 });
    const target = createFocusNode(direction, targetBounds);
    manager.register({ id: 'center', ref: center });
    manager.register({ id: direction, ref: target });
    manager.focus('center');
    manager.recordPointerMovement(399, 220);
    manager.recordPointerMovement(400, 220);
    expect(manager.interactionMode).toBe('pointer');

    let modeDuringTransition: string | null = null;
    const unsubscribe = manager.subscribeTransitions(() => {
      modeDuringTransition = manager.interactionMode;
    });
    const result = manager.move(direction, { inputKey: `Arrow${direction}` });
    unsubscribe();

    expect(result.current).toBe(direction);
    expect(modeDuringTransition).toBe('remote');
    expect(manager.interactionMode).toBe('remote');
    expect(document.activeElement).toBe(target);
  });

  it('remembers focus per route and restores it when the node registers again', () => {
    const manager = new FocusManager();
    const homeA = createFocusNode('home-a', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const homeB = createFocusNode('home-b', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });

    manager.setActiveRoute('home');
    const removeHomeA = manager.register({ id: 'home-a', routeId: 'home', ref: homeA });
    const removeHomeB = manager.register({ id: 'home-b', routeId: 'home', ref: homeB });
    manager.focus('home-b');
    expect(manager.getRememberedRouteFocus('home')).toBe('home-b');

    manager.setActiveRoute('details', { fallbackFocusId: 'details-play' });
    removeHomeA();
    removeHomeB();
    const detailsPlay = createFocusNode('details-play', { left: 0, top: 100, right: 100, bottom: 180, width: 100, height: 80 });
    const removeDetails = manager.register({ id: 'details-play', routeId: 'details', ref: detailsPlay });
    expect(manager.focusId).toBe('details-play');

    manager.setActiveRoute('home');
    removeDetails();
    const restoredHomeA = createFocusNode('home-a-restored', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const restoredHomeB = createFocusNode('home-b-restored', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    manager.register({ id: 'home-a', routeId: 'home', ref: restoredHomeA });
    expect(manager.focusId).toBeNull();
    manager.register({ id: 'home-b', routeId: 'home', ref: restoredHomeB });

    expect(manager.focusId).toBe('home-b');
    expect(manager.lastTransition).toMatchObject({
      routeId: 'home',
      previousFocusId: null,
      nextFocusId: 'home-b',
      reason: 'route-restore',
      fallbackUsed: false
    });
  });

  it('keeps a route restore pending until a temporarily disabled target becomes actionable', () => {
    const manager = new FocusManager();
    const play = createFocusNode(
      'details-play',
      { left: 0, top: 0, right: 160, bottom: 80, width: 160, height: 80 },
      false,
      true
    );

    manager.setActiveRoute('details:movie-1', { fallbackFocusId: 'details-play' });
    const unregisterDisabled = manager.register({
      id: 'details-play',
      routeId: 'details:movie-1',
      ref: play
    });
    expect(manager.focusId).toBeNull();

    unregisterDisabled();
    play.removeAttribute('disabled');
    manager.register({ id: 'details-play', routeId: 'details:movie-1', ref: play });

    expect(manager.focusId).toBe('details-play');
    expect(document.activeElement).toBe(play);
  });

  it('keeps a pending route fallback ahead of unrelated same-route registrations', () => {
    const manager = new FocusManager();
    const shellHome = createFocusNode('shell-home', {
      left: 0,
      top: 0,
      right: 120,
      bottom: 60,
      width: 120,
      height: 60
    });
    const detailsPrimary = createFocusNode('details-primary', {
      left: 0,
      top: 100,
      right: 180,
      bottom: 180,
      width: 180,
      height: 80
    });

    manager.setActiveRoute('details:series-1', {
      fallbackFocusId: 'details-primary',
      focusFirstIfUnremembered: false
    });
    manager.register({
      id: 'shell-home',
      routeId: 'details:series-1',
      ref: shellHome
    });

    expect(manager.focusId).toBeNull();
    expect(document.activeElement).not.toBe(shellHome);

    manager.register({
      id: 'details-primary',
      routeId: 'details:series-1',
      ref: detailsPrimary
    });

    expect(manager.focusId).toBe('details-primary');
    expect(document.activeElement).toBe(detailsPrimary);
    expect(manager.lastTransition).toMatchObject({
      routeId: 'details:series-1',
      previousFocusId: null,
      nextFocusId: 'details-primary',
      reason: 'route-fallback',
      fallbackUsed: true
    });
  });

  it('does not remember a shell control under the next route when it re-registers first', () => {
    const manager = new FocusManager();
    const homeShell = createFocusNode('shell-home-old', {
      left: 0,
      top: 0,
      right: 120,
      bottom: 60,
      width: 120,
      height: 60
    });
    const detailsShell = createFocusNode('shell-home-new', {
      left: 0,
      top: 0,
      right: 120,
      bottom: 60,
      width: 120,
      height: 60
    });
    const detailsPrimary = createFocusNode('details-primary', {
      left: 0,
      top: 100,
      right: 180,
      bottom: 180,
      width: 180,
      height: 80
    });

    manager.setActiveRoute('home');
    manager.register({ id: 'shell-home', routeId: 'home', ref: homeShell });
    manager.register({ id: 'shell-home', routeId: 'details:series-1', ref: detailsShell });
    manager.setActiveRoute('details:series-1', {
      fallbackFocusId: 'details-primary',
      focusFirstIfUnremembered: false
    });

    expect(manager.getRememberedRouteFocus('details:series-1')).toBeNull();
    manager.register({
      id: 'details-primary',
      routeId: 'details:series-1',
      ref: detailsPrimary
    });

    expect(manager.focusId).toBe('details-primary');
    expect(document.activeElement).toBe(detailsPrimary);
  });

  it('preserves a source card restore when a shell control re-registers for the destination route', () => {
    const manager = new FocusManager();
    const searchResult = createFocusNode('search-result-rock', {
      left: 0,
      top: 120,
      right: 160,
      bottom: 360,
      width: 160,
      height: 240
    });
    const searchShell = createFocusNode('shell-home-search', {
      left: 0,
      top: 0,
      right: 120,
      bottom: 60,
      width: 120,
      height: 60
    });
    const categoryShell = createFocusNode('shell-home-category', {
      left: 0,
      top: 0,
      right: 120,
      bottom: 60,
      width: 120,
      height: 60
    });

    manager.setActiveRoute('search');
    const removeResult = manager.register({ id: 'search-result-rock', routeId: 'search', ref: searchResult });
    manager.register({ id: 'shell-home', routeId: 'search', ref: searchShell });
    manager.focus('search-result-rock');
    expect(manager.getRememberedRouteFocus('search')).toBe('search-result-rock');

    removeResult();
    expect(manager.focusId).toBe('shell-home');
    manager.register({
      id: 'shell-home',
      routeId: 'search:category-rock',
      ref: categoryShell
    });
    manager.setActiveRoute('search:category-rock', { fallbackFocusId: 'shell-back-search' });

    expect(manager.getRememberedRouteFocus('search')).toBe('search-result-rock');

    manager.setActiveRoute('search');
    const restoredResult = createFocusNode('search-result-rock-restored', {
      left: 0,
      top: 120,
      right: 160,
      bottom: 360,
      width: 160,
      height: 240
    });
    manager.register({ id: 'search-result-rock', routeId: 'search', ref: restoredResult });

    expect(manager.focusId).toBe('search-result-rock');
    expect(document.activeElement).toBe(restoredResult);
    expect(manager.lastTransition).toMatchObject({
      routeId: 'search',
      nextFocusId: 'search-result-rock',
      reason: 'route-restore',
      fallbackUsed: false
    });
  });

  it('emits diagnostics metadata for directional input', () => {
    const manager = new FocusManager();
    const left = createFocusNode('left', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const right = createFocusNode('right', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    manager.setActiveRoute('home');
    manager.register({ id: 'left', routeId: 'home', ref: left });
    manager.register({ id: 'right', routeId: 'home', ref: right });

    const transitions: FocusTransition[] = [];
    const unsubscribe = manager.subscribeTransitions(transition => transitions.push(transition));
    const moved = manager.move('right', { inputKey: 'ArrowRight' });
    unsubscribe();

    expect(moved.current).toBe('right');
    expect(transitions.at(-1)).toMatchObject({
      routeId: 'home',
      previousFocusId: 'left',
      nextFocusId: 'right',
      inputKey: 'ArrowRight',
      direction: 'right',
      reason: 'directional',
      fallbackUsed: false
    });
  });

  it('does not navigate to a node hidden by an ancestor', () => {
    const manager = new FocusManager();
    const visible = createFocusNode('visible', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const hidden = createFocusNode('hidden-child', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    const hiddenParent = document.createElement('div');
    hiddenParent.hidden = true;
    document.body.appendChild(hiddenParent);
    hiddenParent.appendChild(hidden);

    manager.register({ id: 'visible', ref: visible });
    manager.register({ id: 'hidden-child', ref: hidden });
    const result = manager.move('right');

    expect(result.current).toBe('visible');
    expect(manager.focusId).toBe('visible');
  });

  it('does not unregister a replacement node from a stale cleanup callback', () => {
    const manager = new FocusManager();
    const original = createFocusNode('duplicate-original', { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    const replacement = createFocusNode('duplicate-replacement', { left: 120, top: 0, right: 220, bottom: 80, width: 100, height: 80 });
    const removeOriginal = manager.register({ id: 'duplicate', ref: original });
    manager.register({ id: 'duplicate', ref: replacement });

    removeOriginal();

    expect(manager.focus('duplicate').current).toBe('duplicate');
    expect(document.activeElement).toBe(replacement);
  });
});
