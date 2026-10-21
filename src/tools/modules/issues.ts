import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { slimComment, slimIssue, slimLabel, slimMilestone } from '../../gitea/models.js';
import {
  body,
  colorSchema,
  dateSchema,
  indexSchema,
  pagingShape,
  profileShape,
  repoPath,
  repoShape,
  requireSomeFields,
  stateSchema,
} from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';

const M = 'issues';

interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels?: { id: number; name: string }[];
  assignees?: { login: string }[] | null;
  milestone?: { id: number; title: string } | null;
  created_at: string;
  updated_at: string;
  comments: number;
  user?: { login: string };
  html_url?: string;
}

const PRIORITY_PATTERNS: [string, RegExp][] = [
  ['critical', /(^|[/:\s-])(critical|blocker|urgent|p0|prio(rity)?[\s/:-]*(0|critical|urgent))\b/i],
  ['high', /(^|[/:\s-])(high|p1|prio(rity)?[\s/:-]*(1|high))\b/i],
  ['medium', /(^|[/:\s-])(medium|normal|p2|prio(rity)?[\s/:-]*(2|medium|normal))\b/i],
  ['low', /(^|[/:\s-])(low|minor|p3|p4|prio(rity)?[\s/:-]*(3|4|low))\b/i],
];

/** Derives a priority from label names like "priority/high", "P1", "Kind/Bug + Priority: Critical". */
export function priorityOf(labels: string[]): string | undefined {
  for (const [level, re] of PRIORITY_PATTERNS) {
    if (
      labels.some(
        (l) => /prio|^p\d|critical|blocker|urgent|high|medium|low|minor|normal/i.test(l) && re.test(l),
      )
    ) {
      return level;
    }
  }
  return undefined;
}

