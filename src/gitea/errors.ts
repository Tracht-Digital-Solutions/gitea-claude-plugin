import { redact } from '../security/redact.js';

/** Stable, machine-readable error codes returned by every tool. */
export type GiteaErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'TLS_ERROR'
  | 'REDIRECT_BLOCKED'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'CANCELLED'
  | 'GIT_ERROR'
  | 'HTTP_ERROR';

export interface GiteaErrorOptions {
  status?: number | undefined;
  hint?: string | undefined;
  details?: unknown;
  retryAfterSeconds?: number | undefined;
  cause?: unknown;
}

/**
 * Structured error used throughout the server. Messages are redacted on construction so that a
 * token can never leak through an error, a stack trace or a tool result.
 */
export class GiteaError extends Error {
  readonly code: GiteaErrorCode;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: GiteaErrorCode, message: string, options: GiteaErrorOptions = {}) {
    super(redact(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GiteaError';
    this.code = code;
    this.status = options.status;
    this.hint = options.hint === undefined ? undefined : redact(options.hint);
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.status !== undefined) out.status = this.status;
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.retryAfterSeconds !== undefined) out.retryAfterSeconds = this.retryAfterSeconds;
    if (this.details !== undefined) out.details = JSON.parse(redact(JSON.stringify(this.details))) as unknown;
    return out;
  }
}

/** Extracts the human readable message Gitea puts into error bodies. */
export function giteaMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim().slice(0, 500) || undefined;
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    const msg = rec.message ?? rec.error ?? rec.errors;
    if (typeof msg === 'string') return msg;
    if (Array.isArray(msg)) return msg.map(String).join('; ');
  }
  return undefined;
}

/** Maps an HTTP error status from Gitea to a structured error with an actionable hint. */
export function errorFromResponse(
  status: number,
  body: unknown,
  context: { method: string; path: string; retryAfterSeconds?: number | undefined },
): GiteaError {
  const apiMessage = giteaMessage(body);
  const where = `${context.method} ${context.path}`;
  const suffix = apiMessage ? `: ${apiMessage}` : '';
  switch (status) {
    case 400:
      return new GiteaError('INVALID_INPUT', `Gitea rejected the request (${where})${suffix}`, {
        status,
        details: body,
      });
    case 401:
      return new GiteaError('UNAUTHORIZED', `Authentication failed (${where})${suffix}`, {
        status,
        hint: 'The API token is missing, invalid, expired or revoked. Create a new token in Gitea under Settings → Applications and update it with `/plugin` → gitea → Configure (or `claude plugin configure gitea`).',
      });
    case 403: {
      const scope = apiMessage && /scope/i.test(apiMessage);
      return new GiteaError('FORBIDDEN', `Access denied (${where})${suffix}`, {
        status,
        hint: scope
          ? 'The token lacks a required scope. Create a token that includes the scope named in the message.'
          : 'The authenticated user does not have permission for this action on this resource.',
      });
    }
    case 404:
      return new GiteaError('NOT_FOUND', `Not found (${where})${suffix}`, {
        status,
        hint: 'Check owner, repository, number and ref. Private resources also return 404 when the token has no access. If the resource exists, this Gitea version may not support the endpoint.',
      });
    case 405:
      return new GiteaError('UNSUPPORTED', `Method not allowed (${where})${suffix}`, {
        status,
        hint: 'This Gitea instance does not support this operation (feature disabled or version too old).',
      });
    case 409:
      return new GiteaError('CONFLICT', `Conflict (${where})${suffix}`, {
        status,
        hint: 'The resource already exists or was changed concurrently (e.g. a stale file SHA, an existing branch, a merge conflict). Re-read the current state and retry.',
      });
    case 422:
      return new GiteaError('VALIDATION_FAILED', `Validation failed (${where})${suffix}`, {
        status,
        details: body,
      });
    case 423:
      return new GiteaError('CONFLICT', `Resource is locked (${where})${suffix}`, { status });
    case 429:
      return new GiteaError('RATE_LIMITED', `Rate limit exceeded (${where})${suffix}`, {
        status,
        retryAfterSeconds: context.retryAfterSeconds,
        hint: 'Gitea throttled the request. Wait and retry later.',
      });
    default:
      if (status >= 500) {
        return new GiteaError('SERVER_ERROR', `Gitea server error ${status} (${where})${suffix}`, {
          status,
          hint: 'The Gitea server failed to process the request. Retry later or check the server logs.',
        });
      }
      return new GiteaError('HTTP_ERROR', `Unexpected HTTP ${status} (${where})${suffix}`, { status });
  }
}

/** Converts arbitrary thrown values into a GiteaError without leaking secrets. */
export function toGiteaError(err: unknown): GiteaError {
  if (err instanceof GiteaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new GiteaError('HTTP_ERROR', message);
}

/** True for a GiteaError with the given code. */
export function isGiteaError(err: unknown, ...codes: GiteaErrorCode[]): err is GiteaError {
  return err instanceof GiteaError && (codes.length === 0 || codes.includes(err.code));
}

/**
 * Awaits `promise` and maps a NOT_FOUND error to `undefined`. Use it where "does not exist" is a
 * normal answer (existence checks, optional resources); every other error is re-thrown.
 */
export async function ifFound<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (isGiteaError(err, 'NOT_FOUND')) return undefined;
    throw err;
  }
}
