import React from 'react';
import { FocusableButton } from './FocusableButton';

export function ErrorBanner({ message, onRetry, onBack }: {
  message: string;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="ptv-error">
      <p>{message}</p>
      <div className="ptv-error__actions">
        {onRetry ? <FocusableButton focusId="error-retry" onClick={onRetry}>Retry</FocusableButton> : null}
        {onBack ? <FocusableButton focusId="error-back" onClick={onBack}>Back</FocusableButton> : null}
      </div>
    </div>
  );
}
