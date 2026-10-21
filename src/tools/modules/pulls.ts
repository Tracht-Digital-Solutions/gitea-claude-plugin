import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import {
  compact,
  slimCommit,
  slimComment,
  slimPull,
  slimReview,
  slimReviewComment,
} from '../../gitea/models.js';
import {
  body,
  indexSchema,
  pagingShape,
  profileShape,
  repoPath,
  repoShape,
  requireSomeFields,
} from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';
import { formatDiff } from './git.js';
import { resolveLabelIds, resolveMilestoneId } from './issues.js';

const M = 'pull_requests';

interface RawPull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  mergeable: boolean;
  merged: boolean;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; repo?: { full_name: string } | null };
  user?: { login: string };
}

interface RawReview {
  state: string;
  stale?: boolean;
  dismissed?: boolean;
  official?: boolean;
  user?: { login: string } | null;
}

interface ProtectionRule {
  rule_name?: string;
  branch_name?: string;
  required_approvals?: number;
  enable_status_check?: boolean;
  status_check_contexts?: string[];
  block_on_rejected_reviews?: boolean;
  block_on_outdated_branch?: boolean;
  block_on_official_review_requests?: boolean;
}

function globMatch(pattern: string, name: string): boolean {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escape).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Evaluates whether a pull request can be merged: state, conflicts, approvals and status checks
 * required by the branch protection of the base branch, and blocking reviews.
 */
export async function mergeReadiness(ctx: ToolContext, owner: string, repo: string, index: number) {
  const base = repoPath(owner, repo);
  const pr = (await ctx.client.request<RawPull>({ path: `${base}/pulls/${index}` })).data;
  const [reviews, status, protections] = await Promise.all([
    ctx.client.paginate<RawReview>(`${base}/pulls/${index}/reviews`, {}, { limit: 200 }).then((r) => r.items),
    ctx.client
      .request<{ state: string; statuses?: { context: string; status: string }[] }>({
        path: `${base}/commits/${encodeURIComponent(pr.head.sha)}/status`,
      })
      .then((r) => r.data)
      .catch(() => undefined),
    ctx.client
      .request<ProtectionRule[]>({ path: `${base}/branch_protections` })
      .then((r) => r.data)
      .catch(() => [] as ProtectionRule[]),
  ]);
  const rule = protections.find((p) => {
    const name = p.rule_name ?? p.branch_name ?? '';
    return name === pr.base.ref || globMatch(name, pr.base.ref);
  });

  // Latest review per reviewer counts.
  const latest = new Map<string, RawReview>();
  for (const r of reviews) {
    const who = r.user?.login;
    if (!who || r.state === 'COMMENT' || r.state === 'PENDING' || r.state === 'REQUEST_REVIEW') continue;
    latest.set(who, r);
  }
  const effective = [...latest.values()].filter((r) => !r.dismissed);
  const approvals = effective.filter((r) => r.state === 'APPROVED' && !r.stale).length;
  const changesRequested = effective.filter((r) => r.state === 'REQUEST_CHANGES').map((r) => r.user?.login);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (pr.merged) blockers.push('Pull request is already merged.');
  else if (pr.state !== 'open') blockers.push('Pull request is closed.');
  if (pr.draft) blockers.push('Pull request is a draft (WIP).');
  if (!pr.mergeable && !pr.merged)
    blockers.push(
      'Gitea reports the pull request as not mergeable (merge conflicts or the head branch is outdated).',
    );
  const required = rule?.required_approvals ?? 0;
  if (approvals < required) blockers.push(`Needs ${required} approval(s), has ${approvals}.`);
  if (changesRequested.length) {
    (rule?.block_on_rejected_reviews ? blockers : warnings).push(
      `Changes requested by: ${changesRequested.join(', ')}.`,
    );
  }
  if (status) {
    if (rule?.enable_status_check) {
      const contexts = rule.status_check_contexts ?? [];
      const relevant = contexts.length
        ? (status.statuses ?? []).filter((s) => contexts.some((c) => globMatch(c, s.context)))
        : (status.statuses ?? []);
      const failing = relevant.filter((s) => s.status !== 'success');
      if (failing.length)
        blockers.push(
          `Required status checks not successful: ${failing.map((s) => `${s.context}=${s.status}`).join(', ')}.`,
        );
      const missing = contexts.filter((c) => !(status.statuses ?? []).some((s) => globMatch(c, s.context)));
      if (missing.length) blockers.push(`Required status checks have not reported: ${missing.join(', ')}.`);
    } else if (status.state !== 'success' && (status.statuses ?? []).length > 0) {
      warnings.push(`Combined commit status is "${status.state}".`);
    }
  }
  return {
    pull: slimPull(pr),
    mergeable_by_gitea: pr.mergeable,
    ready_to_merge: blockers.length === 0,
    blockers,
    warnings,
    approvals,
    required_approvals: required,
    changes_requested_by: changesRequested.length ? changesRequested : undefined,
    commit_status: status
      ? compact({ state: status.state, checks: status.statuses?.map((s) => `${s.context}: ${s.status}`) })
      : undefined,
    protection_rule: rule ? (rule.rule_name ?? rule.branch_name) : undefined,
  };
}

