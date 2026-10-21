import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { Agent, FormData, fetch, type Dispatcher } from 'undici';
import type { Profile } from '../config/config.js';
import { log } from '../util/log.js';
import { isWithinBase } from '../security/url.js';
import { GiteaError, errorFromResponse } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | undefined | null | readonly (string | number)[];

export interface RequestOptions {
  method?: HttpMethod;
  /** Path below /api/v1, e.g. `/repos/o/r`. Segments must already be encoded. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  form?: FormData;
  /** Raw request body sent as application/octet-stream (file uploads to package registries). */
  raw?: Uint8Array;
  /** How to read the response body. */
  responseType?: 'json' | 'text' | 'binary';
  /** Override the retry policy (default: retry idempotent GET requests only). */
  retry?: boolean;
  /** Upper bound for text/binary bodies. */
  maxBytes?: number;
  /** Follow redirects to other origins (without credentials). Only used for file downloads. */
  allowForeignRedirect?: boolean;
  /** Resolve `path` against the instance root instead of /api/v1 (e.g. /swagger.v1.json). */
  root?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  totalCount: number | undefined;
  truncated: boolean;
}

export interface HttpClientOptions {
  timeoutMs: number;
  maxRetries: number;
  caFile?: string | undefined;
  useSystemCa?: boolean;
  userAgent: string;
  /** Injected for tests. */
  dispatcher?: Dispatcher;
  /** Injected for tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes every outgoing request (used by the API compatibility tests). */
  onRequest?: (info: { method: HttpMethod; url: URL }) => void;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** Builds the CA list: Node defaults (+NODE_EXTRA_CA_CERTS) + optional system store + custom PEM files. */
export function buildCaList(files: (string | undefined)[], useSystemCa: boolean): string[] | undefined {
  const custom = files.filter((f): f is string => Boolean(f));
  if (custom.length === 0 && !useSystemCa) return undefined; // keep Node defaults untouched
  const getCa = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  const list: string[] = getCa ? [...getCa('default')] : [...tls.rootCertificates];
  if (useSystemCa) {
    if (!getCa) {
      throw new GiteaError('INVALID_CONFIG', 'Using the system CA store requires Node.js 22.15 or newer.');
    }
    list.push(...getCa('system'));
  }
  for (const file of custom) {
    try {
      const pem = readFileSync(file, 'utf8');
      if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error('file does not contain a PEM certificate');
      }
      list.push(pem);
    } catch (err) {
      throw new GiteaError(
        'INVALID_CONFIG',
        `Cannot load CA certificate file ${file}: ${(err as Error).message}`,
      );
    }
  }
  return list;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

export function backoffMs(attempt: number, random = Math.random): number {
  const base = 500 * 2 ** attempt;
  return Math.min(10_000, base) + Math.floor(random() * 250);
}

function appendQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value as (string | number)[]) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function networkError(err: unknown, where: string): GiteaError {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return new GiteaError('TIMEOUT', `Request timed out (${where}).`, {
      hint: 'The Gitea server did not answer in time. Check the server or increase GITEA_TIMEOUT_MS.',
    });
  }
  const code = e.cause?.code ?? '';
  if (TLS_CODES.has(code) || /certificate|SSL|TLS/i.test(e.cause?.message ?? '')) {
    return new GiteaError(
      'TLS_ERROR',
      `TLS certificate verification failed (${where}): ${code || e.cause?.message}`,
      {
        hint: 'If the server uses a certificate from a private CA, configure "CA certificate file" in the plugin options (PEM) or enable "Use system CA store". TLS verification is never disabled.',
        cause: err,
      },
    );
  }
  const hints: Record<string, string> = {
    ENOTFOUND: 'The host name could not be resolved. Check the Gitea URL.',
    ECONNREFUSED: 'The connection was refused. Is the server running and the port correct?',
    ECONNRESET: 'The connection was reset by the server or a proxy.',
    ETIMEDOUT: 'The connection timed out.',
    UND_ERR_CONNECT_TIMEOUT: 'The connection timed out.',
    EHOSTUNREACH: 'The host is unreachable.',
  };
  return new GiteaError(
    'NETWORK_ERROR',
    `Cannot reach Gitea (${where}): ${code || e.cause?.message || e.message}`,
    {
      hint: hints[code] ?? 'Check the network connection and the configured Gitea URL.',
      cause: err,
    },
  );
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>, maxBytes: number) {
  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk as Uint8Array);
    if (size + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - size));
      truncated = true;
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  if (truncated) await res.body.cancel().catch(() => undefined);
  return { buffer: Buffer.concat(chunks), truncated };
}

