function isIpV4(hostname: string) {
  const [a, b, c, d] = hostname.split('.');
  if (!a || !b || !c || !d) return false;
  const segments = [a, b, c, d];
  return segments.every(segment => {
    if (!/^\d{1,3}$/.test(segment)) return false;
    const value = Number(segment);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isPrivateHost(hostname: string) {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.endsWith('.local') ||
    /^10\./.test(lower) ||
    /^192\.168\./.test(lower) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(lower) ||
    /^10\.0\.0\./.test(lower) ||
    isIpV4(lower)
  );
}

function sanitizeInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Server URL is required.');
  const noHash = trimmed.includes('#') ? trimmed.slice(0, trimmed.indexOf('#')) : trimmed;
  const withoutQuery = noHash.includes('?') ? noHash.slice(0, noHash.indexOf('?')) : noHash;
  return withoutQuery.trim();
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(value);
}

function looksLikeSchemeValue(value: string): boolean {
  const isSchemeLike = /^[a-z][a-z\d+\-.]*:(?!\d)/i.test(value);
  return !value.includes('@') && isSchemeLike && !hasScheme(value);
}

function looksLikeIPv6(candidate: string) {
  return candidate.includes(':') && candidate.includes('::');
}

function hostForProtocolSelection(candidate: string) {
  const hostPart = candidate.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
  const afterAuth = hostPart.includes('@') ? hostPart.split('@').pop() || '' : hostPart;
  if (!afterAuth) return '';
  if (looksLikeIPv6(afterAuth)) {
    if (afterAuth.startsWith('[') && afterAuth.includes(']')) {
      return afterAuth.slice(1, afterAuth.indexOf(']'));
    }
    return afterAuth;
  }
  return afterAuth.split(':')[0] || '';
}

function ensureIPv6Candidate(candidate: string, protocol: 'http' | 'https') {
  if (!looksLikeIPv6(candidate) || candidate.includes('://[')) return candidate;

  const withNoScheme = candidate.replace(/^[a-z][a-z\d+\-.]*:\/\//i, '');
  const [hostAndPort = '', ...rest] = withNoScheme.split('/');
  const lastColon = hostAndPort.lastIndexOf(':');
  if (lastColon <= 0) {
    return `${protocol}://[${hostAndPort}]${rest.length ? `/${rest.join('/')}` : ''}`;
  }

  const possiblePort = hostAndPort.slice(lastColon + 1);
  const hasMultipleSegments = hostAndPort.split(':').length > 2;
  const needsPort = possiblePort !== '' && !hasMultipleSegments && /^\d{1,5}$/.test(possiblePort);
  if (needsPort) {
    const hostPart = hostAndPort.slice(0, lastColon);
    return `${protocol}://[${hostPart}]:${possiblePort}${rest.length ? `/${rest.join('/')}` : ''}`;
  }

  return `${protocol}://[${hostAndPort}]${rest.length ? `/${rest.join('/')}` : ''}`;
}

function protocolForHost(hostname: string) {
  return isPrivateHost(hostname) ? 'http' : 'https';
}

function validatePort(authority: string) {
  if (!authority) return;

  const hostPort = authority.includes('@') ? authority.split('@').pop() || '' : authority;
  if (!hostPort || looksLikeIPv6(hostPort)) return;

  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) {
      throw new Error('Server URL is not valid.');
    }
    const suffix = hostPort.slice(close + 1);
    if (!suffix) return;
    if (!suffix.startsWith(':')) {
      throw new Error('Server URL is not valid.');
    }
    const portText = suffix.slice(1);
    if (!portText || !/^\d{1,5}$/.test(portText)) {
      throw new Error('Server port is invalid.');
    }
    return;
  }

  const segments = hostPort.split(':');
  if (segments.length === 1) return;
  if (segments.length > 2) {
    throw new Error('Server URL is not valid.');
  }

  const portText = segments[1];
  if (!portText || !/^\d{1,5}$/.test(portText)) {
    throw new Error('Server port is invalid.');
  }
}

export function normalizeServerUrl(value: string): string {
  const sanitized = sanitizeInput(value);
  const candidate = sanitized;

  if (looksLikeSchemeValue(candidate)) {
    throw new Error('Server URL must use http:// or https://');
  }

  const hasExplicitScheme = hasScheme(candidate);
  const protocol =
    hasExplicitScheme &&
    (candidate.toLowerCase().startsWith('http://') || candidate.toLowerCase().startsWith('https://'))
      ? candidate.slice(0, candidate.indexOf(':'))
      : null;

  if (hasExplicitScheme && protocol === null) {
    throw new Error('Server URL must use http:// or https://');
  }

  const authority =
    (hasExplicitScheme ? candidate.replace(/^[a-z][a-z\d+\-.]*:\/\//i, '') : candidate).split('/')[0] ?? '';
  validatePort(authority);

  const fallbackProtocol = protocolForHost(hostForProtocolSelection(candidate));
  const withScheme = hasExplicitScheme
    ? candidate
    : `${fallbackProtocol}://${candidate}`;
  const normalizedIPv6 = hasExplicitScheme ? withScheme : ensureIPv6Candidate(withScheme, fallbackProtocol);

  let parsed: URL;
  try {
    parsed = new URL(normalizedIPv6);
  } catch {
    throw new Error('Server URL is not valid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server URL must use http:// or https://');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Server URL must not include credentials.');
  }

  if (!parsed.hostname) {
    throw new Error('Server URL is not valid.');
  }

  const port = parsed.port;
  if (port) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error('Server port is invalid.');
    }
  }

  const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/g, '') : '';
  const normalizedPath = pathname.replace(/\/{2,}/g, '/');
  return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
}

export function normalizeQueryServerUrl(value: string): string {
  return normalizeServerUrl(value);
}
