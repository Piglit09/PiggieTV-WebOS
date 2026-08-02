import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '../src/core/diagnostics';
import { redactSensitiveText } from '../src/core/redaction';

describe('diagnostics', () => {
  it('redacts server url and user id', () => {
    const diagnostics = new DiagnosticsService();
    const snapshot = diagnostics.snapshot({
      appVersion: '0.1.0',
      buildTimestamp: '2026-01-01T00:00:00Z',
      mode: 'development',
      route: 'home',
      focusId: null,
      previousFocusId: null,
      serverUrl: 'https://user:pass@stream.piggietv.com',
      serverVersion: '10.9.0',
      userId: '0123456789abcdef',
      capabilities: ['quick-connect'],
      lastLifecycleEvent: 'booted'
    });
    expect(snapshot.serverUrl).not.toContain('user:pass');
    expect(snapshot.userId).toContain('012345');
    expect(snapshot.userId).not.toBe('0123456789abcdef');
  });

  it('tracks logs', () => {
    const diagnostics = new DiagnosticsService();
    diagnostics.logError('token invalid', { token: 'abc' });
    const [entry] = diagnostics.getRecentLogs();
    expect(diagnostics.getRecentLogs().length).toBe(1);
    expect(entry.message).toBe('token invalid');
    expect(entry.details).toContain('token');
    expect(entry.details).not.toContain('abc');
  });

  it('redacts URL, bearer, authorization, password, and playback error secrets end to end', () => {
    const secret = 'never-export-this';
    const diagnosticText = redactSensitiveText(
      `https://server/stream?api_key=${secret} Bearer ${secret} Authorization="Token=${secret}" password=${secret}`
    );
    expect(diagnosticText).not.toContain(secret);

    const diagnostics = new DiagnosticsService();
    diagnostics.recordPlaybackError(`Playback failed at /stream?token=${secret}`);
    diagnostics.logError(`Authorization: Bearer ${secret}`);
    const snapshot = diagnostics.snapshot({
      appVersion: '0.1.0',
      buildTimestamp: '2026-01-01T00:00:00Z',
      mode: 'development',
      route: 'playback:item',
      focusId: null,
      previousFocusId: null,
      serverUrl: 'https://piggietv.com',
      capabilities: []
    });
    expect(diagnostics.toDiagnosticText(snapshot)).not.toContain(secret);
    expect(JSON.stringify(diagnostics.getRecentLogs())).not.toContain(secret);
  });
});
