import React, { useEffect, useRef, useState } from 'react';
import { FocusManager } from '../focus/FocusManager';
import { toRouteString } from '../navigation/router';
import { useApp } from '../state/appContext';

interface FocusableInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  focusId: string;
  focusGroup?: string;
  preferredRow?: string;
  focusRouteId?: string;
}

export function FocusableInput({
  focusId,
  focusGroup,
  preferredRow,
  focusRouteId,
  className,
  onClick,
  onFocus,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  onMouseMove,
  disabled,
  ...props
}: FocusableInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const { state, services } = useApp();
  const manager = services.focusManager as FocusManager;
  const routeId = focusRouteId ?? toRouteString(state.route);
  const [isActive, setIsActive] = useState(manager.focusId === focusId);

  useEffect(() => manager.subscribe(current => {
    setIsActive(current === focusId);
  }), [focusId, manager]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    return manager.register({
      id: focusId,
      group: focusGroup,
      preferredRow,
      routeId,
      ref: node
    });
  }, [focusId, focusGroup, preferredRow, routeId, manager, disabled]);

  return (
    <input
      {...props}
      disabled={disabled}
      ref={ref}
      data-focus-id={focusId}
      data-focus-route={routeId}
      className={`ptv-focusable ${isActive ? 'is-focused' : ''} ${className ?? ''}`.trim()}
      onClick={event => {
        if (event.detail > 0) {
          manager.recordPointerMovement(event.clientX, event.clientY, event.timeStamp);
          manager.claimPointerInteraction();
        }
        if (manager.interactionMode === 'pointer') {
          manager.focusFromPointer(focusId, { inputKey: 'click', routeId });
        } else {
          manager.focus(focusId, { reason: 'direct', inputKey: 'click', routeId });
        }
        onClick?.(event);
      }}
      onFocus={event => {
        manager.handleDomFocus(focusId, { reason: 'dom-focus', routeId });
        onFocus?.(event);
      }}
      onMouseDown={event => {
        manager.recordPointerMovement(event.clientX, event.clientY, event.timeStamp);
        manager.claimPointerInteraction();
        manager.focusFromPointer(focusId, { inputKey: 'pointer-down', routeId });
        onMouseDown?.(event);
      }}
      onMouseEnter={event => {
        onMouseEnter?.(event);
      }}
      onMouseLeave={event => {
        onMouseLeave?.(event);
      }}
      onMouseMove={event => {
        const pointerMoved = manager.recordPointerMovement(
          event.clientX,
          event.clientY,
          event.timeStamp
        );
        // Hovering a text input must not open LG's virtual keyboard. A real
        // mouse-down/click below still gives the input native focus.
        if (pointerMoved && document.activeElement === event.currentTarget) {
          manager.focusFromPointer(focusId, { inputKey: 'pointer-move', routeId });
        }
        onMouseMove?.(event);
      }}
      tabIndex={-1}
    />
  );
}
