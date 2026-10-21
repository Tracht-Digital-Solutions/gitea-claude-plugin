import { execFile } from 'node:child_process';
import { GiteaError } from '../gitea/errors.js';

/**
 * Local git integration. Commands are always executed with `execFile` (no shell) and a fixed
 * argument vector; user-provided values are validated before they are placed into it, and are
 * separated from options with `--` where git supports it.
 */

const GIT_TIMEOUT_MS = 60_000;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new GiteaError('GIT_ERROR', 'git is not installed or not on PATH.'));
            return;
          }
          reject(
            new GiteaError(
              'GIT_ERROR',
              `git ${args[0] ?? ''} failed: ${(stderr || err.message).trim().slice(0, 2000)}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Branch-name rules of `git check-ref-format --branch`, enforced without invoking a shell. As
 * defence in depth, shell metacharacters are rejected too even though no shell is involved.
 */
export function assertBranchName(name: string): void {
  const invalid =
    !name ||
    name.length > 255 ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    name === '@' ||
    // eslint-disable-next-line no-control-regex
    /[\u0000- \u007f~^:?*[\\]/.test(name) ||
    /[$`;&|<>()'"!{}]/.test(name) ||
    name.split('/').some((part) => part.startsWith('.'));
  if (invalid) throw new GiteaError('INVALID_INPUT', `Invalid branch name: "${name}"`);
}

export function assertRemoteName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new GiteaError('INVALID_INPUT', `Invalid remote name: "${name}"`);
  }
}

export interface ParsedRemote {
  host: string;
  /** Path of the repository on the server, without leading slash and .git suffix. */
  path: string;
}

/** Parses https, ssh:// and scp-like (`git@host:owner/repo.git`) remote URLs. */
export function parseRemoteUrl(remote: string): ParsedRemote | undefined {
  const value = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { host: scp[1]!.toLowerCase(), path: scp[2]!.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '') };
  }
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    return {
      host: url.hostname.toLowerCase(),
      path: decodeURIComponent(url.pathname)
        .replace(/\.git$/, '')
        .replace(/^\/+|\/+$/g, ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * Maps a remote to owner/repo when it points to the given Gitea instance. The instance may live
 * under a sub path (https://host/gitea/owner/repo); ssh remotes have no sub path.
 */
export function repoFromRemote(remote: string, base: URL): { owner: string; repo: string } | undefined {
  const parsed = parseRemoteUrl(remote);
  if (!parsed || parsed.host !== base.hostname.toLowerCase()) return undefined;
  let path = parsed.path;
  const basePath = base.pathname.replace(/^\/+|\/+$/g, '');
  if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length + 1);
  const parts = path.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { owner: parts[0], repo: parts[1] };
}

export async function listRemotes(cwd: string): Promise<{ name: string; url: string }[]> {
  const { stdout } = await runGit(['remote', '-v'], cwd);
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) seen.set(m[1]!, m[2]!);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

export interface LocalRepoContext {
  root: string;
  branch: string | undefined;
  upstream: string | undefined;
  ahead: number | undefined;
  behind: number | undefined;
  headSha: string | undefined;
  changedFiles: { status: string; path: string }[];
  remotes: { name: string; url: string; giteaRepo: { owner: string; repo: string } | undefined }[];
}

export async function localContext(cwd: string, base: URL | undefined): Promise<LocalRepoContext> {
  const root = (await runGit(['rev-parse', '--show-toplevel'], cwd)).stdout.trim();
  const branch = (await runGit(['branch', '--show-current'], root)).stdout.trim() || undefined;
  const headSha = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root)
    .then((r) => r.stdout.trim() || undefined)
    .catch(() => undefined);
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  try {
    upstream = (
      await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)
    ).stdout.trim();
    const counts = (await runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], root)).stdout
      .trim()
      .split(/\s+/);
    behind = Number(counts[0]);
    ahead = Number(counts[1]);
  } catch {
    upstream = undefined;
  }
  const status = (await runGit(['status', '--porcelain=v1', '--untracked-files=normal'], root)).stdout;
  const changedFiles = status
    .split('\n')
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
  const remotes = (await listRemotes(root)).map((r) => ({
    ...r,
    giteaRepo: base ? repoFromRemote(r.url, base) : undefined,
  }));
  return { root, branch, upstream, ahead, behind, headSha, changedFiles, remotes };
}

export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  setUpstream: boolean,
): Promise<GitResult> {
  assertRemoteName(remote);
  assertBranchName(branch);
  const args = ['push', '--porcelain'];
  if (setUpstream) args.push('--set-upstream');
  // refs/heads/ prefix keeps the value from being parsed as an option or refspec modifier.
  args.push(remote, `refs/heads/${branch}:refs/heads/${branch}`);
  return runGit(args, cwd, 180_000);
}
