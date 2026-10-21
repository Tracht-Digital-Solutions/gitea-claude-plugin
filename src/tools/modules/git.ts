import { createTwoFilesPatch } from 'diff';
import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact, slimBranch, slimBranchProtection, slimCommit, slimTag } from '../../gitea/models.js';
import { localContext, pushBranch } from '../../git/local.js';
import { readTextFile } from './contents.js';
import {
  body,
  dateSchema,
  pagingShape,
  profileShape,
  refSchema,
  repoShape,
  truncateText,
} from '../common.js';
import { defineTool, type ToolDefinition } from '../types.js';

const M = 'git';
const branchName = z.string().min(1).max(255).describe('Branch name');
const tagName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !v.startsWith('-') && !/[\s~^:?*[\\]/.test(v) && !v.includes('..'), 'invalid tag name')
  .describe('Tag name, e.g. v1.2.0');

const protectionFields = {
  enable_push: z.boolean().optional().describe('Allow pushing to the branch at all.'),
  enable_push_whitelist: z.boolean().optional(),
  push_whitelist_usernames: z.array(z.string()).optional(),
  push_whitelist_teams: z.array(z.string()).optional(),
  enable_force_push: z.boolean().optional(),
  enable_merge_whitelist: z.boolean().optional(),
  merge_whitelist_usernames: z.array(z.string()).optional(),
  merge_whitelist_teams: z.array(z.string()).optional(),
  enable_status_check: z.boolean().optional(),
  status_check_contexts: z.array(z.string()).optional(),
  required_approvals: z.number().int().min(0).max(100).optional(),
  enable_approvals_whitelist: z.boolean().optional(),
  approvals_whitelist_username: z.array(z.string()).optional(),
  approvals_whitelist_teams: z.array(z.string()).optional(),
  block_on_rejected_reviews: z.boolean().optional(),
  block_on_official_review_requests: z.boolean().optional(),
  block_on_outdated_branch: z.boolean().optional(),
  dismiss_stale_approvals: z.boolean().optional(),
  ignore_stale_approvals: z.boolean().optional(),
  require_signed_commits: z.boolean().optional(),
  protected_file_patterns: z.string().optional(),
  unprotected_file_patterns: z.string().optional(),
  block_admin_merge_override: z.boolean().optional(),
};

/** Splits a diff into per-file sections so large diffs can be filtered and summarised. */
export function splitDiff(
  diff: string,
): { file: string; additions: number; deletions: number; text: string }[] {
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  return parts.map((text) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
    let additions = 0;
    let deletions = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return { file: header?.[2] ?? header?.[1] ?? '?', additions, deletions, text };
  });
}

export function formatDiff(
  diff: string,
  opts: { files?: string[] | undefined; maxChars: number },
): Record<string, unknown> {
  const sections = splitDiff(diff);
  const selected = opts.files?.length
    ? sections.filter((s) => opts.files!.some((f) => s.file.includes(f)))
    : sections;
  const t = truncateText(selected.map((s) => s.text).join(''), opts.maxChars);
  return {
    files: sections.map((s) => ({ file: s.file, additions: s.additions, deletions: s.deletions })),
    shown_files: opts.files?.length ? selected.map((s) => s.file) : undefined,
    truncated: t.truncated,
    diff: t.text,
  };
}

interface CommitWithFiles {
  files?: { filename: string; status: string }[];
}

interface CommitLike {
  sha: string;
  commit: { message: string; author: { name: string; email: string; date: string } };
  author?: { login?: string } | null;
  stats?: { additions: number; deletions: number };
}

/** Conventional commit type of a commit message ("feat", "fix", …) or "other". */
export function commitType(message: string): { type: string; breaking: boolean; scope?: string } {
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s/.exec(message);
  const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(message);
  if (!m) return { type: 'other', breaking };
  return { type: m[1]!.toLowerCase(), breaking, ...(m[2] ? { scope: m[2] } : {}) };
}

