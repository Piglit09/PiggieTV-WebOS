const QUERY_SECRET = /([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|password|code)=)[^&\s"'#]+/gi;
const BEARER_SECRET = /(\bBearer\s+)[^\s,;"']+/gi;
const NAMED_SECRET = /(\b(?:token|access[_-]?token|api[_-]?key|apikey|authorization|password|secret|code)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&\]]+)/gi;
const JSON_SECRET = /(["'](?:token|access[_-]?token|api[_-]?key|apikey|authorization|password|secret|code)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const QUERY_USER_IDENTIFIER = /([?&]user[_-]?id=)([^&\s"'#]+)/gi;
const JSON_USER_IDENTIFIER = /(["']user[_-]?id["']\s*:\s*)(["'])([^"']*)\2/gi;
const NAMED_USER_IDENTIFIER = /(\buser[_-]?id\b\s*[:=]\s*)([^\s,;}&\]]+)/gi;
const RESOURCE_IDENTIFIER = /(\b(?:Users|Items|Videos)\/)([A-Za-z0-9-]{8,})(?=\/|[?&#\s"']|$)/gi;

function identifierSuffix(identifier: string) {
  return identifier.length > 4 ? `...${identifier.slice(-4)}` : '[redacted]';
}

/** Redacts credentials from errors, request records, and exported diagnostics. */
export function redactSensitiveText(value: string) {
  return value
    .replace(QUERY_SECRET, '$1***redacted***')
    .replace(BEARER_SECRET, '$1***redacted***')
    .replace(JSON_SECRET, '$1"***redacted***"')
    .replace(NAMED_SECRET, '$1***redacted***')
    .replace(QUERY_USER_IDENTIFIER, (_match, prefix: string, identifier: string) => (
      `${prefix}${identifierSuffix(identifier)}`
    ))
    .replace(JSON_USER_IDENTIFIER, (_match, prefix: string, quote: string, identifier: string) => (
      `${prefix}${quote}${identifierSuffix(identifier)}${quote}`
    ))
    .replace(NAMED_USER_IDENTIFIER, (_match, prefix: string, identifier: string) => (
      `${prefix}${identifierSuffix(identifier)}`
    ))
    .replace(RESOURCE_IDENTIFIER, (_match, prefix: string, identifier: string) => (
      `${prefix}${identifierSuffix(identifier)}`
    ));
}
