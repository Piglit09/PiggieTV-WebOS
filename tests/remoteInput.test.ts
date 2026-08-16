import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusManager } from '../src/focus/FocusManager';
import {
  GlobalRemoteInputController,
  normalizeRemoteInput,
  type RemoteInputRecord
} from '../src/focus/remoteInput';

function createNode(id: string, left: number) {
  const node = document.createElement('button');
  node.id = id;
  node.getBoundingClientRect = () => ({
    left,
    right: left + 100,
    top: 0,
    bottom: 80,
    width: 100,
    height: 80,
    x: left,
    y: 0,
    toJSON: () => ({})
  });
  document.body.appendChild(node);
  return node;
}

function keyboardEvent(key: string, keyCode: number, repeat = false) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, repeat });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  Object.defineProperty(event, 'which', { value: keyCode });
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('remote input', () => {
  it('normalizes arrows, enter, and webOS Back key code 461', () => {
    expect(normalizeRemoteInput({ key: 'ArrowLeft', code: '', keyCode: 0, which: 0 })).toEqual({
      kind: 'move',
      direction: 'left',
      key: 'ArrowLeft'
    });
    expect(normalizeRemoteInput({ key: 'Enter', code: '', keyCode: 13, which: 13 })).toEqual({
      kind: 'activate',
      key: 'Enter'
    });
    expect(normalizeRemoteInput({ key: 'Unidentified', code: '', keyCode: 461, which: 461 })).toEqual({
      kind: 'back',
      key: 'Back'
    });
  });

  it('owns one capture listener and prevents arrow-key document scrolling', () => {
    const manager = new FocusManager();
    const left = createNode('left', 0);
    const right = createNode('right', 120);
    manager.setActiveRoute('home');
    manager.register({ id: 'left', routeId: 'home', ref: left });
    manager.register({ id: 'right', routeId: 'home', ref: right });
    const records: RemoteInputRecord[] = [];
    const addListener = vi.spyOn(window, 'addEventListener');
    const controller = new GlobalRemoteInputController({
      focusManager: manager,
      getRouteId: () => 'home',
      onInput: record => records.push(record)
    });

    expect(controller.start()).toBe(true);
    expect(controller.start()).toBe(true);
    const event = keyboardEvent('ArrowRight', 39);
    window.dispatchEvent(event);

    expect(addListener.mock.calls.filter(call => call[0] === 'keydown')).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    expect(manager.focusId).toBe('right');
    expect(records.at(-1)).toMatchObject({
      routeId: 'home',
      previousFocusId: 'left',
      nextFocusId: 'right',
      handled: true
    });
    controller.stop();
    addListener.mockRestore();
  });

  it('allows only one controller to own the target at a time', () => {
    const manager = new FocusManager();
    const conflict = vi.fn();
    const first = new GlobalRemoteInputController({ focusManager: manager });
    const second = new GlobalRemoteInputController({ focusManager: manager, onOwnershipConflict: conflict });

    expect(first.start()).toBe(true);
    expect(second.start()).toBe(false);
    expect(conflict).toHaveBeenCalledTimes(1);
    first.stop();
    expect(second.start()).toBe(true);
    second.stop();
  });

  it('returns pointer ownership to remote immediately for a directional event even when movement is filtered', () => {
    const manager = new FocusManager();
    const node = createNode('only', 0);
    manager.register({ id: 'only', ref: node });
    manager.recordPointerMovement(399, 200);
    manager.recordPointerMovement(400, 200);
    expect(manager.interactionMode).toBe('pointer');
    const controller = new GlobalRemoteInputController({
      focusManager: manager,
      shouldHandle: () => false
    });
    controller.start();

    window.dispatchEvent(keyboardEvent('ArrowDown', 40));

    expect(manager.interactionMode).toBe('remote');
    expect(manager.focusId).toBe('only');
    expect(manager.recordPointerMovement(401, 200)).toBe(false);
    expect(manager.interactionMode).toBe('remote');
    expect(manager.recordPointerMovement(402, 200)).toBe(true);
    expect(manager.interactionMode).toBe('pointer');
    controller.stop();
  });

  it('activates once and ignores repeated Enter events', () => {
    const manager = new FocusManager();
    const button = createNode('play', 0);
    const click = vi.fn();
    button.addEventListener('click', click);
    manager.register({ id: 'play', ref: button });
    const records: RemoteInputRecord[] = [];
    const controller = new GlobalRemoteInputController({
      focusManager: manager,
      onInput: record => records.push(record)
    });
    controller.start();

    window.dispatchEvent(keyboardEvent('Enter', 13));
    window.dispatchEvent(keyboardEvent('Enter', 13, true));

    expect(click).toHaveBeenCalledTimes(1);
    expect(records.at(-1)?.reason).toBe('repeat-ignored');
    controller.stop();
  });

  it('keeps remote ownership when Enter activates through a programmatic click', () => {
    const manager = new FocusManager();
    const button = createNode('play', 0);
    button.addEventListener('click', () => manager.focus('play', {
      reason: 'direct',
      inputKey: 'click'
    }));
    manager.register({ id: 'play', ref: button });
    const controller = new GlobalRemoteInputController({ focusManager: manager });
    controller.start();
    manager.recordPointerMovement(259, 140);
    manager.recordPointerMovement(260, 140);
    expect(manager.interactionMode).toBe('pointer');

    window.dispatchEvent(keyboardEvent('Enter', 13));

    expect(manager.interactionMode).toBe('remote');
    expect(manager.focusId).toBe('play');
    expect(document.activeElement).toBe(button);
    controller.stop();
  });

  it('allows directional holds only after a delay and at a controlled interval', () => {
    const manager = new FocusManager();
    const first = createNode('first', 0);
    const second = createNode('second', 120);
    const third = createNode('third', 240);
    const fourth = createNode('fourth', 360);
    manager.register({ id: 'first', ref: first });
    manager.register({ id: 'second', ref: second });
    manager.register({ id: 'third', ref: third });
    manager.register({ id: 'fourth', ref: fourth });
    let now = 0;
    const records: RemoteInputRecord[] = [];
    const controller = new GlobalRemoteInputController({
      focusManager: manager,
      allowDirectionalRepeat: true,
      repeatInitialDelayMs: 300,
      repeatIntervalMs: 120,
      now: () => now,
      onInput: record => records.push(record)
    });
    controller.start();

    window.dispatchEvent(keyboardEvent('ArrowRight', 39));
    expect(manager.focusId).toBe('second');
    now = 180;
    window.dispatchEvent(keyboardEvent('ArrowRight', 39, true));
    expect(manager.focusId).toBe('second');
    expect(records.at(-1)?.reason).toBe('repeat-ignored');
    now = 320;
    window.dispatchEvent(keyboardEvent('ArrowRight', 39, true));
    expect(manager.focusId).toBe('third');
    now = 380;
    window.dispatchEvent(keyboardEvent('ArrowRight', 39, true));
    expect(manager.focusId).toBe('third');
    now = 450;
    window.dispatchEvent(keyboardEvent('ArrowRight', 39, true));
    expect(manager.focusId).toBe('fourth');
    controller.stop();
  });

  it('routes webOS Back once and prevents native history handling', () => {
    const manager = new FocusManager();
    const onBack = vi.fn();
    const controller = new GlobalRemoteInputController({ focusManager: manager, onBack });
    controller.start();
    const event = keyboardEvent('Unidentified', 461);

    window.dispatchEvent(event);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    controller.stop();
  });

  it('leaves Backspace to an editable input instead of navigating away', () => {
    const manager = new FocusManager();
    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);
    manager.register({ id: 'password', ref: input });
    const onBack = vi.fn();
    const records: RemoteInputRecord[] = [];
    const controller = new GlobalRemoteInputController({
      focusManager: manager,
      onBack,
      onInput: record => records.push(record)
    });
    controller.start();
    const event = keyboardEvent('Backspace', 8);

    input.dispatchEvent(event);

    expect(onBack).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(records.at(-1)?.reason).toBe('filtered');
    controller.stop();
  });
});
