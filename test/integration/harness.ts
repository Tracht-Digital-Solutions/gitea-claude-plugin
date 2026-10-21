import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config/config.js';
import type { HttpMethod } from '../../src/gitea/http.js';
import { GiteaMcpServer } from '../../src/server.js';
import { isLoopbackHost } from '../../src/security/url.js';

export interface ItEnv {
  url: string;
  token: string;
  username: string;
  password: string;
  version: string;
  runner: boolean;
}

/**
 * Loads the credentials of the throwaway instance created by scripts/gitea-test-env.mjs.
 * Integration tests refuse to run against anything that is not a loopback address, so they can
 * never modify a real Gitea instance by accident.
 */
export function loadItEnv(): ItEnv | undefined {
  if (!existsSync('.gitea-test/env.json')) return undefined;
  const env = JSON.parse(readFileSync('.gitea-test/env.json', 'utf8')) as ItEnv;
  const host = new URL(env.url).hostname;
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing to run integration tests against non-loopback host ${host}.`);
  }
  return env;
}

export const recorded: { method: HttpMethod; url: URL }[] = [];
export const calledTools = new Set<string>();

export interface Harness {
  client: Client;
  server: GiteaMcpServer;
  call<T = Record<string, any>>(name: string, args?: Record<string, unknown>): Promise<T>;
  fail(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ code: string; message: string; hint?: string; status?: number }>;
  close(): Promise<void>;
}

export async function harness(
  env: ItEnv,
  opts: { cwd?: string; token?: string; extraEnv?: Record<string, string>; elicitation?: boolean } = {},
): Promise<Harness> {
  const config = loadConfig({
    GITEA_URL: env.url,
    GITEA_TOKEN: opts.token ?? env.token,
    GITEA_ALLOW_HTTP: 'true',
    GITEA_ALLOW_DESTRUCTIVE: 'true',
    GITEA_ALLOW_ADMIN: 'true',
    GITEA_TIMEOUT_MS: '60000',
    ...opts.extraEnv,
  });
  const server = new GiteaMcpServer(config, {
    cwd: opts.cwd,
    http: {
      onRequest: (r) => {
        recorded.push(r);
      },
    },
  });
  const client = new Client(
    { name: 'integration', version: '1.0.0' },
    { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } },
  );
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'accept', content: { confirm: true } }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.mcp.connect(a), client.connect(b)]);

  async function raw(name: string, args: Record<string, unknown>) {
    calledTools.add(name);
    const res = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 300_000,
    })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    return { res, text };
  }

  return {
    client,
    server,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const { res, text } = await raw(name, args);
      if (res.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
    async fail(name: string, args: Record<string, unknown> = {}) {
      const { res, text } = await raw(name, args);
      if (!res.isError) throw new Error(`${name} unexpectedly succeeded: ${text.slice(0, 500)}`);
      try {
        return (
          JSON.parse(text) as { error: { code: string; message: string; hint?: string; status?: number } }
        ).error;
      } catch {
        return { code: 'SCHEMA', message: text };
      }
    },
    async close() {
      await client.close();
    },
  };
}

/** Direct API access for test setup only (e.g. creating a second user). */
export async function api<T = unknown>(
  env: ItEnv,
  method: string,
  path: string,
  body?: unknown,
  basicAuth: boolean | { username: string; password: string } = false,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const creds =
    basicAuth === true ? { username: env.username, password: env.password } : basicAuth || undefined;
  headers.authorization = creds
    ? `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
    : `token ${env.token}`;
  const res = await fetch(`${env.url}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function waitUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 120_000,
  intervalMs = 1500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
