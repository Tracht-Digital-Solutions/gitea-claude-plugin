import { GiteaError } from '../gitea/errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface BaseUrlOptions {
  /** Allow plain http:// (never the default; intended for local test instances). */
  allowHttp?: boolean;
}

/**
 * Validates and normalises the configured Gitea base URL.
 * - only https (http only with explicit opt-in)
 * - no embedded credentials, query or fragment
 * - a trailing `/api/v1` is stripped so users may paste either form
 */
export function normalizeBaseUrl(raw: string, options: BaseUrlOptions = {}): URL {
  const value = raw.trim();
  if (!value) throw new GiteaError('NOT_CONFIGURED', 'No Gitea server URL configured.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GiteaError('INVALID_CONFIG', `The Gitea URL is not a valid absolute URL: "${value}"`, {
      hint: 'Use a value such as https://gitea.example.com',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GiteaError('INVALID_CONFIG', `Unsupported URL scheme "${url.protocol}" for the Gitea URL.`);
  }
  if (url.protocol === 'http:' && !options.allowHttp) {
    throw new GiteaError('INVALID_CONFIG', 'Refusing to send an API token over unencrypted http://.', {
      hint: 'Use https://. For a local test instance you can explicitly enable "Allow insecure HTTP".',
    });
  }
  if (url.username || url.password) {
    throw new GiteaError('INVALID_CONFIG', 'The Gitea URL must not contain credentials.', {
      hint: 'Remove user:password@ from the URL and configure the API token separately.',
    });
  }
  if (url.search || url.hash) {
    throw new GiteaError('INVALID_CONFIG', 'The Gitea URL must not contain a query string or fragment.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api\/v1$/i, '');
  url.pathname = `${path}/`;
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** True when `candidate` has the same origin and lies under the base path. */
export function isWithinBase(base: URL, candidate: URL): boolean {
  return candidate.origin === base.origin && candidate.pathname.startsWith(base.pathname);
}

/** Encodes one path segment (owner, repo, branch, tag…) for use in an API path. */
export function seg(value: string | number): string {
  const s = String(value);
  if (s.length === 0) throw new GiteaError('INVALID_INPUT', 'Empty path segment.');
  if (s === '.' || s === '..') throw new GiteaError('INVALID_INPUT', `Invalid path segment "${s}".`);
  return encodeURIComponent(s);
}

/**
 * Encodes a repository file path (may contain slashes). Rejects traversal, absolute paths,
 * backslashes and control characters.
 */
export function filePath(value: string): string {
  const s = value.replace(/^\/+/, '');
  if (!s) throw new GiteaError('INVALID_INPUT', 'File path must not be empty.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(s))
    throw new GiteaError('INVALID_INPUT', 'File path contains invalid characters.');
  const parts = s.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw new GiteaError('INVALID_INPUT', `File path "${value}" contains empty, "." or ".." segments.`);
  }
  return parts.map((p) => encodeURIComponent(p)).join('/');
}