export function summarizeIssues(issues: RawIssue[], now = Date.now()) {
  const byLabel = new Map<string, number>();
  const byAssignee = new Map<string, number>();
  const byMilestone = new Map<string, number>();
  const byPriority = new Map<string, number>();
  const age = { under_7_days: 0, under_30_days: 0, under_90_days: 0, older: 0 };
  const stale: RawIssue[] = [];
  for (const i of issues) {
    const labels = (i.labels ?? []).map((l) => l.name);
    for (const l of labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
    const assignees = (i.assignees ?? []).map((a) => a.login);
    if (assignees.length === 0) byAssignee.set('(unassigned)', (byAssignee.get('(unassigned)') ?? 0) + 1);
    for (const a of assignees) byAssignee.set(a, (byAssignee.get(a) ?? 0) + 1);
    const ms = i.milestone?.title ?? '(none)';
    byMilestone.set(ms, (byMilestone.get(ms) ?? 0) + 1);
    const prio = priorityOf(labels) ?? '(none)';
    byPriority.set(prio, (byPriority.get(prio) ?? 0) + 1);
    const days = (now - Date.parse(i.created_at)) / 86_400_000;
    if (days < 7) age.under_7_days++;
    else if (days < 30) age.under_30_days++;
    else if (days < 90) age.under_90_days++;
    else age.older++;
    if ((now - Date.parse(i.updated_at)) / 86_400_000 > 30) stale.push(i);
  }
  const toObj = (m: Map<string, number>) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  const prioRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const top = [...issues]
    .map((i) => ({ i, p: priorityOf((i.labels ?? []).map((l) => l.name)) }))
    .sort(
      (a, b) =>
        (prioRank[a.p ?? ''] ?? 9) - (prioRank[b.p ?? ''] ?? 9) ||
        Date.parse(a.i.created_at) - Date.parse(b.i.created_at),
    )
    .slice(0, 15)
    .map(({ i, p }) => ({ ...slimIssue(i), priority: p }));
  return {
    count: issues.length,
    by_priority: toObj(byPriority),
    by_label: toObj(byLabel),
    by_assignee: toObj(byAssignee),
    by_milestone: toObj(byMilestone),
    age,
    stale_count: stale.length,
    stale_examples: stale.slice(0, 10).map((i) => slimIssue(i)),
    top_priority: top,
  };
}

/** Resolves label names (or ids) to ids, as the Gitea API expects ids. */
export async function resolveLabelIds(
  ctx: ToolContext,
  owner: string,
  repo: string,
  labels: (string | number)[],
): Promise<number[]> {
  if (labels.every((l): l is number => typeof l === 'number')) return labels;
  const all = await ctx.client.paginate<{ id: number; name: string }>(
    `${repoPath(owner, repo)}/labels`,
    {},
    { limit: 1000 },
  );
  const org = await ctx.client
    .paginate<{ id: number; name: string }>(`/orgs/${encodeURIComponent(owner)}/labels`, {}, { limit: 1000 })
    .then((r) => r.items)
    .catch(() => []);
  const known = [...all.items, ...org];
  return labels.map((l) => {
    if (typeof l === 'number') return l;
    const found = known.find((k) => k.name.toLowerCase() === l.toLowerCase());
    if (!found) {
      throw new GiteaError('INVALID_INPUT', `Label "${l}" does not exist in ${owner}/${repo}.`, {
        hint: `Existing labels: ${known.map((k) => k.name).join(', ') || '(none)'}. Create it with label_create.`,
      });
    }
    return found.id;
  });
}

export async function resolveMilestoneId(
  ctx: ToolContext,
  owner: string,
  repo: string,
  milestone: string | number | undefined,
): Promise<number | undefined> {
  if (milestone === undefined || typeof milestone === 'number') return milestone;
  const res = await ctx.client.paginate<{ id: number; title: string }>(
    `${repoPath(owner, repo)}/milestones`,
    { state: 'all' },
    { limit: 1000 },
  );
  const found = res.items.find((m) => m.title.toLowerCase() === milestone.toLowerCase());
  if (!found)
    throw new GiteaError('INVALID_INPUT', `Milestone "${milestone}" does not exist in ${owner}/${repo}.`);
  return found.id;
}

const labelsInput = z
  .array(z.union([z.string().min(1).max(255), z.number().int().min(1)]))
  .max(50)
  .describe('Label names or ids');
const milestoneInput = z
  .union([z.string().min(1).max(255), z.number().int().min(1)])
  .describe('Milestone title or id');

export const issueTools: ToolDefinition[] = [
  defineTool({
    name: 'issue_list',
    module: M,
    title: 'List issues',
    description:
      'Lists issues of a repository filtered by state, labels, milestone, keyword, author, assignee and mentions. Use `priority` to filter by priority labels (e.g. "priority/high", "P1").',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      state: stateSchema,
      labels: z.array(z.string()).optional().describe('Only issues with all of these label names.'),
      milestones: z.array(z.string()).optional().describe('Milestone names or ids.'),
      query: z.string().max(200).optional().describe('Keyword search in title/body.'),
      created_by: z.string().optional(),
      assigned_to: z.string().optional().describe('Only issues assigned to this user.'),
      mentioned: z.string().optional(),
      since: dateSchema.optional(),
      before: dateSchema.optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
      include_pulls: z.boolean().default(false),
      ...pagingShape,
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate<RawIssue>(
        `${repoPath(owner, repo)}/issues`,
        {
          state: args.state,
          labels: args.labels?.join(','),
          milestones: args.milestones?.join(','),
          q: args.query,
          type: args.include_pulls ? undefined : 'issues',
          created_by: args.created_by,
          assigned_by: args.assigned_to,
          mentioned_by: args.mentioned,
          since: args.since,
          before: args.before,
        },
        { limit: args.priority ? Math.max(args.limit, 500) : args.limit, page: args.page },
      );
      let items = res.items;
      if (args.priority) {
        items = items
          .filter((i) => (priorityOf((i.labels ?? []).map((l) => l.name)) ?? 'none') === args.priority)
          .slice(0, args.limit);
      }
      return {
        total: args.priority ? items.length : res.totalCount,
        has_more: res.hasMore,
        issues: items.map((i) => ({
          ...slimIssue(i),
          priority: priorityOf((i.labels ?? []).map((l) => l.name)),
        })),
      };
    },
  }),
  defineTool({
    name: 'issue_search',
    module: M,
    title: 'Search issues across repositories',
    description:
      'Searches issues and pull requests across all repositories you can access, e.g. everything assigned to you or mentioning you.',
    access: 'read',
    input: {
      ...profileShape,
      query: z.string().max(200).optional(),
      state: stateSchema,
      type: z.enum(['issues', 'pulls']).optional(),
      labels: z.array(z.string()).optional(),
      owner: z.string().optional().describe('Only repositories of this owner.'),
      assigned: z.boolean().optional().describe('Only issues assigned to you.'),
      created: z.boolean().optional().describe('Only issues you created.'),
      mentioned: z.boolean().optional(),
      review_requested: z.boolean().optional().describe('Only pull requests where your review is requested.'),
      since: dateSchema.optional(),
      before: dateSchema.optional(),
      ...pagingShape,
    },
    async run(args, ctx) {
      const res = await ctx.client.paginate<RawIssue>(
        '/repos/issues/search',
        {
          q: args.query,
          state: args.state,
          type: args.type,
          labels: args.labels?.join(','),
          owner: args.owner,
          assigned: args.assigned,
          created: args.created,
          mentioned: args.mentioned,
          review_requested: args.review_requested,
          since: args.since,
          before: args.before,
        },
        args,
      );
      return { total: res.totalCount, has_more: res.hasMore, issues: res.items.map((i) => slimIssue(i)) };
    },
  }),
  defineTool({
    name: 'issue_get',
    module: M,
    title: 'Get issue',
    description: 'Returns an issue (or pull request) with its description and, optionally, its comments.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      include_comments: z.boolean().default(true),
      max_comments: z.number().int().min(1).max(500).default(50),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/issues/${args.number}`;
      const issue = await ctx.client.request({ path: base });
      const out: Record<string, unknown> = slimIssue(issue.data, true);
      if (args.include_comments) {
        const comments = await ctx.client.list(`${base}/comments`);
        out.comment_list = comments.slice(0, args.max_comments).map(slimComment);
        out.more_comments = comments.length > args.max_comments || undefined;
      }
      return out;
    },
  }),
  defineTool({
    name: 'issue_create',
    module: M,
    title: 'Create issue',
    description: 'Creates an issue with optional labels (names), assignees, milestone (title) and due date.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      title: z.string().min(1).max(255),
      body: z.string().max(65_535).optional(),
      labels: labelsInput.optional(),
      assignees: z.array(z.string()).max(20).optional(),
      milestone: milestoneInput.optional(),
      due_date: dateSchema.optional(),
      ref: z.string().max(255).optional().describe('Branch/tag the issue refers to.'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/issues`,
        body: body({
          title: args.title,
          body: args.body,
          labels: args.labels ? await resolveLabelIds(ctx, owner, repo, args.labels) : undefined,
          assignees: args.assignees,
          milestone: await resolveMilestoneId(ctx, owner, repo, args.milestone),
          due_date: args.due_date,
          ref: args.ref,
        }),
      });
      return { created: true, issue: slimIssue(res.data) };
    },
  }),
  defineTool({
    name: 'issue_update',
    module: M,
    title: 'Edit issue',
    description:
      'Edits title, body, assignees (replaces the list), milestone, due date or state (open/closed) of an issue or pull request. Labels are changed with issue_labels.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      title: z.string().min(1).max(255).optional(),
      body: z.string().max(65_535).optional(),
      assignees: z.array(z.string()).max(20).optional(),
      milestone: milestoneInput.optional(),
      remove_milestone: z.boolean().optional(),
      due_date: dateSchema.optional(),
      remove_due_date: z.boolean().optional(),
      state: z.enum(['open', 'closed']).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const payload = body({
        title: args.title,
        body: args.body,
        assignees: args.assignees,
        milestone: args.remove_milestone ? 0 : await resolveMilestoneId(ctx, owner, repo, args.milestone),
        due_date: args.due_date,
        unset_due_date: args.remove_due_date,
        state: args.state,
      });
      requireSomeFields(payload, `issue #${args.number}`);
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repoPath(owner, repo)}/issues/${args.number}`,
        body: payload,
      });
      return { updated: Object.keys(payload), issue: slimIssue(res.data) };
    },
  }),
  defineTool({
    name: 'issue_set_state',
    module: M,
    title: 'Close or reopen issue',
    description: 'Closes or reopens an issue, optionally adding a comment explaining why.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      state: z.enum(['open', 'closed']),
      comment: z.string().max(65_535).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/issues/${args.number}`;
      if (args.comment)
        await ctx.client.request({ method: 'POST', path: `${base}/comments`, body: { body: args.comment } });
      const res = await ctx.client.request({ method: 'PATCH', path: base, body: { state: args.state } });
      return { issue: slimIssue(res.data) };
    },
  }),
  defineTool({
    name: 'issue_assign',
    module: M,
    title: 'Assign users to issue',
    description: 'Adds or removes assignees of an issue or pull request without touching the others.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      add: z.array(z.string()).max(20).optional(),
      remove: z.array(z.string()).max(20).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/issues/${args.number}`;
      const current = await ctx.client.request<RawIssue>({ path: base });
      const set = new Set((current.data.assignees ?? []).map((a) => a.login));
      for (const a of args.add ?? []) set.add(a);
      for (const r of args.remove ?? []) set.delete(r);
      const res = await ctx.client.request({ method: 'PATCH', path: base, body: { assignees: [...set] } });
      return { issue: slimIssue(res.data) };
    },
  }),
  defineTool({
    name: 'issue_labels',
    module: M,
    title: 'Change issue labels',
    description: 'Adds, removes or replaces labels of an issue or pull request. Labels may be given by name.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      add: labelsInput.optional(),
      remove: labelsInput.optional(),
      replace: labelsInput.optional().describe('Replace all labels with exactly these (empty array clears).'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/issues/${args.number}/labels`;
      if (args.replace) {
        const ids = await resolveLabelIds(ctx, owner, repo, args.replace);
        await ctx.client.request({ method: 'PUT', path: base, body: { labels: ids } });
      }
      if (args.add?.length) {
        const ids = await resolveLabelIds(ctx, owner, repo, args.add);
        await ctx.client.request({ method: 'POST', path: base, body: { labels: ids } });
      }
      for (const id of args.remove?.length ? await resolveLabelIds(ctx, owner, repo, args.remove) : []) {
        await ctx.client.request({ method: 'DELETE', path: `${base}/${id}` });
      }
      const res = await ctx.client.request<unknown[]>({ path: base });
      return { labels: res.data.map(slimLabel) };
    },
  }),
  defineTool({
    name: 'issue_comment_create',
    module: M,
    title: 'Comment on issue or pull request',
    description: 'Adds a comment (Markdown) to an issue or pull request.',
    access: 'write',
    input: { ...profileShape, ...repoShape, number: indexSchema(), body: z.string().min(1).max(65_535) },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/issues/${args.number}/comments`,
        body: { body: args.body },
      });
      return { created: true, comment: slimComment(res.data) };
    },
  }),
  defineTool({
    name: 'issue_comment_list',
    module: M,
    title: 'List issue comments',
    description: 'Lists the comments of an issue or pull request.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema(),
      since: dateSchema.optional(),
      before: dateSchema.optional(),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const comments = await ctx.client.list(`${repoPath(owner, repo)}/issues/${args.number}/comments`, {
        since: args.since,
        before: args.before,
      });
      return {
        total: comments.length,
        has_more: comments.length > args.limit,
        comments: comments.slice(0, args.limit).map(slimComment),
      };
    },
  }),
  defineTool({
    name: 'issue_comment_update',
    module: M,
    title: 'Edit comment',
    description: 'Edits the text of an existing issue or pull request comment.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      comment_id: z.number().int().min(1),
      body: z.string().min(1).max(65_535),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repoPath(owner, repo)}/issues/comments/${args.comment_id}`,
        body: { body: args.body },
      });
      return { comment: slimComment(res.data) };
    },
  }),
  defineTool({
    name: 'issue_comment_delete',
    module: M,
    title: 'Delete comment',
    description: 'Deletes an issue or pull request comment. Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, comment_id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}#comment-${args.comment_id}`,
        action: `Delete comment ${args.comment_id} in ${owner}/${repo}.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repoPath(owner, repo)}/issues/comments/${args.comment_id}`,
      });
      return { deleted: args.comment_id };
    },
  }),
  defineTool({
    name: 'issues_summary',
    module: M,
    title: 'Summarise open issues',
    description:
      'Analyses the issues of a repository (default: all open issues) and summarises them by priority, label, assignee, milestone and age, lists stale issues and the most important open tasks. Use for "analyse all open issues" or "show all open tasks".',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      state: stateSchema,
      labels: z.array(z.string()).optional(),
      milestone: z.string().optional(),
      max_issues: z.number().int().min(1).max(2000).default(500),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate<RawIssue>(
        `${repoPath(owner, repo)}/issues`,
        { state: args.state, type: 'issues', labels: args.labels?.join(','), milestones: args.milestone },
        { limit: args.max_issues },
      );
      return {
        repository: `${owner}/${repo}`,
        state: args.state,
        analysed_all: !res.hasMore,
        total_matching: res.totalCount,
        ...summarizeIssues(res.items),
      };
    },
  }),
  defineTool({
    name: 'label_list',
    module: M,
    title: 'List labels',
    description: 'Lists the labels of a repository (and of its organisation, if any).',
    access: 'read',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate(`${repoPath(owner, repo)}/labels`, {}, { limit: 1000 });
      const org = await ctx.client
        .paginate(`/orgs/${encodeURIComponent(owner)}/labels`, {}, { limit: 1000 })
        .then((r) => r.items)
        .catch(() => []);
      return {
        labels: res.items.map(slimLabel),
        organization_labels: org.length ? org.map(slimLabel) : undefined,
      };
    },
  }),
  defineTool({
    name: 'label_create',
    module: M,
    title: 'Create label',
    description:
      'Creates a repository label. Names with a slash and `exclusive` form scoped label groups (e.g. "priority/high").',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      name: z.string().min(1).max(255),
      color: colorSchema,
      description: z.string().max(1000).optional(),
      exclusive: z.boolean().optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/labels`,
        body: body({
          name: args.name,
          color: args.color,
          description: args.description,
          exclusive: args.exclusive,
        }),
      });
      return { created: true, label: slimLabel(res.data) };
    },
  }),
  defineTool({
    name: 'label_update',
    module: M,
    title: 'Edit label',
    description: 'Renames or recolours a label or changes its description.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      id: z.number().int().min(1),
      name: z.string().min(1).max(255).optional(),
      color: colorSchema.optional(),
      description: z.string().max(1000).optional(),
      exclusive: z.boolean().optional(),
      archived: z.boolean().optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const payload = body({
        name: args.name,
        color: args.color,
        description: args.description,
        exclusive: args.exclusive,
        is_archived: args.archived,
      });
      requireSomeFields(payload, 'the label');
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repoPath(owner, repo)}/labels/${args.id}`,
        body: payload,
      });
      return { label: slimLabel(res.data) };
    },
  }),
  defineTool({
    name: 'label_delete',
    module: M,
    title: 'Delete label',
    description: 'Deletes a label; it is removed from all issues. Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}#label-${args.id}`,
        action: `Delete label ${args.id} in ${owner}/${repo}; it is removed from all issues.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({ method: 'DELETE', path: `${repoPath(owner, repo)}/labels/${args.id}` });
      return { deleted: args.id };
    },
  }),
  defineTool({
    name: 'milestone_list',
    module: M,
    title: 'List milestones',
    description: 'Lists milestones with progress (open/closed issue counts) and due dates.',
    access: 'read',
    input: { ...profileShape, ...repoShape, state: stateSchema, name: z.string().optional(), ...pagingShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate(
        `${repoPath(owner, repo)}/milestones`,
        { state: args.state, name: args.name },
        args,
      );
      return { has_more: res.hasMore, milestones: res.items.map(slimMilestone) };
    },
  }),
  defineTool({
    name: 'milestone_create',
    module: M,
    title: 'Create milestone',
    description: 'Creates a milestone with optional description and due date.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      title: z.string().min(1).max(255),
      description: z.string().max(65_535).optional(),
      due_on: dateSchema.optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/milestones`,
        body: body({ title: args.title, description: args.description, due_on: args.due_on }),
      });
      return { created: true, milestone: slimMilestone(res.data) };
    },
  }),
  defineTool({
    name: 'milestone_update',
    module: M,
    title: 'Edit or close milestone',
    description: 'Edits a milestone or closes/reopens it.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      id: z.number().int().min(1),
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(65_535).optional(),
      due_on: dateSchema.optional(),
      state: z.enum(['open', 'closed']).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const payload = body({
        title: args.title,
        description: args.description,
        due_on: args.due_on,
        state: args.state,
      });
      requireSomeFields(payload, 'the milestone');
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repoPath(owner, repo)}/milestones/${args.id}`,
        body: payload,
      });
      return { milestone: slimMilestone(res.data) };
    },
  }),
  defineTool({
    name: 'milestone_delete',
    module: M,
    title: 'Delete milestone',
    description: 'Deletes a milestone (issues stay but lose the milestone). Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}#milestone-${args.id}`,
        action: `Delete milestone ${args.id} in ${owner}/${repo}.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({ method: 'DELETE', path: `${repoPath(owner, repo)}/milestones/${args.id}` });
      return { deleted: args.id };
    },
  }),
];
