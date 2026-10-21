import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GiteaError } from '../../src/gitea/errors.js';
import { GiteaHttpClient } from '../../src/gitea/http.js';
import { testProfile } from '../helpers/profile.js';

/**
 * Real TLS handshake against a local HTTPS server whose certificate is issued by a throwaway
 * private CA generated for this test run. Proves that verification is on by default and that a
 * configured CA file makes such a server trusted.
 */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'gitea-tls-'));
const p = (f: string) => join(dir, f);
let server: Server;
let base: URL;

describe.skipIf(!hasOpenssl())('TLS verification', () => {
  beforeAll(async () => {
    const ossl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
    ossl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      p('ca.key'),
      '-out',
      p('ca.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=Test CA',
    );
    ossl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      p('srv.key'),
      '-out',
      p('srv.csr'),
      '-subj',
      '/CN=localhost',
    );
    writeFileSync(p('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    ossl(
      'x509',
      '-req',
      '-in',
      p('srv.csr'),
      '-CA',
      p('ca.pem'),
      '-CAkey',
      p('ca.key'),
      '-CAcreateserial',
      '-out',
      p('srv.pem'),
      '-days',
      '1',
      '-extfile',
      p('ext.cnf'),
    );
    server = createServer(
      { key: readFileSync(p('srv.key')), cert: readFileSync(p('srv.pem')) },
      (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end('{"version":"tls-ok"}');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = new URL(`https://localhost:${(server.address() as AddressInfo).port}/`);
  }, 60_000);

  afterAll(() => {
    server.close();
  });

  const opts = { timeoutMs: 5000, maxRetries: 0, userAgent: 'test' };

  it('rejects a certificate from an unknown CA', async () => {
    const client = new GiteaHttpClient(testProfile({ baseUrl: base }), opts);
    const err = await client.request({ path: '/version' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiteaError);
    expect((err as GiteaError).code).toBe('TLS_ERROR');
  });

  it('trusts the server when the private CA is configured', async () => {
    const client = new GiteaHttpClient(testProfile({ baseUrl: base }), { ...opts, caFile: p('ca.pem') });
    const res = await client.request<{ version: string }>({ path: '/version' });
    expect(res.data.version).toBe('tls-ok');
  });

  it('accepts a per-profile CA file', async () => {
    const client = new GiteaHttpClient(testProfile({ baseUrl: base, caFile: p('ca.pem') }), opts);
    const res = await client.request<{ version: string }>({ path: '/version' });
    expect(res.data.version).toBe('tls-ok');
  });

  it('rejects a CA file that is not PEM', async () => {
    writeFileSync(p('bad.pem'), 'not a certificate');
    expect(
      () => new GiteaHttpClient(testProfile({ baseUrl: base }), { ...opts, caFile: p('bad.pem') }),
    ).toThrow(/PEM/);
    await Promise.resolve();
  });
});
