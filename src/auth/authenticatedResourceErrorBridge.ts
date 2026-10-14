/**
 * Resource elements do not expose their HTTP response status to application
 * JavaScript. A failed image or media load therefore prompts a bounded
 * authenticated validation request; the shared Jellyfin transport remains the
 * only code allowed to classify and publish a current-session HTTP 401.
 */

export interface AuthenticatedResourceSession {
  readonly userId: string;
  readonly credentialEpoch: number;
}

export interface AuthenticatedResourceValidationClient {
  validateSession(
    userId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<unknown>;
}

export interface AuthenticatedResourceErrorBridgeOptions {
  readonly getCurrentSession: () => AuthenticatedResourceSession | null;
  readonly getAuthenticatedClient: () => AuthenticatedResourceValidationClient;
  readonly eventTarget?: EventTarget;
  readonly throttleMs?: number;
  readonly validationTimeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_THROTTLE_MS = 5_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 5_000;

interface PendingValidation {
  readonly credentialEpoch: number;
  readonly promise: Promise<void>;
}

function isImageOrMediaElement(target: EventTarget | null): boolean {
  const tagName = (target as { tagName?: unknown } | null)?.tagName;
  if (typeof tagName !== 'string') return false;
  const normalizedTagName = tagName.toUpperCase();
  return normalizedTagName === 'IMG' || normalizedTagName === 'VIDEO' || normalizedTagName === 'AUDIO';
}

function isUsableSession(session: AuthenticatedResourceSession | null): session is AuthenticatedResourceSession {
  return Boolean(
    session &&
    session.userId.trim() &&
    Number.isFinite(session.credentialEpoch) &&
    session.credentialEpoch > 0
  );
}

/**
 * Attaches one capture-phase resource error listener. The returned function
 * detaches it. Validation failures are deliberately swallowed here: HTTP 401
 * publication belongs to the authenticated transport and all other failures
 * (including 404 artwork and connectivity loss) must preserve the session.
 */
export function attachAuthenticatedResourceErrorBridge(
  options: AuthenticatedResourceErrorBridgeOptions
): () => void {
  const eventTarget = options.eventTarget ?? window;
  const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
  const validationTimeoutMs = Math.max(
    1,
    options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS
  );
  const now = options.now ?? Date.now;
  let attached = true;
  let pending: PendingValidation | null = null;
  let lastStarted: { credentialEpoch: number; at: number } | null = null;

  const onResourceError = (event: Event) => {
    if (!attached || !isImageOrMediaElement(event.target)) return;

    let session: AuthenticatedResourceSession | null;
    try {
      session = options.getCurrentSession();
    } catch {
      return;
    }
    if (!isUsableSession(session)) return;

    if (pending?.credentialEpoch === session.credentialEpoch) return;
    const startedAt = now();
    if (
      lastStarted?.credentialEpoch === session.credentialEpoch &&
      startedAt - lastStarted.at < throttleMs
    ) {
      return;
    }

    let client: AuthenticatedResourceValidationClient;
    let validation: Promise<unknown>;
    try {
      client = options.getAuthenticatedClient();
      // Calling synchronously lets the shared client capture the exact current
      // credential epoch before a later login/logout can supersede this probe.
      validation = client.validateSession(session.userId, validationTimeoutMs);
    } catch {
      return;
    }

    lastStarted = { credentialEpoch: session.credentialEpoch, at: startedAt };
    let validationPromise: Promise<void>;
    validationPromise = Promise.resolve(validation).then(
      () => undefined,
      () => undefined
    ).then(() => {
      if (pending?.promise === validationPromise) pending = null;
    });
    pending = {
      credentialEpoch: session.credentialEpoch,
      promise: validationPromise
    };
  };

  eventTarget.addEventListener('error', onResourceError, true);
  return () => {
    if (!attached) return;
    attached = false;
    eventTarget.removeEventListener('error', onResourceError, true);
  };
}
