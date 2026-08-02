import type { PtvFocusDirection } from '../types/ptv';
import type { FocusManager, FocusNavigationResult } from './FocusManager';

export type RemoteInputAction =
  | { kind: 'move'; direction: PtvFocusDirection; key: string }
  | { kind: 'activate'; key: string }
  | { kind: 'back'; key: string };

export interface RemoteInputRecord {
  timestamp: number;
  action: RemoteInputAction;
  keyCode: number;
  repeat: boolean;
  routeId: string | null;
  previousFocusId: string | null;
  nextFocusId: string | null;
  handled: boolean;
  fallbackUsed: boolean;
  reason: 'handled' | 'repeat-ignored' | 'filtered' | 'unhandled';
}

export interface GlobalRemoteInputOptions {
  focusManager: FocusManager;
  onBack?: (event: KeyboardEvent) => void;
  onInput?: (record: RemoteInputRecord) => void;
  onOwnershipConflict?: () => void;
  getRouteId?: () => string | null;
  shouldHandle?: (event: KeyboardEvent, action: RemoteInputAction) => boolean;
  allowDirectionalRepeat?: boolean;
  repeatInitialDelayMs?: number;
  repeatIntervalMs?: number;
  now?: () => number;
  target?: Window;
}

const WEBOS_BACK_KEY_CODE = 461;
const owners = new WeakMap<EventTarget, GlobalRemoteInputController>();

function numericKeyCode(event: Pick<KeyboardEvent, 'keyCode' | 'which'>) {
  return Number(event.keyCode || event.which || 0);
}

function isEditableBackspace(event: KeyboardEvent, action: RemoteInputAction) {
  if (action.kind !== 'back') return false;
  const keyCode = numericKeyCode(event);
  if (keyCode !== 8 && event.key.toLowerCase() !== 'backspace') return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (!(target instanceof HTMLInputElement)) return false;
  const nonTextTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
  return !target.disabled && !target.readOnly && !nonTextTypes.has(target.type.toLowerCase());
}

export function normalizeRemoteInput(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'which'>
): RemoteInputAction | null {
  const key = String(event.key || '').trim();
  const code = String(event.code || '').trim();
  const keyCode = numericKeyCode(event);
  const candidate = key || code;

  if (candidate === 'ArrowUp' || keyCode === 38) {
    return { kind: 'move', direction: 'up', key: 'ArrowUp' };
  }
  if (candidate === 'ArrowDown' || keyCode === 40) {
    return { kind: 'move', direction: 'down', key: 'ArrowDown' };
  }
  if (candidate === 'ArrowLeft' || keyCode === 37) {
    return { kind: 'move', direction: 'left', key: 'ArrowLeft' };
  }
  if (candidate === 'ArrowRight' || keyCode === 39) {
    return { kind: 'move', direction: 'right', key: 'ArrowRight' };
  }
  if (candidate === 'Enter' || candidate === 'NumpadEnter' || keyCode === 13) {
    return { kind: 'activate', key: 'Enter' };
  }

  const normalizedKey = candidate.toLowerCase();
  if (
    keyCode === WEBOS_BACK_KEY_CODE ||
    keyCode === 8 ||
    keyCode === 27 ||
    normalizedKey === 'backspace' ||
    normalizedKey === 'escape' ||
    normalizedKey === 'browserback' ||
    normalizedKey === 'goback' ||
    normalizedKey === 'webosback' ||
    normalizedKey === 'xf86back'
  ) {
    return { kind: 'back', key: keyCode === WEBOS_BACK_KEY_CODE ? 'Back' : candidate || 'Back' };
  }

  return null;
}

export class GlobalRemoteInputController {
  private options: GlobalRemoteInputOptions;
  private attachedTarget: Window | null = null;
  private directionalHold: { key: string; startedAt: number; lastHandledAt: number } | null = null;

  public constructor(options: GlobalRemoteInputOptions) {
    this.options = options;
  }

