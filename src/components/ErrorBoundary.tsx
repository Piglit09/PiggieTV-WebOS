import type { ReactNode } from 'react';
import { Component } from 'react';
import { DiagnosticsService } from '../core/diagnostics';
import { redactSensitiveText } from '../core/redaction';
import { FocusableButton } from './FocusableButton';

interface ErrorBoundaryState {
  errorId: string | null;
  message: string;
  showFallback: boolean;
}

interface ErrorBoundaryProps {
  diagnostics?: DiagnosticsService | null;
  onRestart?: () => void;
  onBack?: () => void;
  onOpenDiagnostics?: () => void;
  children: ReactNode;
}

function createErrorId() {
  return `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function redactText(value: string) {
  return redactSensitiveText(value);
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorId: null,
    message: '',
    showFallback: false
  };

  private static seenIds = new Set<string>();

  componentDidCatch(error: unknown, info: unknown) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const details = `${message}\n${info && typeof info === 'object' ? JSON.stringify(info) : ''}`.trim();
    const redacted = redactText(details);
    const errorId = createErrorId();

    const fingerprint = redacted.toLowerCase();
    if (!ErrorBoundary.seenIds.has(fingerprint)) {
      ErrorBoundary.seenIds.add(fingerprint);
      this.props.diagnostics?.logError('Uncaught render error', redacted);
    }

    this.setState({
      errorId,
      message: redacted || 'Application render failed',
      showFallback: true
    });
  }

  reset = () => {
    this.setState({
      errorId: null,
      message: '',
      showFallback: false
    });
  };

  render() {
    if (!this.state.showFallback) {
      return this.props.children;
    }

    return (
      <div className="ptv-error-boundary ptv-section">
        <h1>Application Error</h1>
        <p className="ptv-error">The interface hit an unexpected condition.</p>
        <p>Reference ID: {this.state.errorId}</p>
        <pre>{this.state.message}</pre>
        <div className="ptv-row">
          <FocusableButton
            focusId="error-restart"
            onClick={() => {
              this.reset();
              this.props.onRestart?.();
            }}
          >
            Restart
          </FocusableButton>
          {this.props.onBack ? (
            <FocusableButton
              focusId="error-back"
              onClick={() => {
                this.reset();
                this.props.onBack?.();
              }}
            >
              Back
            </FocusableButton>
          ) : null}
          {this.props.onOpenDiagnostics ? (
            <FocusableButton
              focusId="error-diagnostics"
              onClick={() => {
                this.reset();
                this.props.onOpenDiagnostics?.();
              }}
            >
              Diagnostics
            </FocusableButton>
          ) : null}
        </div>
      </div>
    );
  }
}
