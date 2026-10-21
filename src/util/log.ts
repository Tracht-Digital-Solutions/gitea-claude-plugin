import { redact } from '../security/redact.js';

/**
 * Minimal stderr logger. stdout is reserved for the MCP stdio protocol, so nothing may ever be
 * written there. Every line is redacted.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.GITEA_LOG_LEVEL ?? 'warn').toLowerCase();
  return (ORDER as Partial<Record<string, number>>)[env] ?? ORDER.warn;
}

function write(level: Level, message: string): void {
  if (ORDER[level] < threshold()) return;
  process.stderr.write(`[gitea-mcp] ${level.toUpperCase()} ${redact(message)}\n`);
}

export const log = {
  debug: (m: string) => {
    write('debug', m);
  },
  info: (m: string) => {
    write('info', m);
  },
  warn: (m: string) => {
    write('warn', m);
  },
  error: (m: string) => {
    write('error', m);
  },
};