export function analyzeCommits(commits: CommitLike[]) {
  const authors = new Map<string, number>();
  const types = new Map<string, number>();
  const days = new Map<string, number>();
  let breaking = 0;
  for (const c of commits) {
    const name = c.author?.login ?? c.commit.author.name;
    authors.set(name, (authors.get(name) ?? 0) + 1);
    const t = commitType(c.commit.message);
    types.set(t.type, (types.get(t.type) ?? 0) + 1);
    if (t.breaking) breaking++;
    const day = c.commit.author.date.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const sortDesc = (m: Map<string, number>) =>
    [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, commits: v }));
  const dates = commits.map((c) => c.commit.author.date).sort();
  return {
    commit_count: commits.length,
    first_commit_date: dates[0],
    last_commit_date: dates[dates.length - 1],
    authors: sortDesc(authors),
    conventional_types: Object.fromEntries([...types].sort((a, b) => b[1] - a[1])),
    breaking_changes: breaking,
    conventional_ratio: commits.length
      ? Number(((commits.length - (types.get('other') ?? 0)) / commits.length).toFixed(2))
      : undefined,
    busiest_days: sortDesc(days).slice(0, 7),
  };
}

export const gitTools: ToolDefinition[] = [
  defineTool({
    name: 'branch_list',
    module: M,
    title: 'List branches',
    description: 'Lists the branches of a repository with their latest commit and protection status.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ...pagingShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate(`${repo.api}/branches`, {}, args);
      return { total: res.totalCount, has_more: res.hasMore, branches: res.items.map(slimBranch) };
    },
  }),
  defineTool({
    name: 'branch_get',
    module: M,
    title: 'Get branch',
    description: 'Returns one branch with its head commit and whether you may push or merge.',
    access: 'read',
    input: { ...profileShape, ...repoShape, branch: branchName },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request({
        path: `${repo.api}/branches/${encodeURIComponent(args.branch)}`,
      });
      return slimBranch(res.data);
    },
  }),
  defineTool({
    name: 'branch_create',
    module: M,
    title: 'Create branch',
    description: 'Creates a branch from an existing branch, tag or commit (default: the default branch).',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      branch: branchName.describe('Name of the new branch'),
      from: refSchema.optional().describe('Branch, tag or commit SHA to start from.'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repo.api}/branches`,
        body: body({ new_branch_name: args.branch, old_ref_name: args.from }),
      });
      return { created: true, branch: slimBranch(res.data) };
    },
  }),
  defineTool({
    name: 'branch_delete',
    module: M,
    title: 'Delete branch',
    description:
      'Deletes a branch. Commits that are not merged elsewhere become unreachable. Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, branch: branchName },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${args.branch}`,
        action: `Delete branch "${args.branch}" in ${repo.fullName}. Unmerged commits on it may be lost.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repo.api}/branches/${encodeURIComponent(args.branch)}`,
      });
      return { deleted: args.branch };
    },
  }),
  defineTool({
    name: 'compare',
    module: M,
    title: 'Compare branches or refs',
    description:
      'Compares two branches, tags or commits (base...head): lists the commits head is ahead by and the files they change. With include_diff, unified diffs of the changed files are computed (up to max_diff_files).',
    access: 'read',
    feature: 'compare',
    input: {
      ...profileShape,
      ...repoShape,
      base: refSchema,
      head: refSchema,
      include_diff: z.boolean().default(false),
      max_diff_files: z.number().int().min(1).max(100).default(25),
      max_diff_chars: z.number().int().min(1000).max(500_000).default(60_000),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const basehead = `${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`;
      const res = await ctx.client.request<{ total_commits?: number; commits?: CommitWithFiles[] }>({
        path: `${repo.api}/compare/${basehead}`,
      });
      const commits = res.data.commits ?? [];
      const files = new Map<string, string>();
      for (const c of commits) for (const f of c.files ?? []) files.set(f.filename, f.status);
      const out: Record<string, unknown> = {
        base: args.base,
        head: args.head,
        total_commits: res.data.total_commits ?? commits.length,
        commits: commits.slice(0, 250).map((c) => slimCommit(c)),
        changed_files: [...files].map(([filename, status]) => ({ filename, status })),
      };
      if (args.include_diff) {
        const names = [...files.keys()].slice(0, args.max_diff_files);
        const patches: string[] = [];
        for (const name of names) {
          const [a, b] = await Promise.all([
            readTextFile(ctx, repo, name, args.base).catch(() => undefined),
            readTextFile(ctx, repo, name, args.head).catch(() => undefined),
          ]);
          if (a === b) continue;
          patches.push(createTwoFilesPatch(`a/${name}`, `b/${name}`, a ?? '', b ?? '', args.base, args.head));
        }
        const t = truncateText(patches.join('\n'), args.max_diff_chars);
        out.diff = t.text;
        out.diff_truncated = t.truncated || files.size > names.length;
      }
      return out;
    },
  }),
  defineTool({
    name: 'commit_list',
    module: M,
    title: 'List commits',
    description: 'Lists commits of a branch/ref, optionally filtered by path and date range. Newest first.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      ref: refSchema.optional().describe('Branch, tag or SHA (default branch if omitted).'),
      path: z.string().max(4096).optional().describe('Only commits touching this path.'),
      since: dateSchema.optional(),
      until: dateSchema.optional(),
      with_files: z.boolean().default(false).describe('Include changed file names.'),
      ...pagingShape,
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate(
        `${repo.api}/commits`,
        {
          sha: args.ref,
          path: args.path,
          since: args.since,
          until: args.until,
          stat: false,
          verification: false,
          files: args.with_files,
        },
        args,
      );
      return {
        total: res.totalCount,
        has_more: res.hasMore,
        commits: res.items.map((c) => slimCommit(c, args.with_files)),
      };
    },
  }),
  defineTool({
    name: 'commit_get',
    module: M,
    title: 'Get commit details',
    description:
      'Returns a commit with message, author, stats and changed files; set include_diff for the patch.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      sha: refSchema.describe('Commit SHA (or branch/tag name for its head commit)'),
      include_diff: z.boolean().default(false),
      max_diff_chars: z.number().int().min(1000).max(500_000).default(60_000),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const base = repo.api;
      const res = await ctx.client.request({
        path: `${base}/git/commits/${encodeURIComponent(args.sha)}`,
        query: { stat: true, files: true, verification: false },
      });
      const out: Record<string, unknown> = slimCommit(res.data, true);
      if (args.include_diff) {
        const diff = await ctx.client.request<string>({
          path: `${base}/git/commits/${encodeURIComponent(args.sha)}.diff`,
          responseType: 'text',
          maxBytes: 20 * 1024 * 1024,
        });
        out.diff = formatDiff(diff.data, { maxChars: args.max_diff_chars });
      }
      return out;
    },
  }),
  defineTool({
    name: 'commit_history_analyze',
    module: M,
    title: 'Analyse commit history',
    description:
      'Analyses recent commit history of a ref: commits per author, Conventional Commit types, breaking changes, activity by day and date range.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      ref: refSchema.optional(),
      since: dateSchema.optional(),
      until: dateSchema.optional(),
      path: z.string().max(4096).optional(),
      max_commits: z.number().int().min(1).max(2000).default(300),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate<CommitLike>(
        `${repo.api}/commits`,
        {
          sha: args.ref,
          since: args.since,
          until: args.until,
          path: args.path,
          stat: false,
          verification: false,
          files: false,
        },
        { limit: args.max_commits },
      );
      return { ref: args.ref ?? 'default branch', analysed_all: !res.hasMore, ...analyzeCommits(res.items) };
    },
  }),
  defineTool({
    name: 'commit_status_get',
    module: M,
    title: 'Get commit status checks',
    description:
      'Returns the combined CI status (Gitea Actions and external status checks) for a commit, branch or tag.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ref: refSchema },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request<{
        state: string;
        sha: string;
        total_count: number;
        statuses?: unknown[];
      }>({
        path: `${repo.api}/commits/${encodeURIComponent(args.ref)}/status`,
      });
      return {
        sha: res.data.sha,
        state: res.data.state,
        total_count: res.data.total_count,
        statuses: (res.data.statuses ?? []).map((s) => {
          const x = s as Record<string, unknown>;
          return compact({
            context: x.context,
            status: x.status,
            description: x.description,
            target_url: x.target_url,
            updated_at: x.updated_at,
          });
        }),
      };
    },
  }),
  defineTool({
    name: 'tag_list',
    module: M,
    title: 'List tags',
    description: 'Lists tags with the commit they point to.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ...pagingShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate(`${repo.api}/tags`, {}, args);
      return { total: res.totalCount, has_more: res.hasMore, tags: res.items.map(slimTag) };
    },
  }),
  defineTool({
    name: 'tag_get',
    module: M,
    title: 'Get tag',
    description: 'Returns a tag with its message and commit.',
    access: 'read',
    input: { ...profileShape, ...repoShape, tag: tagName },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request({
        path: `${repo.api}/tags/${encodeURIComponent(args.tag)}`,
      });
      return slimTag(res.data);
    },
  }),
  defineTool({
    name: 'tag_create',
    module: M,
    title: 'Create tag',
    description: 'Creates a tag (annotated when a message is given) on a branch or commit.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      tag: tagName,
      target: refSchema.optional().describe('Branch or commit SHA (default branch if omitted).'),
      message: z.string().max(10_000).optional().describe('Annotation message.'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repo.api}/tags`,
        body: body({ tag_name: args.tag, target: args.target, message: args.message }),
      });
      return { created: true, tag: slimTag(res.data) };
    },
  }),
  defineTool({
    name: 'tag_delete',
    module: M,
    title: 'Delete tag',
    description: 'Deletes a tag. Releases that use it lose their tag. Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, tag: tagName },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${args.tag}`,
        action: `Delete tag "${args.tag}" in ${repo.fullName}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repo.api}/tags/${encodeURIComponent(args.tag)}`,
      });
      return { deleted: args.tag };
    },
  }),
  defineTool({
    name: 'branch_protection_list',
    module: M,
    title: 'List branch protection rules',
    description: 'Lists the branch protection rules of a repository.',
    access: 'read',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request<unknown[]>({
        path: `${repo.api}/branch_protections`,
      });
      return { rules: res.data.map(slimBranchProtection) };
    },
  }),
  defineTool({
    name: 'branch_protection_set',
    module: M,
    title: 'Create or update branch protection',
    description:
      'Creates a branch protection rule, or updates it if a rule with that name exists. `rule_name` may be a branch name or a glob such as "release/*". Administrative operation; requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      ...repoShape,
      rule_name: z.string().min(1).max(255).describe('Branch name or glob pattern'),
      ...protectionFields,
    },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${args.rule_name}`,
        action: `Create or change the branch protection rule "${args.rule_name}" in ${repo.fullName}. This changes who may push and merge.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const { profile: _p, owner: _o, repo: _r, rule_name, ...fields } = args;
      const base = `${repo.api}/branch_protections`;
      const exists = await ctx.client
        .request({ path: `${base}/${encodeURIComponent(rule_name)}` })
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof GiteaError && err.code === 'NOT_FOUND') return false;
          throw err;
        });
      const res = exists
        ? await ctx.client.request({
            method: 'PATCH',
            path: `${base}/${encodeURIComponent(rule_name)}`,
            body: body(fields),
          })
        : await ctx.client.request({ method: 'POST', path: base, body: body({ rule_name, ...fields }) });
      return { action: exists ? 'updated' : 'created', rule: slimBranchProtection(res.data) };
    },
  }),
  defineTool({
    name: 'branch_protection_delete',
    module: M,
    title: 'Delete branch protection',
    description: 'Removes a branch protection rule. Administrative operation; requires confirmation.',
    access: 'admin',
    input: { ...profileShape, ...repoShape, rule_name: z.string().min(1).max(255) },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${args.rule_name}`,
        action: `Remove the branch protection rule "${args.rule_name}" from ${repo.fullName}; the branch becomes unprotected.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repo.api}/branch_protections/${encodeURIComponent(args.rule_name)}`,
      });
      return { deleted: args.rule_name };
    },
  }),
  defineTool({
    name: 'tag_protection_list',
    module: M,
    title: 'List tag protection rules',
    description: 'Lists the protected tag patterns of a repository.',
    access: 'read',
    feature: 'tag_protections',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request<unknown[]>({ path: `${repo.api}/tag_protections` });
      return { rules: res.data.map(slimBranchProtection) };
    },
  }),
  defineTool({
    name: 'tag_protection_create',
    module: M,
    title: 'Protect tags',
    description:
      'Protects tags matching a pattern (glob or /regex/) so that only the listed users/teams may create or delete them. Administrative; requires confirmation.',
    access: 'admin',
    feature: 'tag_protections',
    input: {
      ...profileShape,
      ...repoShape,
      name_pattern: z.string().min(1).max(255).describe('e.g. "v*"'),
      whitelist_usernames: z.array(z.string()).optional(),
      whitelist_teams: z.array(z.string()).optional(),
    },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${args.name_pattern}`,
        action: `Protect tags matching "${args.name_pattern}" in ${repo.fullName}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repo.api}/tag_protections`,
        body: body({
          name_pattern: args.name_pattern,
          whitelist_usernames: args.whitelist_usernames,
          whitelist_teams: args.whitelist_teams,
        }),
      });
      return { created: true, rule: slimBranchProtection(res.data) };
    },
  }),
  defineTool({
    name: 'tag_protection_delete',
    module: M,
    title: 'Remove tag protection',
    description: 'Removes a tag protection rule by id. Administrative; requires confirmation.',
    access: 'admin',
    feature: 'tag_protections',
    input: { ...profileShape, ...repoShape, id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}#tag-protection-${args.id}`,
        action: `Remove tag protection rule ${args.id} from ${repo.fullName}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repo.api}/tag_protections/${args.id}`,
      });
      return { deleted: args.id };
    },
  }),
  defineTool({
    name: 'local_repo_context',
    module: M,
    title: 'Inspect local git repository',
    description:
      'Inspects the git repository in the current working directory: current branch, upstream, ahead/behind counts, uncommitted changes and which remote points to the configured Gitea server (repo.owner/repo.name). Use it before creating a pull request from local changes.',
    access: 'read',
    local: true,
    input: {
      ...profileShape,
      path: z
        .string()
        .max(4096)
        .optional()
        .describe('Directory inside the repository (default: working directory).'),
    },
    async run(args, ctx) {
      const base = ctx.maybeProfile?.baseUrl;
      const lc = await localContext(args.path ?? ctx.cwd, base);
      let note: string | undefined;
      if (!base) note = 'No Gitea server configured; remotes cannot be matched to Gitea repositories.';
      else if (!lc.remotes.some((r) => r.giteaRepo)) {
        note = `No remote points to ${base.host}. Pass repo.owner/repo.name explicitly to the Gitea tools.`;
      }
      return { ...lc, gitea_remote: lc.remotes.find((r) => r.giteaRepo)?.name, note };
    },
  }),
  defineTool({
    name: 'local_branch_push',
    module: M,
    title: 'Push local branch',
    description:
      'Pushes a local branch to a remote using your existing git credentials (the API token is never used for git). Never force-pushes. Typical use: push a feature branch before pr_create.',
    access: 'write',
    local: true,
    input: {
      ...profileShape,
      branch: z.string().min(1).max(255).optional().describe('Local branch (default: current branch).'),
      remote: z
        .string()
        .max(64)
        .optional()
        .describe('Remote name (default: the remote pointing to Gitea, else origin).'),
      set_upstream: z.boolean().default(true),
      path: z.string().max(4096).optional(),
    },
    async run(args, ctx) {
      const lc = await localContext(args.path ?? ctx.cwd, ctx.maybeProfile?.baseUrl);
      const branch = args.branch ?? lc.branch;
      if (!branch) throw new GiteaError('GIT_ERROR', 'Detached HEAD: specify the branch to push.');
      const remote = args.remote ?? lc.remotes.find((r) => r.giteaRepo)?.name ?? 'origin';
      if (!lc.remotes.some((r) => r.name === remote)) {
        throw new GiteaError('GIT_ERROR', `Remote "${remote}" does not exist in ${lc.root}.`);
      }
      const result = await pushBranch(lc.root, remote, branch, args.set_upstream);
      return { pushed: branch, remote, output: (result.stdout + result.stderr).trim().slice(0, 4000) };
    },
  }),
];
