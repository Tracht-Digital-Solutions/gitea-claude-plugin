import { ifFound, GiteaError } from '../../gitea/errors.js';
import { filePath } from '../../security/url.js';
import type { RepoRef, ToolContext } from '../types.js';

/**
 * Read access to repository files and trees, shared by the content, git, Actions, release and
 * analysis tools.
 */

/** One entry of `GET /repos/{owner}/{repo}/contents/{path}` (a file, or an item of a directory listing). */
export interface ContentEntry {
  type: string;
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string | null;
  encoding?: string | null;
  target?: string | null;
  last_commit_sha?: string;
  html_url?: string;
}

/** One entry of a recursive git tree. */
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  sha: string;
}

/** Largest text file read through the raw endpoint. */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Heuristic used by git itself: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** The repository's default branch. */
export async function defaultBranch(ctx: ToolContext, repo: RepoRef): Promise<string> {
  const res = await ctx.client.request<{ default_branch: string }>({ path: repo.api });
  return res.data.default_branch;
}

/** File metadata and content (base64) or, for a directory, its listing. */
export async function getContent(
  ctx: ToolContext,
  repo: RepoRef,
  path: string,
  ref?: string,
): Promise<ContentEntry | ContentEntry[]> {
  const res = await ctx.client.request<ContentEntry | ContentEntry[]>({
    path: `${repo.api}/contents/${filePath(path)}`,
    query: { ref },
  });
  return res.data;
}

/** Reads a UTF-8 text file; `undefined` if it does not exist at `ref`, INVALID_INPUT if binary. */
export async function readTextFile(
  ctx: ToolContext,
  repo: RepoRef,
  path: string,
  ref?: string,
): Promise<string | undefined> {
  const res = await ifFound(
    ctx.client.request<Buffer>({
      path: `${repo.api}/raw/${filePath(path)}`,
      query: { ref },
      responseType: 'binary',
      maxBytes: MAX_TEXT_FILE_BYTES,
    }),
  );
  if (!res) return undefined;
  if (isBinary(res.data)) throw new GiteaError('INVALID_INPUT', `${path} is a binary file.`);
  return res.data.toString('utf8');
}

/** Current blob SHA of a regular file, as required to update or delete it. */
export async function fileSha(ctx: ToolContext, repo: RepoRef, path: string, ref?: string): Promise<string> {
  const entry = await getContent(ctx, repo, path, ref);
  if (Array.isArray(entry) || entry.type !== 'file') {
    throw new GiteaError('INVALID_INPUT', `${path} is not a regular file.`);
  }
  return entry.sha;
}

/**
 * Recursive file tree at `ref`, following Gitea's paging of large trees, capped at `maxEntries`.
 */
export async function listTree(
  ctx: ToolContext,
  repo: RepoRef,
  ref: string,
  maxEntries: number,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const entries: TreeEntry[] = [];
  let truncated = false;
  for (let page = 1; entries.length < maxEntries; page++) {
    const res = await ctx.client.request<{ tree?: TreeEntry[]; truncated?: boolean; total_count?: number }>({
      path: `${repo.api}/git/trees/${encodeURIComponent(ref)}`,
      query: { recursive: true, page, per_page: 1000 },
    });
    const tree = res.data.tree ?? [];
    entries.push(...tree);
    if (!res.data.truncated || tree.length === 0) break;
    truncated = true;
    if (res.data.total_count !== undefined && entries.length >= res.data.total_count) {
      truncated = false;
      break;
    }
  }
  return { entries: entries.slice(0, maxEntries), truncated: truncated || entries.length > maxEntries };
}