export const pullTools: ToolDefinition[] = [
  defineTool({
    name: 'pr_list',
    module: M,
    title: 'List pull requests',
    description:
      'Lists pull requests filtered by state, base branch, labels, milestone or author, with sorting.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      state: z.enum(['open', 'closed', 'all']).default('open'),
      base_branch: z.string().max(255).optional(),
      labels: z.array(z.number().int()).optional().describe('Label ids'),
      milestone: z.number().int().optional().describe('Milestone id'),
      poster: z.string().optional().describe('Author login'),
      sort: z
        .enum([
          'oldest',
          'recentupdate',
          'recentclose',
          'leastupdate',
          'mostcomment',
          'leastcomment',
          'priority',
        ])
        .optional(),
      ...pagingShape,
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate(
        `${repoPath(owner, repo)}/pulls`,
        {
          state: args.state,
          base_branch: args.base_branch,
          labels: args.labels,
          milestone: args.milestone,
          poster: args.poster,
          sort: args.sort,
        },
        args,
      );
      return { total: res.totalCount, has_more: res.hasMore, pulls: res.items.map((p) => slimPull(p)) };
    },
  }),
  defineTool({
    name: 'pr_get',
    module: M,
    title: 'Get pull request',
    description:
      'Returns a pull request with description, branches, mergeability, reviewers and change counts. Use pr_diff for the patch and pr_merge_check for merge readiness. Pass number 0 or omit it to get the most recently updated open pull request.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      number: z.number().int().min(0).default(0).describe('Pull request number; 0 = latest'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      let number = args.number;
      if (number === 0) {
        const latest = await ctx.client.request<RawPull[]>({
          path: `${repoPath(owner, repo)}/pulls`,
          query: { state: 'all', sort: 'recentupdate', limit: 1 },
        });
        const first = latest.data[0];
        if (!first) throw new GiteaError('NOT_FOUND', `${owner}/${repo} has no pull requests.`);
        number = first.number;
      }
      const res = await ctx.client.request({ path: `${repoPath(owner, repo)}/pulls/${number}` });
      return slimPull(res.data, true);
    },
  }),
  defineTool({
    name: 'pr_create',
    module: M,
    title: 'Create pull request',
    description:
      'Opens a pull request from `head` into `base` (default: the default branch). For a branch in a fork use "owner:branch" as head. Push local branches first with local_branch_push.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      head: z.string().min(1).max(255).describe('Source branch, or "fork-owner:branch"'),
      base: z.string().max(255).optional().describe('Target branch (default branch if omitted)'),
      title: z.string().min(1).max(255),
      body: z.string().max(65_535).optional(),
      draft: z.boolean().default(false).describe('Create as work in progress (title prefixed with "WIP:").'),
      assignees: z.array(z.string()).max(20).optional(),
      reviewers: z.array(z.string()).max(20).optional(),
      team_reviewers: z.array(z.string()).max(20).optional(),
      labels: z
        .array(z.union([z.string(), z.number().int()]))
        .max(50)
        .optional(),
      milestone: z.union([z.string(), z.number().int()]).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      let baseBranch = args.base;
      if (!baseBranch) {
        baseBranch = (await ctx.client.request<{ default_branch: string }>({ path: repoPath(owner, repo) }))
          .data.default_branch;
      }
      const title =
        args.draft && !/^(wip|\[wip\])[:\s]/i.test(args.title) ? `WIP: ${args.title}` : args.title;
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/pulls`,
        body: body({
          head: args.head,
          base: baseBranch,
          title,
          body: args.body,
          assignees: args.assignees,
          reviewers: args.reviewers,
          team_reviewers: args.team_reviewers,
          labels: args.labels ? await resolveLabelIds(ctx, owner, repo, args.labels) : undefined,
          milestone: await resolveMilestoneId(ctx, owner, repo, args.milestone),
        }),
      });
      return { created: true, pull: slimPull(res.data) };
    },
  }),
  defineTool({
    name: 'pr_update',
    module: M,
    title: 'Edit pull request',
    description:
      'Edits title, description, base branch, assignees, labels, milestone or state of a pull request.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      title: z.string().min(1).max(255).optional(),
      body: z.string().max(65_535).optional(),
      base: z.string().max(255).optional(),
      assignees: z.array(z.string()).max(20).optional(),
      labels: z
        .array(z.union([z.string(), z.number().int()]))
        .max(50)
        .optional(),
      milestone: z.union([z.string(), z.number().int()]).optional(),
      state: z.enum(['open', 'closed']).optional(),
      allow_maintainer_edit: z.boolean().optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const payload = body({
        title: args.title,
        body: args.body,
        base: args.base,
        assignees: args.assignees,
        labels: args.labels ? await resolveLabelIds(ctx, owner, repo, args.labels) : undefined,
        milestone: await resolveMilestoneId(ctx, owner, repo, args.milestone),
        state: args.state,
        allow_maintainer_edit: args.allow_maintainer_edit,
      });
      requireSomeFields(payload, `pull request #${args.number}`);
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repoPath(owner, repo)}/pulls/${args.number}`,
        body: payload,
      });
      return { updated: Object.keys(payload), pull: slimPull(res.data) };
    },
  }),
  defineTool({
    name: 'pr_close',
    module: M,
    title: 'Close pull request',
    description:
      'Closes a pull request without merging, optionally with a comment. It can be reopened with pr_update.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      comment: z.string().max(65_535).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = repoPath(owner, repo);
      if (args.comment) {
        await ctx.client.request({
          method: 'POST',
          path: `${base}/issues/${args.number}/comments`,
          body: { body: args.comment },
        });
      }
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${base}/pulls/${args.number}`,
        body: { state: 'closed' },
      });
      return { pull: slimPull(res.data) };
    },
  }),
  defineTool({
    name: 'pr_diff',
    module: M,
    title: 'Get pull request diff',
    description:
      'Returns the unified diff of a pull request with per-file addition/deletion counts. Use `files` to show only some files of large diffs.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      files: z
        .array(z.string())
        .optional()
        .describe('Only show files whose path contains one of these strings.'),
      max_chars: z.number().int().min(1000).max(500_000).default(80_000),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request<string>({
        path: `${repoPath(owner, repo)}/pulls/${args.number}.diff`,
        responseType: 'text',
        maxBytes: 30 * 1024 * 1024,
      });
      return formatDiff(res.data, { files: args.files, maxChars: args.max_chars });
    },
  }),
  defineTool({
    name: 'pr_files',
    module: M,
    title: 'List changed files of a pull request',
    description: 'Lists the files changed by a pull request with status and line counts.',
    access: 'read',
    input: { ...profileShape, ...repoShape, number: indexSchema('pull request'), ...pagingShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate<Record<string, unknown>>(
        `${repoPath(owner, repo)}/pulls/${args.number}/files`,
        {},
        args,
      );
      return {
        total: res.totalCount,
        has_more: res.hasMore,
        files: res.items.map((f) =>
          compact({
            filename: f.filename,
            previous_filename: f.previous_filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          }),
        ),
      };
    },
  }),
  defineTool({
    name: 'pr_commits',
    module: M,
    title: 'List pull request commits',
    description: 'Lists the commits contained in a pull request.',
    access: 'read',
    input: { ...profileShape, ...repoShape, number: indexSchema('pull request'), ...pagingShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate(
        `${repoPath(owner, repo)}/pulls/${args.number}/commits`,
        { verification: false, files: false },
        args,
      );
      return { total: res.totalCount, has_more: res.hasMore, commits: res.items.map((c) => slimCommit(c)) };
    },
  }),
  defineTool({
    name: 'pr_reviews',
    module: M,
    title: 'Get pull request reviews',
    description:
      'Lists the reviews of a pull request with their state and, optionally, their inline comments.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      include_comments: z.boolean().default(true),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/pulls/${args.number}/reviews`;
      const reviews = await ctx.client.paginate<{ id: number }>(base, {}, { limit: 200 });
      const out = [];
      for (const r of reviews.items) {
        const item: Record<string, unknown> = slimReview(r);
        if (args.include_comments) {
          const comments = await ctx.client.request<unknown[]>({ path: `${base}/${r.id}/comments` });
          if (comments.data.length) item.comments = comments.data.map(slimReviewComment);
        }
        out.push(item);
      }
      const conversation = await ctx.client.list(`${repoPath(owner, repo)}/issues/${args.number}/comments`);
      return { reviews: out, conversation: conversation.slice(-100).map(slimComment) };
    },
  }),
  defineTool({
    name: 'pr_review_create',
    module: M,
    title: 'Review pull request',
    description:
      'Submits a review: APPROVED, REQUEST_CHANGES or COMMENT, with an overall body and optional inline comments (path + line in the new file, or old_line for removed lines). Use PENDING to create a draft review.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      event: z.enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT', 'PENDING']).default('COMMENT'),
      body: z.string().max(65_535).optional(),
      comments: z
        .array(
          z.object({
            path: z.string().min(1).max(4096),
            body: z.string().min(1).max(65_535),
            line: z.number().int().min(1).optional().describe('Line number in the new version of the file'),
            old_line: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Line number in the old version (for removed lines)'),
          }),
        )
        .max(100)
        .optional(),
      commit_id: z.string().optional().describe('Commit the review refers to (default: head).'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      if (args.event === 'REQUEST_CHANGES' && !args.body) {
        throw new GiteaError('INVALID_INPUT', 'A body is required when requesting changes.');
      }
      const comments = args.comments?.map((c) => {
        if (!c.line && !c.old_line)
          throw new GiteaError('INVALID_INPUT', `Inline comment on ${c.path} needs line or old_line.`);
        return body({ path: c.path, body: c.body, new_position: c.line, old_position: c.old_line });
      });
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/pulls/${args.number}/reviews`,
        body: body({ event: args.event, body: args.body, comments, commit_id: args.commit_id }),
      });
      return { created: true, review: slimReview(res.data) };
    },
  }),
  defineTool({
    name: 'pr_review_submit',
    module: M,
    title: 'Submit pending review',
    description: 'Submits a previously created PENDING review with a final verdict.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      review_id: z.number().int().min(1),
      event: z.enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']),
      body: z.string().max(65_535).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/pulls/${args.number}/reviews/${args.review_id}`,
        body: body({ event: args.event, body: args.body }),
      });
      return { review: slimReview(res.data) };
    },
  }),
  defineTool({
    name: 'pr_request_reviewers',
    module: M,
    title: 'Request reviewers',
    description: 'Requests reviews from users and/or teams, or removes review requests.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      reviewers: z.array(z.string()).max(20).optional(),
      team_reviewers: z.array(z.string()).max(20).optional(),
      remove: z.boolean().default(false).describe('Remove these review requests instead of adding them.'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      if (!args.reviewers?.length && !args.team_reviewers?.length) {
        throw new GiteaError('INVALID_INPUT', 'Provide reviewers or team_reviewers.');
      }
      await ctx.client.request({
        method: args.remove ? 'DELETE' : 'POST',
        path: `${repoPath(owner, repo)}/pulls/${args.number}/requested_reviewers`,
        body: body({ reviewers: args.reviewers, team_reviewers: args.team_reviewers }),
      });
      return {
        action: args.remove ? 'removed' : 'requested',
        reviewers: args.reviewers,
        team_reviewers: args.team_reviewers,
      };
    },
  }),
  defineTool({
    name: 'pr_merge_check',
    module: M,
    title: 'Check merge readiness',
    description:
      'Checks whether a pull request can be merged: open/draft state, merge conflicts, required approvals and status checks from branch protection, and change requests. Returns blockers and warnings.',
    access: 'read',
    input: { ...profileShape, ...repoShape, number: indexSchema('pull request') },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return mergeReadiness(ctx, owner, repo, args.number);
    },
  }),
  defineTool({
    name: 'pr_merge',
    module: M,
    title: 'Merge pull request',
    description:
      'Merges a pull request with the chosen style (merge, rebase, rebase-merge, squash, fast-forward-only). Runs the merge readiness check first and refuses when blockers exist. Merging changes the target branch, so the user must confirm.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      style: z.enum(['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only']).default('merge'),
      title: z.string().max(255).optional().describe('Merge commit title'),
      message: z.string().max(65_535).optional().describe('Merge commit message'),
      delete_branch_after_merge: z.boolean().optional(),
      merge_when_checks_succeed: z.boolean().default(false).describe('Schedule auto-merge once checks pass.'),
    },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const pr = (
        await ctx.client.request<RawPull>({ path: `${repoPath(owner, repo)}/pulls/${args.number}` })
      ).data;
      return {
        target: `${owner}/${repo}#${args.number}`,
        action: `Merge pull request #${args.number} "${pr.title}" (${pr.head.ref} → ${pr.base.ref}) in ${owner}/${repo} using "${args.style}"${args.delete_branch_after_merge ? ' and delete the head branch' : ''}.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const readiness = await mergeReadiness(ctx, owner, repo, args.number);
      if (!readiness.ready_to_merge && !args.merge_when_checks_succeed) {
        throw new GiteaError('CONFLICT', `Pull request #${args.number} is not ready to merge.`, {
          details: { blockers: readiness.blockers },
          hint: 'Resolve the blockers first (see pr_merge_check).',
        });
      }
      const head = (readiness.pull as { head_sha?: string }).head_sha;
      await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/pulls/${args.number}/merge`,
        body: body({
          // Field names as in the OpenAPI document; Gitea decodes JSON keys case-insensitively, so
          // older releases that declared "Do"/"MergeTitleField" accept them as well.
          do: args.style,
          merge_title_field: args.title,
          merge_message_field: args.message,
          delete_branch_after_merge: args.delete_branch_after_merge,
          merge_when_checks_succeed: args.merge_when_checks_succeed || undefined,
          head_commit_id: head,
        }),
      });
      const after = await ctx.client.request({ path: `${repoPath(owner, repo)}/pulls/${args.number}` });
      return {
        merged: (after.data as { merged?: boolean }).merged ?? false,
        scheduled: args.merge_when_checks_succeed || undefined,
        pull: slimPull(after.data),
      };
    },
  }),
  defineTool({
    name: 'pr_update_branch',
    module: M,
    title: 'Update pull request branch',
    description:
      'Updates the head branch of a pull request with the latest changes of the base branch (merge or rebase).',
    access: 'write',
    feature: 'pr_update_branch',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('pull request'),
      style: z.enum(['merge', 'rebase']).default('merge'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/pulls/${args.number}/update`,
        query: { style: args.style },
      });
      return { updated: true, number: args.number, style: args.style };
    },
  }),
];
