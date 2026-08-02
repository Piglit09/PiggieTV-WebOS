import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusManager, type FocusTransition } from '../src/focus/FocusManager';

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

    manager.setPointerFocusActive(true);
    manager.move('right');
    expect(manager.focusId).toBe('right');
    expect(manager.previousFocusId).toBe('left');

    manager.setPointerFocusActive(false);
    expect(nodeRef).toHaveBeenCalledTimes(1);
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
