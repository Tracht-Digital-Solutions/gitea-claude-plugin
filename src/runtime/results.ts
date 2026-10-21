import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GiteaError, toGiteaError } from '../gitea/errors.js';
import { redact } from '../security/redact.js';
import { log } from '../util/log.js';

/** Upper bound for one tool result; keeps a single call from flooding the model's context. */
export const MAX_RESULT_CHARS = 150_000;

/** Serialises a tool result as redacted JSON, truncated to MAX_RESULT_CHARS. */
export function successResult(value: unknown): CallToolResult {
  const json = JSON.stringify(value, null, 1) as string | undefined;
  let text = redact(json ?? 'null');
  if (text.length > MAX_RESULT_CHARS) {
    const rest = text.length - MAX_RESULT_CHARS;
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [output truncated: ${rest} more characters; narrow the request with limit/page/filters]`;
  }
  return { content: [{ type: 'text', text }] };
}

/** Converts any thrown value into a redacted `{ error: {...} }` result with isError set. */
export function errorResult(err: unknown): CallToolResult {
  if (!(err instanceof GiteaError)) {
    log.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  const text = redact(JSON.stringify({ error: toGiteaError(err).toJSON() }, null, 1));
  return { isError: true, content: [{ type: 'text', text }] };
}
