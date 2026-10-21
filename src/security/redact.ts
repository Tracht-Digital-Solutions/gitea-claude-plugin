/**
 * Central secret redaction. Every secret the server learns (API tokens, webhook secrets) is
 * registered here, and every string that leaves the process — logs, errors, tool results —
 * passes through `redact`.
 */

const secrets = new Set<string>();
const MIN_SECRET_LENGTH = 6;

export const REDACTED = '[REDACTED]';

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length >= MIN_SECRET_LENGTH) secrets.add(trimmed);
}

/** Only for tests. */
export function clearSecrets(): void {
  secrets.clear();
}

const PATTERNS: [RegExp, string][] = [
  // Authorization headers and token query parameters.
  [/(authorization["']?\s*[:=]\s*["']?)(token|bearer|basic)\s+[^\s"',;]+/gi, `$1$2 ${REDACTED}`],
  [/([?&](?:access_token|token|private_token)=)[^&#\s"']+/gi, `$1${REDACTED}`],
  // Credentials embedded in URLs: https://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`],
  // JSON-ish secret fields.
  [/("(?:token|sha1|secret|password|access_token)"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`],
];

export function redact(input: string): string {
  let out = input;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-redacts a JSON-serialisable value. */
export function redactValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
