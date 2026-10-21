import { createTwoFilesPatch } from 'diff';
import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact } from '../../gitea/models.js';
import { filePath } from '../../security/url.js';
import { body, profileShape, refSchema, repoShape, truncateText } from '../common.js';
import { defineTool, type ToolContext, type RepoRef, type ToolDefinition } from '../types.js';

const M = 'repositories';

interface ContentEntry {
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

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  sha: string;
}

const pathSchema = z.string().min(1).max(4096).describe('File path inside the repository, e.g. src/index.ts');
const commitShape = {
  branch: z.string().max(255).optional().describe('Branch to commit to. Defaults to the default branch.'),
  new_branch: z
    .string()
    .max(255)
    .optional()
    .describe('Create this new branch from `branch` and commit there (useful for pull requests).'),
  message: z.string().max(10_000).optional().describe('Commit message.'),
  author_name: z.string().max(255).optional(),
  author_email: z.email().optional(),
};

function commitBody(args: {
  branch?: string | undefined;
  new_branch?: string | undefined;
  message?: string | undefined;
  author_name?: string | undefined;
  author_email?: string | undefined;
}) {
  const author =
    args.author_name && args.author_email ? { name: args.author_name, email: args.author_email } : undefined;
  return body({ branch: args.branch, new_branch: args.new_branch, message: args.message, author });
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

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

/** Reads a text file; returns undefined if it does not exist at that ref. */
export async function readTextFile(
  ctx: ToolContext,
  repo: RepoRef,
  path: string,
  ref?: string,
): Promise<string | undefined> {
  try {
    const res = await ctx.client.request<Buffer>({
      path: `${repo.api}/raw/${filePath(path)}`,
      query: { ref },
      responseType: 'binary',
      maxBytes: 2 * 1024 * 1024,
    });
    if (isBinary(res.data)) throw new GiteaError('INVALID_INPUT', `${path} is a binary file.`);
    return res.data.toString('utf8');
  } catch (err) {
    if (err instanceof GiteaError && err.code === 'NOT_FOUND') return undefined;
    throw err;
  }
}

async function currentSha(ctx: ToolContext, repo: RepoRef, path: string, ref?: string) {
  const entry = await getContent(ctx, repo, path, ref);
  if (Array.isArray(entry) || entry.type !== 'file') {
    throw new GiteaError('INVALID_INPUT', `${path} is not a regular file.`);
  }
  return entry.sha;
}

async function listTree(ctx: ToolContext, repo: RepoRef, ref: string, maxEntries: number) {
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

async function defaultBranch(ctx: ToolContext, repo: RepoRef): Promise<string> {
  const res = await ctx.client.request<{ default_branch: string }>({ path: repo.api });
  return res.data.default_branch;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export const contentTools: ToolDefinition[] = [
  defineTool({
    name: 'file_get',
    module: M,
    title: 'Read file',
    description:
      'Reads a file from a repository at a branch, tag or commit. Text is returned decoded; binary files return metadata only. Directories return their listing.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      path: pathSchema,
      ref: refSchema.optional(),
      max_chars: z.number().int().min(100).max(500_000).default(100_000),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const entry = await getContent(ctx, repo, args.path, args.ref);
      if (Array.isArray(entry)) {
        return {
          type: 'dir',
          path: args.path,
          entries: entry.map((e) => compact({ type: e.type, path: e.path, size: e.size })),
        };
      }
      if (entry.type !== 'file') {
        return compact({ type: entry.type, path: entry.path, target: entry.target, sha: entry.sha });
      }
      const raw = entry.content ? Buffer.from(entry.content, 'base64') : undefined;
      if (raw === undefined) {
        const text = await readTextFile(ctx, repo, args.path, args.ref);
        const t = truncateText(text ?? '', args.max_chars);
        return {
          path: entry.path,
          sha: entry.sha,
          size: entry.size,
          truncated: t.truncated,
          content: t.text,
        };
      }
      if (isBinary(raw)) {
        return { path: entry.path, sha: entry.sha, size: entry.size, binary: true, html_url: entry.html_url };
      }
      const t = truncateText(raw.toString('utf8'), args.max_chars);
      return {
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        last_commit_sha: entry.last_commit_sha,
        truncated: t.truncated,
        content: t.text,
      };
    },
  }),
  defineTool({
    name: 'dir_list',
    module: M,
    title: 'List directory',
    description: 'Lists the entries of a directory (default: repository root) at a ref.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      path: z.string().max(4096).default('').describe('Directory path; empty for the root.'),
      ref: refSchema.optional(),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const p = args.path.replace(/^\/+|\/+$/g, '');
      const res = await ctx.client.request<ContentEntry[] | ContentEntry>({
        path: p ? `${repo.api}/contents/${filePath(p)}` : `${repo.api}/contents`,
        query: { ref: args.ref },
      });
      if (!Array.isArray(res.data))
        throw new GiteaError('INVALID_INPUT', `${args.path} is a file, not a directory.`);
      return {
        path: p || '/',
        entries: res.data.map((e) =>
          compact({ name: e.name, type: e.type, path: e.path, size: e.type === 'file' ? e.size : undefined }),
        ),
      };
    },
  }),
  defineTool({
    name: 'tree_get',
    module: M,
    title: 'Show directory tree',
    description:
      'Shows the recursive file tree of a repository at a ref, optionally limited to a path prefix. Useful to understand the project structure.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      ref: refSchema.optional().describe('Branch, tag or commit; defaults to the default branch.'),
      path_prefix: z.string().max(4096).optional(),
      max_entries: z.number().int().min(1).max(20_000).default(2_000),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const ref = args.ref ?? (await defaultBranch(ctx, repo));
      const { entries, truncated } = await listTree(ctx, repo, ref, args.max_entries);
      const prefix = args.path_prefix?.replace(/^\/+/, '');
      const filtered = prefix ? entries.filter((e) => e.path.startsWith(prefix)) : entries;
      return {
        ref,
        truncated,
        count: filtered.length,
        entries: filtered.map((e) => (e.type === 'blob' ? `${e.path} (${e.size ?? 0} B)` : `${e.path}/`)),
      };
    },
  }),
  defineTool({
    name: 'files_find',
    module: M,
    title: 'Find files by name',
    description:
      'Finds files whose path matches a glob pattern (e.g. "**/*.ts", "src/**/config.*") or contains a substring.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      pattern: z.string().min(1).max(500).describe('Glob (with * ** ?) or plain substring.'),
      ref: refSchema.optional(),
      limit: z.number().int().min(1).max(5000).default(200),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const ref = args.ref ?? (await defaultBranch(ctx, repo));
      const { entries, truncated } = await listTree(ctx, repo, ref, 50_000);
      const isGlob = /[*?]/.test(args.pattern);
      const re = isGlob ? globToRegExp(args.pattern) : undefined;
      const needle = args.pattern.toLowerCase();
      const matches = entries
        .filter((e) => e.type === 'blob')
        .filter((e) => (re ? re.test(e.path) : e.path.toLowerCase().includes(needle)))
        .map((e) => e.path);
      return { ref, tree_truncated: truncated, total: matches.length, files: matches.slice(0, args.limit) };
    },
  }),
  defineTool({
    name: 'code_search',
    module: M,
    title: 'Search repository contents',
    description:
      'Searches file contents for a text (or regular expression) and returns matching lines with line numbers. The Gitea API has no code-search endpoint, so this scans files via the API: narrow it with `path_glob` for large repositories. Files larger than 512 KB and binary files are skipped.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      query: z.string().min(1).max(200),
      regex: z.boolean().default(false).describe('Interpret `query` as a JavaScript regular expression.'),
      case_sensitive: z.boolean().default(false),
      path_glob: z
        .string()
        .max(500)
        .optional()
        .describe('Only search files matching this glob, e.g. "src/**/*.ts".'),
      ref: refSchema.optional(),
      max_files: z.number().int().min(1).max(1000).default(300).describe('Maximum number of files to scan.'),
      max_matches: z.number().int().min(1).max(1000).default(100),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const ref = args.ref ?? (await defaultBranch(ctx, repo));
      let matcher: RegExp;
      try {
        const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matcher = new RegExp(source, args.case_sensitive ? '' : 'i');
      } catch (err) {
        throw new GiteaError('INVALID_INPUT', `Invalid regular expression: ${(err as Error).message}`);
      }
      const { entries } = await listTree(ctx, repo, ref, 50_000);
      const glob = args.path_glob ? globToRegExp(args.path_glob) : undefined;
      const candidates = entries.filter(
        (e) => e.type === 'blob' && (e.size ?? 0) <= 512 * 1024 && (!glob || glob.test(e.path)),
      );
      const scanned = candidates.slice(0, args.max_files);
      const matches: { path: string; line: number; text: string }[] = [];
      await mapLimit(scanned, 6, async (entry) => {
        if (matches.length >= args.max_matches) return;
        let text: string | undefined;
        try {
          text = await readTextFile(ctx, repo, entry.path, ref);
        } catch {
          return; // binary or unreadable
        }
        if (text === undefined) return;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < args.max_matches; i++) {
          if (matcher.test(lines[i]!))
            matches.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      });
      matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      return {
        ref,
        files_scanned: scanned.length,
        files_skipped: candidates.length - scanned.length,
        match_count: matches.length,
        limit_reached: matches.length >= args.max_matches,
        matches,
      };
    },
  }),
  defineTool({
    name: 'file_create',
    module: M,
    title: 'Create file',
    description: 'Creates a new file with the given text content in one commit.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      path: pathSchema,
      content: z
        .string()
        .max(10 * 1024 * 1024)
        .describe('File content (UTF-8 text).'),
      ...commitShape,
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request<{
        commit?: { sha?: string; html_url?: string };
        content?: { sha?: string };
      }>({
        method: 'POST',
        path: `${repo.api}/contents/${filePath(args.path)}`,
        body: {
          ...commitBody(args),
          message: args.message ?? `Create ${args.path}`,
          content: Buffer.from(args.content, 'utf8').toString('base64'),
        },
      });
      return {
        created: args.path,
        commit: res.data.commit?.sha,
        file_sha: res.data.content?.sha,
        html_url: res.data.commit?.html_url,
      };
    },
  }),
  defineTool({
    name: 'file_update',
    module: M,
    title: 'Update file',
    description:
      'Replaces the content of an existing file in one commit. The current blob SHA is looked up automatically if not supplied; pass `sha` to guard against concurrent changes.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      path: pathSchema,
      content: z.string().max(10 * 1024 * 1024),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .optional()
        .describe('Expected current blob SHA.'),
      from_path: z.string().max(4096).optional().describe('Rename: the old path of the file.'),
      ...commitShape,
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const sourcePath = args.from_path ?? args.path;
      const sha = args.sha ?? (await currentSha(ctx, repo, sourcePath, args.branch));
      const res = await ctx.client.request<{
        commit?: { sha?: string; html_url?: string };
        content?: { sha?: string };
      }>({
        method: 'PUT',
        path: `${repo.api}/contents/${filePath(args.path)}`,
        body: body({
          ...commitBody(args),
          message: args.message ?? `Update ${args.path}`,
          content: Buffer.from(args.content, 'utf8').toString('base64'),
          sha,
          from_path: args.from_path,
        }),
      });
      return {
        updated: args.path,
        commit: res.data.commit?.sha,
        file_sha: res.data.content?.sha,
        html_url: res.data.commit?.html_url,
      };
    },
  }),
  defineTool({
    name: 'file_delete',
    module: M,
    title: 'Delete file',
    description: 'Deletes a file in a new commit. Requires destructive operations and user confirmation.',
    access: 'destructive',
    input: {
      ...profileShape,
      ...repoShape,
      path: pathSchema,
      sha: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .optional(),
      ...commitShape,
    },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}:${args.path}`,
        action: `Delete file ${args.path} from ${repo.fullName}${args.branch ? ` on branch ${args.branch}` : ''} (a commit is created; history keeps the old version).`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const sha = args.sha ?? (await currentSha(ctx, repo, args.path, args.branch));
      const res = await ctx.client.request<{ commit?: { sha?: string } }>({
        method: 'DELETE',
        path: `${repo.api}/contents/${filePath(args.path)}`,
        body: { ...commitBody(args), message: args.message ?? `Delete ${args.path}`, sha },
      });
      return { deleted: args.path, commit: res.data.commit?.sha };
    },
  }),
  defineTool({
    name: 'files_commit',
    module: M,
    title: 'Commit multiple file changes',
    description:
      'Creates, updates, renames and deletes several files in a single commit. For updates and deletes the current SHA is resolved automatically. Deleting files through this tool requires destructive operations to be enabled.',
    access: 'write',
    feature: 'multi_file_commit',
    input: {
      ...profileShape,
      ...repoShape,
      files: z
        .array(
          z.object({
            operation: z.enum(['create', 'update', 'delete', 'rename']),
            path: pathSchema,
            content: z
              .string()
              .max(10 * 1024 * 1024)
              .optional()
              .describe('New content for create/update/rename.'),
            from_path: z.string().max(4096).optional().describe('Old path for rename.'),
          }),
        )
        .min(1)
        .max(100),
      ...commitShape,
      message: z.string().min(1).max(10_000).describe('Commit message.'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      if (
        args.files.some((f) => f.operation === 'delete') &&
        !(ctx.config.permissions.destructive && !ctx.profile.readOnly)
      ) {
        throw new GiteaError(
          'PERMISSION_DENIED',
          'Deleting files requires destructive operations to be enabled.',
          {
            hint: 'Enable "Allow destructive operations" in the plugin options, or remove the delete operations.',
          },
        );
      }
      const files = [];
      for (const f of args.files) {
        for (const p of [f.path, f.from_path]) if (p) filePath(p);
        if (f.operation !== 'delete' && f.content === undefined) {
          throw new GiteaError('INVALID_INPUT', `content is required for ${f.operation} of ${f.path}`);
        }
        if (f.operation === 'rename' && !f.from_path) {
          throw new GiteaError('INVALID_INPUT', `from_path is required to rename ${f.path}`);
        }
        const sha =
          f.operation === 'update' || f.operation === 'delete' || f.operation === 'rename'
            ? await currentSha(ctx, repo, f.from_path ?? f.path, args.branch)
            : undefined;
        files.push(
          body({
            operation: f.operation === 'rename' ? 'update' : f.operation,
            path: f.path,
            from_path: f.from_path,
            content: f.content === undefined ? undefined : Buffer.from(f.content, 'utf8').toString('base64'),
            sha,
          }),
        );
      }
      const res = await ctx.client.request<{ commit?: { sha?: string; html_url?: string } }>({
        method: 'POST',
        path: `${repo.api}/contents`,
        body: { ...commitBody(args), message: args.message, files },
      });
      return {
        committed: args.files.length,
        commit: res.data.commit?.sha,
        html_url: res.data.commit?.html_url,
      };
    },
  }),
  defineTool({
    name: 'file_compare',
    module: 'git',
    title: 'Compare a file between refs',
    description: 'Shows a unified diff of one file between two branches, tags or commits.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      path: pathSchema,
      base: refSchema.describe('Base ref'),
      head: refSchema.describe('Head ref'),
      head_path: z.string().max(4096).optional().describe('Path in head if the file was renamed.'),
      context_lines: z.number().int().min(0).max(20).default(3),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const headPath = args.head_path ?? args.path;
      const [a, b] = await Promise.all([
        readTextFile(ctx, repo, args.path, args.base),
        readTextFile(ctx, repo, headPath, args.head),
      ]);
      if (a === undefined && b === undefined) {
        throw new GiteaError('NOT_FOUND', `${args.path} exists in neither ${args.base} nor ${args.head}.`);
      }
      if (a === b) return { identical: true, path: args.path };
      const patch = createTwoFilesPatch(
        `${args.base}:${args.path}`,
        `${args.head}:${headPath}`,
        a ?? '',
        b ?? '',
        undefined,
        undefined,
        { context: args.context_lines },
      );
      const t = truncateText(patch, 200_000);
      return {
        identical: false,
        status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified',
        truncated: t.truncated,
        diff: t.text,
      };
    },
  }),
];
