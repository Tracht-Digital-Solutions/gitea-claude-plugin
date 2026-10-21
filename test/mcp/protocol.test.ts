import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { GiteaMcpServer } from '../../src/server.js';
import { clearSecrets } from '../../src/security/redact.js';

const ORIGIN = 'https://gitea.test';
const TOKEN = 'mcp-test-token-abcdef0123';

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

afterEach(async () => {
  await agent.close();
  clearSecrets();
});

interface Setup {
  env?: Record<string, string>;
  elicitation?: 'accept' | 'decline';
  cwd?: string;
}

async function connect({ env = {}, elicitation, cwd }: Setup = {}) {
  const config = loadConfig({ GITEA_URL: ORIGIN, GITEA_TOKEN: TOKEN, ...env });
  const server = new GiteaMcpServer(config, {
    http: { dispatcher: agent, sleep: () => Promise.resolve() },
    cwd,
  });
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: elicitation ? { elicitation: { form: {} } } : {} },
  );
  const prompts: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      prompts.push(req.params.message);
      return elicitation === 'accept'
        ? { action: 'accept', content: { confirm: true } }
        : { action: 'decline' };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.mcp.connect(a), client.connect(b)]);
  return { client, server, prompts };
}

function text(result: unknown): string {
  return ((result as CallToolResult).content[0] as { text: string }).text;
}

function json(result: unknown): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function errorCode(result: unknown): string | undefined {
  return (json(result).error as { code?: string } | undefined)?.code;
}

function mockCapabilities() {
  const pool = agent.get(ORIGIN);
  pool.intercept({ path: '/api/v1/version', method: 'GET' }).reply(200, { version: '28.2.0' }).persist();
  pool
    .intercept({ path: '/swagger.v1.json', method: 'GET' })
    .reply(200, { paths: { '/repos/{owner}/{repo}/compare/{basehead}': { get: {} } } })
    .persist();
}

describe('MCP protocol', () => {
  it('initialises with server info, instructions and logging capability', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe('gitea');
    expect(client.getInstructions()).toMatch(/CONFIRMATION_REQUIRED/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('lists tools with schemas and correct annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['connection_test', 'repo_list', 'pr_create', 'actions_failures_analyze']),
    );
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    const repoList = tools.find((t) => t.name === 'repo_list')!;
    expect(repoList.annotations?.readOnlyHint).toBe(true);
    const merge = tools.find((t) => t.name === 'pr_merge')!;
    expect(merge.annotations?.destructiveHint).toBe(true);
    expect(merge.inputSchema.properties).toHaveProperty('confirm');
  });

  it('hides destructive and admin tools by default and exposes them when enabled', async () => {
    const def = await connect();
    const defNames = (await def.client.listTools()).tools.map((t) => t.name);
    expect(defNames).not.toContain('repo_delete');
    expect(defNames).not.toContain('collaborator_set');
    expect(defNames).toContain('repo_create');

    const all = await connect({ env: { GITEA_ALLOW_DESTRUCTIVE: 'true', GITEA_ALLOW_ADMIN: 'true' } });
    const allNames = (await all.client.listTools()).tools.map((t) => t.name);
    expect(allNames).toEqual(expect.arrayContaining(['repo_delete', 'collaborator_set', 'webhook_create']));

    const ro = await connect({ env: { GITEA_ALLOW_WRITE: 'false' } });
    const roTools = (await ro.client.listTools()).tools;
    expect(roTools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('validates parameters before any request is made', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'repo_get', arguments: { owner: '../etc', repo: 'x' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/owner/);
    const res2 = await client.callTool({
      name: 'issue_get',
      arguments: { owner: 'a', repo: 'b', number: -1 },
    });
    expect(res2.isError).toBe(true);
  });

  it('returns structured errors with hints', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/a/b', method: 'GET' })
      .reply(401, { message: 'invalid token' });
    agent.get(ORIGIN).intercept({ path: '/api/v1/repos/a/b/languages', method: 'GET' }).reply(401, {});
    const { client } = await connect();
    const res = await client.callTool({ name: 'repo_get', arguments: { owner: 'a', repo: 'b' } });
    expect(res.isError).toBe(true);
    const err = json(res).error as { code: string; hint: string; status: number };
    expect(err).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(err.hint).toMatch(/token/);
  });

  it('reports NOT_CONFIGURED without a server', async () => {
    const config = loadConfig({});
    const server = new GiteaMcpServer(config, { http: { dispatcher: agent } });
    const client = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.mcp.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'repo_list', arguments: {} });
    expect(errorCode(res)).toBe('NOT_CONFIGURED');
    expect(text(res)).toMatch(/\/plugin/);
    const profiles = await client.callTool({ name: 'profiles_list', arguments: {} });
    expect(profiles.isError).toBeFalsy();
    expect(json(profiles).setup_hint).toMatch(/Configure/);
  });

  it('redacts the token from every tool result', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/users/x', method: 'GET' })
      .reply(200, { login: 'x', description: `leaked ${TOKEN}` });
    const { client } = await connect();
    const res = await client.callTool({ name: 'user_get', arguments: { username: 'x' } });
    expect(text(res)).not.toContain(TOKEN);
    expect(text(res)).toContain('[REDACTED]');
  });

  it('reports unsupported features from the OpenAPI document', async () => {
    mockCapabilities();
    const { client } = await connect();
    const res = await client.callTool({ name: 'actions_run_list', arguments: { owner: 'a', repo: 'b' } });
    expect(errorCode(res)).toBe('UNSUPPORTED');
    expect(text(res)).toContain('28.2.0');
  });

  it('infers owner/repo from the git remote of the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitea-mcp-cwd-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitea.test:acme/tool.git'], { cwd: dir });
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/acme/tool', method: 'GET' })
      .reply(200, { full_name: 'acme/tool' });
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/acme/tool/languages', method: 'GET' })
      .reply(200, { Go: 10 });
    const { client } = await connect({ cwd: dir });
    const res = await client.callTool({ name: 'repo_get', arguments: {} });
    expect(json(res)).toMatchObject({ full_name: 'acme/tool', languages: { Go: 10 } });
  });
});

