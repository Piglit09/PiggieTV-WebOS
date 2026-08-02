const QUERY_SECRET = /([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|password|code)=)[^&\s"'#]+/gi;
const BEARER_SECRET = /(\bBearer\s+)[^\s,;"']+/gi;
const NAMED_SECRET = /(\b(?:token|access[_-]?token|api[_-]?key|apikey|authorization|password|secret|code)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&\]]+)/gi;
const JSON_SECRET = /(["'](?:token|access[_-]?token|api[_-]?key|apikey|authorization|password|secret|code)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

/** Redacts credentials from errors, request records, and exported diagnostics. */
export function redactSensitiveText(value: string) {
  return value
    .replace(QUERY_SECRET, '$1***redacted***')
    .replace(BEARER_SECRET, '$1***redacted***')
    .replace(JSON_SECRET, '$1"***redacted***"')
    .replace(NAMED_SECRET, '$1***redacted***');
}
