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
  onMouseEnter,
  onMouseLeave,
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
        manager.focus(focusId, { reason: 'pointer', inputKey: 'click', routeId });
        onClick?.(event);
      }}
      onFocus={event => {
        manager.focus(focusId, { reason: 'dom-focus', routeId });
        onFocus?.(event);
      }}
      onMouseEnter={event => {
        manager.setPointerFocusActive(true);
        manager.focus(focusId, { reason: 'pointer', inputKey: 'pointer', routeId });
        onMouseEnter?.(event);
      }}
      onMouseLeave={event => {
        manager.setPointerFocusActive(false);
        onMouseLeave?.(event);
      }}
      tabIndex={-1}
    />
  );
}
