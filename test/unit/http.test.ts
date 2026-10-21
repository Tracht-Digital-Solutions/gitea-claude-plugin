import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiteaError } from '../../src/gitea/errors.js';
import { GiteaHttpClient, backoffMs, buildCaList, parseRetryAfter } from '../../src/gitea/http.js';
import { clearSecrets, registerSecret } from '../../src/security/redact.js';
import { testProfile } from '../helpers/profile.js';

const ORIGIN = 'https://gitea.test';
let agent: MockAgent;
let sleeps: number[];

function client(overrides: Partial<ConstructorParameters<typeof GiteaHttpClient>[1]> = {}) {
  return new GiteaHttpClient(testProfile(), {
    timeoutMs: 2000,
    maxRetries: 3,
    userAgent: 'test',
    dispatcher: agent,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
}

async function caught(p: Promise<unknown>): Promise<GiteaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GiteaError) return err;
    throw err;
  }
  throw new Error('expected a GiteaError');
}

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  sleeps = [];
  registerSecret('test-token-0123456789');
});

afterEach(async () => {
  await agent.close();
  clearSecrets();
});

describe('GiteaHttpClient', () => {
  it('sends the token header and parses JSON', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v1/user',
        method: 'GET',
        headers: { authorization: 'token test-token-0123456789' },
      })
      .reply(200, { login: 'alice' }, { headers: { 'content-type': 'application/json' } });
    const res = await client().request<{ login: string }>({ path: '/user' });
    expect(res.data.login).toBe('alice');
  });

  it('encodes query parameters and skips empty values', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/search?q=a+b&labels=x&labels=y&private=false', method: 'GET' })
      .reply(200, []);
    await client().request({
      path: '/repos/search',
      query: { q: 'a b', labels: ['x', 'y'], private: false, empty: '', none: undefined },
    });
  });

  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'UNSUPPORTED'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION_FAILED'],
    [500, 'SERVER_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/x', method: 'POST' }).reply(status, { message: 'nope' });
    const err = await caught(client().request({ method: 'POST', path: '/x', body: {} }));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toContain('nope');
  });

  it('explains missing token scopes', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/user/repos', method: 'GET' })
      .reply(403, { message: 'token does not have at least one of required scope(s): [read:repository]' });
    const err = await caught(client({ maxRetries: 0 }).request({ path: '/user/repos' }));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.hint).toMatch(/scope/);
  });

  it('retries idempotent requests on 503 with exponential backoff', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/api/v1/version', method: 'GET' }).reply(503, 'busy').times(2);
    pool.intercept({ path: '/api/v1/version', method: 'GET' }).reply(200, { version: '1' });
    const res = await client().request<{ version: string }>({ path: '/version' });
    expect(res.data.version).toBe('1');
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('does not retry non-idempotent requests on 5xx', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/x', method: 'POST' }).reply(503, 'busy');
    const err = await caught(client().request({ method: 'POST', path: '/x', body: {} }));
    expect(err.code).toBe('SERVER_ERROR');
    expect(sleeps).toHaveLength(0);
  });

  it('honours Retry-After on 429', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/api/v1/x', method: 'GET' })
      .reply(429, 'slow down', { headers: { 'retry-after': '2' } });
    pool.intercept({ path: '/api/v1/x', method: 'GET' }).reply(200, {});
    await client().request({ path: '/x' });
    expect(sleeps).toEqual([2000]);
  });

  it('gives up on long Retry-After and reports it', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/x', method: 'GET' })
      .reply(429, 'slow down', { headers: { 'retry-after': '120' } });
    const err = await caught(client().request({ path: '/x' }));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(120);
    expect(sleeps).toHaveLength(0);
  });

  it('follows same-origin redirects for GET', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/api/v1/repos/a/b', method: 'GET' })
      .reply(301, '', { headers: { location: '/api/v1/repos/a/c' } });
    pool
      .intercept({
        path: '/api/v1/repos/a/c',
        method: 'GET',
        headers: { authorization: 'token test-token-0123456789' },
      })
      .reply(200, { name: 'c' });
    const res = await client().request<{ name: string }>({ path: '/repos/a/b' });
    expect(res.data.name).toBe('c');
  });

  it('blocks redirects to other origins and never forwards the token', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/user', method: 'GET' })
      .reply(302, '', { headers: { location: 'https://evil.test/steal' } });
    const err = await caught(client().request({ path: '/user' }));
    expect(err.code).toBe('REDIRECT_BLOCKED');
    expect(err.message).toContain('evil.test');
  });

  it('follows foreign https redirects for downloads without the token', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/repos/a/b/actions/artifacts/1/zip', method: 'GET' })
      .reply(302, '', { headers: { location: 'https://storage.test/blob?sig=1' } });
    agent
      .get('https://storage.test')
      .intercept({
        path: '/blob?sig=1',
        method: 'GET',
        headers: (h) => !Object.keys(h).some((k) => k.toLowerCase() === 'authorization'),
      })
      .reply(200, 'ZIPDATA');
    const res = await client().request<Buffer>({
      path: '/repos/a/b/actions/artifacts/1/zip',
      responseType: 'binary',
      allowForeignRedirect: true,
    });
    expect(res.data.toString()).toBe('ZIPDATA');
  });

  it('refuses to follow redirects for non-GET requests', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/x', method: 'POST' })
      .reply(307, '', { headers: { location: '/api/v1/y' } });
    const err = await caught(client().request({ method: 'POST', path: '/x', body: {} }));
    expect(err.code).toBe('REDIRECT_BLOCKED');
  });

  it('maps connection errors and retries them', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/x', method: 'GET' })
      .replyWithError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      .times(4);
    const err = await caught(client().request({ path: '/x' }));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.hint).toMatch(/refused/);
    expect(sleeps).toHaveLength(3);
  });

  it('maps TLS failures without retrying and suggests a CA file', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/x', method: 'GET' })
      .replyWithError(
        Object.assign(new Error('self-signed certificate in certificate chain'), {
          code: 'SELF_SIGNED_CERT_IN_CHAIN',
        }),
      );
    const err = await caught(client().request({ path: '/x' }));
    expect(err.code).toBe('TLS_ERROR');
    expect(err.hint).toMatch(/CA certificate file/);
    expect(err.hint).toMatch(/never disabled/);
    expect(sleeps).toHaveLength(0);
  });

  it('times out slow responses', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/slow', method: 'GET' }).reply(200, {}).delay(500);
    const err = await caught(client({ timeoutMs: 50, maxRetries: 0 }).request({ path: '/slow' }));
    expect(err.code).toBe('TIMEOUT');
  });

  it('reports non-JSON answers (e.g. a login proxy) clearly', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/user', method: 'GET' }).reply(200, '<html>login</html>');
    const err = await caught(client().request({ path: '/user' }));
    expect(err.hint).toMatch(/Gitea instance/);
  });

  it('truncates text bodies at maxBytes', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/v1/log', method: 'GET' }).reply(200, 'x'.repeat(1000));
    const res = await client().request<string>({ path: '/log', responseType: 'text', maxBytes: 100 });
    expect(res.data).toHaveLength(100);
    expect(res.truncated).toBe(true);
  });

  it('refuses paths that escape the API base', () => {
    expect(() => client().url('../../admin')).toThrow(/outside the Gitea API/);
  });

  it('never exposes the token in error output', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/x', method: 'GET' })
      .reply(500, { message: 'bad token test-token-0123456789' });
    const err = await caught(client({ maxRetries: 0 }).request({ path: '/x' }));
    expect(JSON.stringify(err.toJSON())).not.toContain('test-token-0123456789');
  });
});

