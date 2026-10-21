import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact, slimIssue } from '../../gitea/models.js';
import {
  body,
  colorSchema,
  indexSchema,
  ownerSchema,
  profileShape,
  repoPath,
  repoShape,
  requireSomeFields,
} from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';

const M = 'projects';

interface RawProject {
  id: number;
  title: string;
  description?: string;
  state?: string;
  is_closed?: boolean;
  num_issues?: number;
  num_open_issues?: number;
  num_closed_issues?: number;
  template_type?: string;
  card_type?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface RawColumn {
  id: number;
  title: string;
  color?: string;
  default?: boolean;
  sorting?: number;
}

/**
 * Projects (kanban boards) exist on repositories, organisations and the authenticated user. The
 * scope decides the API base; issues are always referenced by their repository-local number and
 * resolved to Gitea's global issue id.
 */
const scopeShape = {
  scope: z
    .enum(['repo', 'org', 'user'])
    .default('repo')
    .describe(
      'Where the project lives: a repository (owner/repo), an organisation (org) or your user account.',
    ),
  org: ownerSchema.optional().describe('Organisation for scope "org".'),
};

const projectId = z.number().int().min(1).describe('Project id (see project_list)');
const columnPosition = z.number().int().min(1).max(100).describe('Position from the left, 1-based');
const columnRef = z
  .union([z.string().min(1).max(255), z.number().int().min(1)])
  .describe('Column title or id');

type ScopeArgs = {
  scope: 'repo' | 'org' | 'user';
  org?: string | undefined;
  owner?: string | undefined;
  repo?: string | undefined;
};

async function projectsBase(ctx: ToolContext, args: ScopeArgs): Promise<string> {
  if (args.scope === 'user') return '/user/projects';
  if (args.scope === 'org') {
    if (!args.org) throw new GiteaError('INVALID_INPUT', 'org is required for scope "org".');
    return `/orgs/${encodeURIComponent(args.org)}/projects`;
  }
  const { owner, repo } = await ctx.repo(args);
  return `${repoPath(owner, repo)}/projects`;
}

function slimProject(p: RawProject) {
  return compact({
    id: p.id,
    title: p.title,
    description: p.description,
    state: p.state ?? (p.is_closed ? 'closed' : 'open'),
    open_issues: p.num_open_issues,
    closed_issues: p.num_closed_issues,
    template: p.template_type,
    card_type: p.card_type,
    html_url: p.html_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
  });
}

const slimColumn = (c: RawColumn) =>
  compact({ id: c.id, title: c.title, color: c.color, default: c.default || undefined, sorting: c.sorting });

async function columns(ctx: ToolContext, base: string, id: number): Promise<RawColumn[]> {
  const res = await ctx.client.paginate<RawColumn>(`${base}/${id}/columns`, {}, { limit: 200 });
  return res.items.sort((a, b) => (a.sorting ?? 0) - (b.sorting ?? 0));
}

/** New left-to-right order after moving one column to a 1-based position (clamped). */
export function reorder(ids: number[], columnId: number, position: number): number[] {
  const rest = ids.filter((c) => c !== columnId);
  const index = Math.min(Math.max(position, 1), rest.length + 1) - 1;
  return [...rest.slice(0, index), columnId, ...rest.slice(index)];
}

/** Gitea reorders columns only as a whole: the request lists every column id in its new order. */
async function moveColumn(ctx: ToolContext, base: string, id: number, columnId: number, position: number) {
  const current = await columns(ctx, base, id);
  const order = reorder(
    current.map((c) => c.id),
    columnId,
    position,
  );
  await ctx.client.request({
    method: 'POST',
    path: `${base}/${id}/columns/move`,
    body: { column_ids: order },
  });
  const after = await columns(ctx, base, id);
  return after.map((c) => c.title);
}

async function resolveColumn(
  ctx: ToolContext,
  base: string,
  id: number,
  ref: string | number | undefined,
): Promise<RawColumn> {
  const all = await columns(ctx, base, id);
  const found =
    ref === undefined
      ? (all.find((c) => c.default) ?? all[0])
      : typeof ref === 'number'
        ? all.find((c) => c.id === ref)
        : all.find((c) => c.title.toLowerCase() === ref.toLowerCase());
  if (!found) {
    throw new GiteaError(
      'INVALID_INPUT',
      `Column "${String(ref ?? '(default)')}" does not exist in project ${id}.`,
      {
        hint: `Columns: ${all.map((c) => c.title).join(', ') || '(none) — create one with project_column_create'}`,
      },
    );
  }
  return found;
}

/** Gitea's project endpoints take the global issue id, not the repository-local number. */
async function issueIds(
  ctx: ToolContext,
  args: { owner?: string | undefined; repo?: string | undefined },
  numbers: number[],
) {
  const { owner, repo } = await ctx.repo(args);
  const out: { number: number; id: number; title: string }[] = [];
  for (const n of numbers) {
    const res = await ctx.client.request<{ id: number; number: number; title: string }>({
      path: `${repoPath(owner, repo)}/issues/${n}`,
    });
    out.push({ number: res.data.number, id: res.data.id, title: res.data.title });
  }
  return out;
}

const issueNumbers = z.array(indexSchema('issue or pull request')).min(1).max(100);

export const projectTools: ToolDefinition[] = [
  defineTool({
    name: 'project_list',
    module: M,
    title: 'List projects',
    description:
      'Lists the projects (kanban boards) of a repository, an organisation or your user account, with issue counts.',
    access: 'read',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      state: z.enum(['open', 'closed', 'all']).default('open'),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const res = await ctx.client.paginate<RawProject>(base, { state: args.state }, { limit: 100 });
      return { scope: args.scope, projects: res.items.map(slimProject) };
    },
  }),
  defineTool({
    name: 'project_get',
    module: M,
    title: 'Show project board',
    description:
      'Shows a project board: its columns in order and the issues and pull requests in each column. Use it to answer "what is in progress / what is left".',
    access: 'read',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      max_issues_per_column: z.number().int().min(1).max(500).default(100),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const project = (await ctx.client.request<RawProject>({ path: `${base}/${args.id}` })).data;
      const cols = await columns(ctx, base, args.id);
      const board = [];
      for (const c of cols) {
        const issues = await ctx.client.paginate(
          `${base}/${args.id}/columns/${c.id}/issues`,
          {},
          { limit: args.max_issues_per_column },
        );
        board.push({
          ...slimColumn(c),
          count: issues.totalCount ?? issues.items.length,
          issues: issues.items.map((i) => slimIssue(i)),
        });
      }
      return { ...slimProject(project), columns: board };
    },
  }),
  defineTool({
    name: 'project_create',
    module: M,
    title: 'Create project',
    description:
      'Creates a project (kanban board) in a repository, an organisation or your user account. Use a template ("basic_kanban": To Do / In Progress / Done, "bug_triage") or pass your own column titles.',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      title: z.string().min(1).max(255),
      description: z.string().max(65_535).optional(),
      template: z.enum(['none', 'basic_kanban', 'bug_triage']).default('none'),
      card_type: z.enum(['text_only', 'images_and_text']).optional(),
      columns: z
        .array(z.string().min(1).max(255))
        .max(20)
        .optional()
        .describe('Column titles to create, in order.'),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const res = await ctx.client.request<RawProject>({
        method: 'POST',
        path: base,
        body: body({
          title: args.title,
          description: args.description,
          template_type: args.template,
          card_type: args.card_type,
        }),
      });
      const created: RawColumn[] = [];
      for (const title of args.columns ?? []) {
        const c = await ctx.client.request<RawColumn>({
          method: 'POST',
          path: `${base}/${res.data.id}/columns`,
          body: { title },
        });
        created.push(c.data);
      }
      const cols = await columns(ctx, base, res.data.id);
      return { created: true, project: slimProject(res.data), columns: cols.map(slimColumn) };
    },
  }),
  defineTool({
    name: 'project_update',
    module: M,
    title: 'Edit or close project',
    description: 'Renames a project, changes its description or card type, or closes/reopens it.',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(65_535).optional(),
      state: z.enum(['open', 'closed']).optional(),
      card_type: z.enum(['text_only', 'images_and_text']).optional(),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const payload = body({
        title: args.title,
        description: args.description,
        state: args.state,
        card_type: args.card_type,
      });
      requireSomeFields(payload, 'the project');
      const res = await ctx.client.request<RawProject>({
        method: 'PATCH',
        path: `${base}/${args.id}`,
        body: payload,
      });
      return { updated: Object.keys(payload), project: slimProject(res.data) };
    },
  }),
  defineTool({
    name: 'project_delete',
    module: M,
    title: 'Delete project',
    description: 'Deletes a project board (the issues themselves stay). Requires confirmation.',
    access: 'destructive',
    feature: 'projects',
    input: { ...profileShape, ...repoShape, ...scopeShape, id: projectId },
    async confirm(args, ctx) {
      const base = await projectsBase(ctx, args);
      const p = (await ctx.client.request<RawProject>({ path: `${base}/${args.id}` })).data;
      return {
        target: `project-${args.id}`,
        action: `Delete the project board "${p.title}" (issues are kept).`,
      };
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      await ctx.client.request({ method: 'DELETE', path: `${base}/${args.id}` });
      return { deleted: args.id };
    },
  }),
  defineTool({
    name: 'project_column_create',
    module: M,
    title: 'Add project column',
    description:
      'Adds a column to a project board, optionally with a colour and at a position (1 = leftmost; default: rightmost).',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      title: z.string().min(1).max(255),
      color: colorSchema.optional(),
      position: columnPosition.optional(),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const res = await ctx.client.request<RawColumn>({
        method: 'POST',
        path: `${base}/${args.id}/columns`,
        body: body({ title: args.title, color: args.color }),
      });
      // Always store an explicit order: templates create every column with sorting 0, so a new
      // column would otherwise not have a well-defined place.
      const all = await columns(ctx, base, args.id);
      const order = await moveColumn(ctx, base, args.id, res.data.id, args.position ?? all.length);
      return { created: true, column: slimColumn(res.data), order };
    },
  }),
  defineTool({
    name: 'project_column_move',
    module: M,
    title: 'Move project column',
    description:
      'Moves a column of a project board to another position (1 = leftmost), e.g. to put "Review" before "Done".',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      column: columnRef,
      position: columnPosition,
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      const order = await moveColumn(ctx, base, args.id, col.id, args.position);
      return { moved: col.title, order };
    },
  }),
  defineTool({
    name: 'project_column_update',
    module: M,
    title: 'Edit project column',
    description: 'Renames or recolours a column, or makes it the default column for new cards.',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      column: columnRef,
      title: z.string().min(1).max(255).optional(),
      color: colorSchema.optional(),
      make_default: z.boolean().optional(),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      const payload = body({ title: args.title, color: args.color });
      if (Object.keys(payload).length === 0 && !args.make_default) requireSomeFields(payload, 'the column');
      let result = col;
      if (Object.keys(payload).length) {
        result = (
          await ctx.client.request<RawColumn>({
            method: 'PATCH',
            path: `${base}/${args.id}/columns/${col.id}`,
            body: payload,
          })
        ).data;
      }
      if (args.make_default) {
        await ctx.client.request({ method: 'POST', path: `${base}/${args.id}/columns/${col.id}/default` });
      }
      return { column: slimColumn(result), default: args.make_default || undefined };
    },
  }),
  defineTool({
    name: 'project_column_delete',
    module: M,
    title: 'Delete project column',
    description:
      'Deletes a column from a project board; its cards move to the default column. Requires confirmation.',
    access: 'destructive',
    feature: 'projects',
    input: { ...profileShape, ...repoShape, ...scopeShape, id: projectId, column: columnRef },
    async confirm(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      return {
        target: `project-${args.id}:${col.title}`,
        action: `Delete column "${col.title}" of project ${args.id}.`,
      };
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      await ctx.client.request({ method: 'DELETE', path: `${base}/${args.id}/columns/${col.id}` });
      return { deleted: col.title };
    },
  }),
  defineTool({
    name: 'project_issue_add',
    module: M,
    title: 'Add issues to project',
    description:
      'Adds issues or pull requests (by number, from owner/repo) to a project board column (title or id; default column if omitted).',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      numbers: issueNumbers,
      column: columnRef.optional(),
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      const issues = await issueIds(ctx, args, args.numbers);
      for (const i of issues) {
        await ctx.client.request({
          method: 'POST',
          path: `${base}/${args.id}/columns/${col.id}/issues/${i.id}`,
        });
      }
      return { column: col.title, added: issues.map((i) => ({ number: i.number, title: i.title })) };
    },
  }),
  defineTool({
    name: 'project_issue_move',
    module: M,
    title: 'Move issues on project board',
    description:
      'Moves issues or pull requests (by number) to another column of a project board, e.g. to "In Progress" or "Done".',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      numbers: issueNumbers,
      column: columnRef,
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      const issues = await issueIds(ctx, args, args.numbers);
      for (const i of issues) {
        await ctx.client.request({
          method: 'POST',
          path: `${base}/${args.id}/issues/${i.id}/move`,
          body: { column_id: col.id },
        });
      }
      return { column: col.title, moved: issues.map((i) => i.number) };
    },
  }),
  defineTool({
    name: 'project_issue_remove',
    module: M,
    title: 'Remove issues from project',
    description:
      'Removes issues or pull requests (by number) from a project board column; the issues themselves are kept.',
    access: 'write',
    feature: 'projects',
    input: {
      ...profileShape,
      ...repoShape,
      ...scopeShape,
      id: projectId,
      numbers: issueNumbers,
      column: columnRef,
    },
    async run(args, ctx) {
      const base = await projectsBase(ctx, args);
      const col = await resolveColumn(ctx, base, args.id, args.column);
      const issues = await issueIds(ctx, args, args.numbers);
      for (const i of issues) {
        await ctx.client.request({
          method: 'DELETE',
          path: `${base}/${args.id}/columns/${col.id}/issues/${i.id}`,
        });
      }
      return { column: col.title, removed: issues.map((i) => i.number) };
    },
  }),
];