export class GiteaHttpClient {
  readonly profile: Profile;
  readonly apiBase: URL;
  private readonly options: HttpClientOptions;
  private readonly dispatcher: Dispatcher;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(profile: Profile, options: HttpClientOptions) {
    this.profile = profile;
    this.options = options;
    this.apiBase = new URL('api/v1/', profile.baseUrl);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
    } else {
      const ca = buildCaList([options.caFile, profile.caFile], options.useSystemCa ?? false);
      this.dispatcher = new Agent({
        connect: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      });
    }
  }

  /** Builds a URL below /api/v1 for the given encoded path. */
  url(path: string, query?: Record<string, QueryValue>, root = false): URL {
    const rel = path.replace(/^\/+/, '');
    const base = root ? this.profile.baseUrl : this.apiBase;
    const url = new URL(rel, base);
    if (!isWithinBase(base, url)) {
      throw new GiteaError('INVALID_INPUT', `Refusing to request a path outside the Gitea API: ${path}`);
    }
    appendQuery(url, query);
    return url;
  }

  private headers(withAuth: boolean, accept: string, json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept, 'user-agent': this.options.userAgent };
    if (json) h['content-type'] = 'application/json';
    if (withAuth && this.profile.token) h.authorization = `token ${this.profile.token}`;
    return h;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<HttpResponse<T>> {
    const method = opts.method ?? 'GET';
    const responseType = opts.responseType ?? 'json';
    const retryable = opts.retry ?? method === 'GET';
    const where = `${method} ${opts.path}`;
    let url = this.url(opts.path, opts.query, opts.root);
    const accept = responseType === 'json' ? 'application/json' : '*/*';
    let bodyInit: string | FormData | Uint8Array | undefined;
    if (opts.form) bodyInit = opts.form;
    else if (opts.raw) bodyInit = opts.raw;
    else if (opts.body !== undefined) bodyInit = JSON.stringify(opts.body);

    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<typeof fetch>>;
      let withAuth = true;
      let redirects = 0;
      try {
        for (;;) {
          this.options.onRequest?.({ method, url });
          res = await fetch(url, {
            method,
            headers: {
              ...this.headers(withAuth, accept, opts.body !== undefined && !opts.form && !opts.raw),
              ...(opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
            },
            body: bodyInit,
            redirect: 'manual',
            dispatcher: this.dispatcher,
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          if (res.status < 300 || res.status >= 400 || res.status === 304) break;
          const location = res.headers.get('location');
          await res.body?.cancel().catch(() => undefined);
          if (!location) break;
          const next = new URL(location, url);
          redirects++;
          if (redirects > MAX_REDIRECTS) {
            throw new GiteaError('REDIRECT_BLOCKED', `Too many redirects (${where}).`);
          }
          if (next.origin === this.profile.baseUrl.origin) {
            if (method !== 'GET') {
              throw new GiteaError(
                'REDIRECT_BLOCKED',
                `Refusing to follow a redirect for ${method} (${where}).`,
                {
                  hint: 'Configure the canonical Gitea URL (check http/https and trailing paths).',
                },
              );
            }
          } else if (opts.allowForeignRedirect && next.protocol === 'https:' && method === 'GET') {
            withAuth = false; // never send the token to another origin
          } else {
            throw new GiteaError(
              'REDIRECT_BLOCKED',
              `Gitea redirected to another origin (${next.origin}); the request was not followed (${where}).`,
              { hint: 'Configure the canonical Gitea URL. The API token is never sent to other hosts.' },
            );
          }
          url = next;
        }
      } catch (err) {
        if (err instanceof GiteaError) throw err;
        const mapped = networkError(err, where);
        if (retryable && attempt < this.options.maxRetries && mapped.code !== 'TLS_ERROR') {
          const wait = backoffMs(attempt);
          log.debug(`retrying ${where} after network error in ${wait}ms`);
          await this.sleep(wait);
          continue;
        }
        throw mapped;
      }

      if (res.status >= 400) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const canRetry =
          (retryable || res.status === 429) &&
          RETRYABLE_STATUS.has(res.status) &&
          attempt < this.options.maxRetries &&
          (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_SECONDS);
        if (canRetry) {
          await res.body?.cancel().catch(() => undefined);
          const wait = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
          log.debug(`retrying ${where} after HTTP ${res.status} in ${wait}ms`);
          await this.sleep(wait);
          continue;
        }
        const { buffer } = await readLimited(res, 64 * 1024);
        const text = buffer.toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* plain text body */
        }
        throw errorFromResponse(res.status, parsed, {
          method,
          path: opts.path,
          retryAfterSeconds: retryAfter,
        });
      }

      const totalHeader = res.headers.get('x-total-count');
      const totalCount = totalHeader === null ? undefined : Number(totalHeader);
      const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
      if (res.status === 204) {
        return {
          status: res.status,
          data: undefined as T,
          headers: res.headers as unknown as Headers,
          totalCount,
          truncated: false,
        };
      }
      const { buffer, truncated } = await readLimited(
        res,
        responseType === 'json' ? 50 * 1024 * 1024 : maxBytes,
      );
      let data: unknown;
      if (responseType === 'binary') data = buffer;
      else if (responseType === 'text') data = buffer.toString('utf8');
      else {
        const text = buffer.toString('utf8');
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          throw new GiteaError('HTTP_ERROR', `Gitea returned a non-JSON response (${where}).`, {
            status: res.status,
            hint: 'Check that the configured URL points to a Gitea instance (not a login proxy or another web app).',
          });
        }
      }
      return {
        status: res.status,
        data: data as T,
        headers: res.headers as unknown as Headers,
        totalCount: Number.isFinite(totalCount) ? totalCount : undefined,
        truncated,
      };
    }
  }

  /**
   * Collects list results across pages. `limit` bounds the total number of items so a single tool
   * call cannot exhaust memory or flood the context.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-chosen item type
  async paginate<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    {
      limit = 50,
      pageSize = 50,
      page = 1,
      key,
    }: { limit?: number; pageSize?: number; page?: number; key?: string } = {},
  ): Promise<{ items: T[]; totalCount: number | undefined; hasMore: boolean }> {
    const items: T[] = [];
    const size = Math.max(1, Math.min(pageSize, limit, 50));
    let current = page;
    let totalCount: number | undefined;
    for (;;) {
      const res = await this.request<T[] | Record<string, unknown>>({
        path,
        query: { ...query, page: current, limit: size },
      });
      let batch: T[];
      if (Array.isArray(res.data)) batch = res.data;
      else {
        const wrapped = res.data[key ?? 'data'];
        batch = Array.isArray(wrapped) ? (wrapped as T[]) : [];
        if (typeof res.data.total_count === 'number') totalCount = res.data.total_count;
      }
      totalCount = res.totalCount ?? totalCount;
      items.push(...batch);
      const exhausted = batch.length < size || (totalCount !== undefined && current * size >= totalCount);
      if (items.length >= limit || exhausted) {
        return { items: items.slice(0, limit), totalCount, hasMore: items.length > limit || !exhausted };
      }
      current++;
    }
  }

  /** Fetches an endpoint that returns its whole list at once (no page/limit parameters). */
  async list<T>(path: string, query: Record<string, QueryValue> = {}, key?: string): Promise<T[]> {
    const res = await this.request<T[] | Record<string, unknown>>({ path, query });
    if (Array.isArray(res.data)) return res.data;
    const wrapped = res.data[key ?? 'data'];
    return Array.isArray(wrapped) ? (wrapped as T[]) : [];
  }
}

export { FormData };