  public updateOptions(options: GlobalRemoteInputOptions) {
    this.options = options;
  }

  public start() {
    const target = this.options.target ?? (typeof window !== 'undefined' ? window : null);
    if (!target) return false;
    if (this.attachedTarget === target) return true;

    const existingOwner = owners.get(target);
    if (existingOwner && existingOwner !== this) {
      this.options.onOwnershipConflict?.();
      return false;
    }

    if (this.attachedTarget) {
      this.stop();
    }
    owners.set(target, this);
    target.addEventListener('keydown', this.onKeyDown, true);
    this.attachedTarget = target;
    return true;
  }

  public stop() {
    const target = this.attachedTarget;
    if (!target) return;
    target.removeEventListener('keydown', this.onKeyDown, true);
    if (owners.get(target) === this) {
      owners.delete(target);
    }
    this.attachedTarget = null;
    this.directionalHold = null;
  }

  public get isStarted() {
    return this.attachedTarget !== null;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const action = normalizeRemoteInput(event);
    if (!action) return;

    const routeId = this.options.getRouteId?.() ?? this.options.focusManager.activeRoute;
    const previousFocusId = this.options.focusManager.focusId;
    const keyCode = numericKeyCode(event);
    const now = this.options.now?.() ?? Date.now();
    const baseRecord = {
      timestamp: now,
      action,
      keyCode,
      repeat: event.repeat,
      routeId,
      previousFocusId
    };

    if (isEditableBackspace(event, action)) {
      this.options.onInput?.({
        ...baseRecord,
        nextFocusId: previousFocusId,
        handled: false,
        fallbackUsed: false,
        reason: 'filtered'
      });
      return;
    }

    let repeatedDirection = false;
    if (action.kind === 'move' && !event.repeat) {
      this.directionalHold = { key: action.key, startedAt: now, lastHandledAt: now };
    } else if (action.kind === 'move' && event.repeat && this.options.allowDirectionalRepeat === true) {
      const initialDelay = Math.max(100, this.options.repeatInitialDelayMs ?? 360);
      const interval = Math.max(80, this.options.repeatIntervalMs ?? 140);
      const hold = this.directionalHold;
      repeatedDirection = Boolean(
        hold &&
        hold.key === action.key &&
        now - hold.startedAt >= initialDelay &&
        now - hold.lastHandledAt >= interval
      );
      if (repeatedDirection && hold) hold.lastHandledAt = now;
    } else if (action.kind !== 'move') {
      this.directionalHold = null;
    }

    if (event.repeat && !repeatedDirection) {
      this.consume(event);
      this.options.onInput?.({
        ...baseRecord,
        nextFocusId: previousFocusId,
        handled: false,
        fallbackUsed: false,
        reason: 'repeat-ignored'
      });
      return;
    }

    if (this.options.shouldHandle && !this.options.shouldHandle(event, action)) {
      this.options.onInput?.({
        ...baseRecord,
        nextFocusId: previousFocusId,
        handled: false,
        fallbackUsed: false,
        reason: 'filtered'
      });
      return;
    }

    this.consume(event);

    let handled = true;
    let result: FocusNavigationResult | null = null;
    if (action.kind === 'move') {
      result = this.options.focusManager.move(action.direction, {
        inputKey: action.key,
        routeId,
        reason: 'directional'
      });
    } else if (action.kind === 'activate') {
      handled = this.options.focusManager.activateCurrent({
        inputKey: action.key,
        routeId,
        reason: 'activate'
      });
    } else if (this.options.onBack) {
      this.options.onBack(event);
    } else {
      handled = false;
    }

    this.options.onInput?.({
      ...baseRecord,
      nextFocusId: result?.current ?? this.options.focusManager.focusId,
      handled,
      fallbackUsed: result?.transition?.fallbackUsed ?? false,
      reason: handled ? 'handled' : 'unhandled'
    });
  };

  private consume(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }
}