describe('paginate', () => {
  it('collects pages until a short page and respects the limit', async () => {
    const pool = agent.get(ORIGIN);
    const page = (n: number, size: number) => Array.from({ length: size }, (_, i) => ({ id: n * 100 + i }));
    pool.intercept({ path: '/api/v1/items?page=1&limit=50', method: 'GET' }).reply(200, page(1, 50));
    pool.intercept({ path: '/api/v1/items?page=2&limit=50', method: 'GET' }).reply(200, page(2, 50));
    pool.intercept({ path: '/api/v1/items?page=3&limit=50', method: 'GET' }).reply(200, page(3, 10));
    const all = await client().paginate<{ id: number }>('/items', {}, { limit: 500 });
    expect(all.items).toHaveLength(110);
    expect(all.hasMore).toBe(false);
  });

  it('stops at the limit and flags more results', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/items?page=1&limit=5', method: 'GET' })
      .reply(200, [1, 2, 3, 4, 5], { headers: { 'x-total-count': '42' } });
    const res = await client().paginate('/items', {}, { limit: 5 });
    expect(res.items).toEqual([1, 2, 3, 4, 5]);
    expect(res.totalCount).toBe(42);
    expect(res.hasMore).toBe(true);
  });

  it('unwraps keyed list responses', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/runs?page=1&limit=10', method: 'GET' })
      .reply(200, { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] });
    const res = await client().paginate('/runs', {}, { limit: 10, key: 'workflow_runs' });
    expect(res.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.totalCount).toBe(2);
  });
});

describe('helpers', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('caps the backoff', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(20, () => 0)).toBe(10_000);
  });

  it('keeps Node defaults when no CA option is set and validates CA files', () => {
    expect(buildCaList([undefined], false)).toBeUndefined();
    expect(() => buildCaList(['/does/not/exist.pem'], false)).toThrow(/Cannot load CA certificate/);
  });
});