describe('confirmation of consequential actions', () => {
  const destructiveEnv = { GITEA_ALLOW_DESTRUCTIVE: 'true' };

  it('refuses without confirmation and performs no request', async () => {
    const { client } = await connect({ env: destructiveEnv });
    // No DELETE interceptor: any request would fail with a mock error instead of CONFIRMATION_REQUIRED.
    const res = await client.callTool({ name: 'repo_delete', arguments: { owner: 'acme', repo: 'tool' } });
    expect(errorCode(res)).toBe('CONFIRMATION_REQUIRED');
    const err = json(res).error as { details: { confirm: string }; hint: string };
    expect(err.details.confirm).toBe('acme/tool');
    expect(err.hint).toMatch(/Nothing was changed/);
  });

  it('rejects a wrong confirmation token', async () => {
    const { client } = await connect({ env: destructiveEnv });
    const res = await client.callTool({
      name: 'repo_delete',
      arguments: { owner: 'acme', repo: 'tool', confirm: 'acme/other' },
    });
    expect(errorCode(res)).toBe('CONFIRMATION_REQUIRED');
    expect(text(res)).toMatch(/did not match/);
  });

  it('executes with the exact confirmation token', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/repos/acme/tool', method: 'DELETE' }).reply(204, '');
    const { client } = await connect({ env: destructiveEnv });
    const res = await client.callTool({
      name: 'repo_delete',
      arguments: { owner: 'acme', repo: 'tool', confirm: 'acme/tool' },
    });
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({ deleted: 'acme/tool' });
    agent.assertNoPendingInterceptors();
  });

  it('asks the user via elicitation when the client supports it', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/repos/acme/tool', method: 'DELETE' }).reply(204, '');
    const { client, prompts } = await connect({ env: destructiveEnv, elicitation: 'accept' });
    const res = await client.callTool({ name: 'repo_delete', arguments: { owner: 'acme', repo: 'tool' } });
    expect(res.isError).toBeFalsy();
    expect(prompts[0]).toMatch(/PERMANENTLY delete repository acme\/tool/);
    agent.assertNoPendingInterceptors();
  });

  it('does nothing when the user declines the elicitation', async () => {
    const { client } = await connect({ env: destructiveEnv, elicitation: 'decline' });
    const res = await client.callTool({
      name: 'repo_delete',
      arguments: { owner: 'acme', repo: 'tool', confirm: 'acme/tool' },
    });
    expect(errorCode(res)).toBe('CANCELLED');
  });

  it('requires confirmation for merges even though they are write operations', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/acme/tool/pulls/7', method: 'GET' })
      .reply(200, { number: 7, title: 'Feature', head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } });
    const { client } = await connect();
    const res = await client.callTool({
      name: 'pr_merge',
      arguments: { owner: 'acme', repo: 'tool', number: 7 },
    });
    expect(errorCode(res)).toBe('CONFIRMATION_REQUIRED');
    expect(text(res)).toMatch(/feat → main/);
  });

  it('denies writes on a read-only profile', async () => {
    const { client } = await connect({ env: { GITEA_PROFILES_FILE: '' } });
    const ro = new GiteaMcpServer(
      {
        ...loadConfig({ GITEA_URL: ORIGIN, GITEA_TOKEN: TOKEN }),
      },
      { http: { dispatcher: agent } },
    );
    ro.config.profiles.get('default')!.readOnly = true;
    const c2 = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([ro.mcp.connect(a), c2.connect(b)]);
    const res = await c2.callTool({ name: 'repo_create', arguments: { name: 'x' } });
    expect(errorCode(res)).toBe('PERMISSION_DENIED');
    expect(text(res)).toMatch(/read-only/);
    await client.close();
  });
});
