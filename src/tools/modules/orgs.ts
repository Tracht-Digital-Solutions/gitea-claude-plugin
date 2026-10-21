import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { slimOrg, slimRepo, slimTeam, slimUser } from '../../gitea/models.js';
import {
  body,
  listResult,
  nameSchema,
  ownerSchema,
  pagingShape,
  profileShape,
  repoShape,
  requireSomeFields,
} from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';

/** Users, organisations, teams and repository collaborators. */
const M = 'organizations';
const permissionSchema = z.enum(['read', 'write', 'admin']);
const orgSchema = ownerSchema.describe('Organisation name');
const userSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .describe('User login');
const unitsSchema = z
  .record(z.string(), z.enum(['none', 'read', 'write', 'admin']))
  .optional()
  .describe('Per-unit permissions, e.g. {"repo.code":"write","repo.issues":"read"}');

async function findTeam(
  ctx: ToolContext,
  org: string,
  team: string | number,
): Promise<{ id: number; name: string }> {
  if (typeof team === 'number') return { id: team, name: String(team) };
  const res = await ctx.client.paginate<{ id: number; name: string }>(
    `/orgs/${encodeURIComponent(org)}/teams`,
    {},
    { limit: 1000 },
  );
  const found = res.items.find((t) => t.name.toLowerCase() === team.toLowerCase());
  if (!found) {
    throw new GiteaError('NOT_FOUND', `Team "${team}" does not exist in ${org}.`, {
      hint: `Teams: ${res.items.map((t) => t.name).join(', ') || '(none)'}`,
    });
  }
  return found;
}

const teamRef = z.union([z.string().min(1).max(255), z.number().int().min(1)]).describe('Team name or id');

export const orgTools: ToolDefinition[] = [
  defineTool({
    name: 'user_get',
    module: M,
    title: 'Get user',
    description: 'Returns the authenticated user (no `username`) or the public profile of another user.',
    access: 'read',
    input: { ...profileShape, username: userSchema.optional() },
    async run(args, ctx) {
      const res = await ctx.client.request({
        path: args.username ? `/users/${encodeURIComponent(args.username)}` : '/user',
      });
      return slimUser(res.data);
    },
  }),
  defineTool({
    name: 'user_search',
    module: M,
    title: 'Search users',
    description: 'Searches users by login, full name or email.',
    access: 'read',
    input: { ...profileShape, query: z.string().min(1).max(100), ...pagingShape },
    async run(args, ctx) {
      const res = await ctx.client.paginate('/users/search', { q: args.query }, args);
      return listResult(res, 'users', slimUser);
    },
  }),
  defineTool({
    name: 'org_list',
    module: M,
    title: 'List organisations',
    description: 'Lists the organisations you belong to, or those of another user.',
    access: 'read',
    input: { ...profileShape, username: userSchema.optional(), ...pagingShape },
    async run(args, ctx) {
      const path = args.username ? `/users/${encodeURIComponent(args.username)}/orgs` : '/user/orgs';
      const res = await ctx.client.paginate(path, {}, args);
      return listResult(res, 'organizations', slimOrg);
    },
  }),
  defineTool({
    name: 'org_get',
    module: M,
    title: 'Get organisation',
    description: 'Returns an organisation with its teams (if visible to you) and member count.',
    access: 'read',
    input: { ...profileShape, org: orgSchema },
    async run(args, ctx) {
      const o = encodeURIComponent(args.org);
      const res = await ctx.client.request({ path: `/orgs/${o}` });
      const teams = await ctx.client
        .paginate(`/orgs/${o}/teams`, {}, { limit: 100 })
        .then((r) => r.items.map(slimTeam))
        .catch(() => undefined);
      return { ...slimOrg(res.data), teams };
    },
  }),
  defineTool({
    name: 'org_members_list',
    module: M,
    title: 'List organisation members',
    description: 'Lists the members of an organisation.',
    access: 'read',
    input: { ...profileShape, org: orgSchema, ...pagingShape },
    async run(args, ctx) {
      const res = await ctx.client.paginate(`/orgs/${encodeURIComponent(args.org)}/members`, {}, args);
      return listResult(res, 'members', slimUser);
    },
  }),
  defineTool({
    name: 'org_create',
    module: M,
    title: 'Create organisation',
    description: 'Creates an organisation owned by you. Administrative operation.',
    access: 'admin',
    input: {
      ...profileShape,
      name: nameSchema('Organisation'),
      full_name: z.string().max(255).optional(),
      description: z.string().max(255).optional(),
      website: z.string().max(255).optional(),
      location: z.string().max(255).optional(),
      visibility: z.enum(['public', 'limited', 'private']).default('private'),
    },
    async run(args, ctx) {
      const res = await ctx.client.request({
        method: 'POST',
        path: '/orgs',
        body: body({
          username: args.name,
          full_name: args.full_name,
          description: args.description,
          website: args.website,
          location: args.location,
          visibility: args.visibility,
        }),
      });
      return { created: true, organization: slimOrg(res.data) };
    },
  }),
  defineTool({
    name: 'org_update',
    module: M,
    title: 'Edit organisation',
    description:
      'Edits organisation profile and visibility. Administrative; changing visibility needs confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      org: orgSchema,
      full_name: z.string().max(255).optional(),
      description: z.string().max(255).optional(),
      website: z.string().max(255).optional(),
      location: z.string().max(255).optional(),
      visibility: z.enum(['public', 'limited', 'private']).optional(),
    },
    confirm(args) {
      return {
        target: args.org,
        action: `Edit organisation ${args.org}${args.visibility ? ` and set its visibility to ${args.visibility}` : ''}.`,
      };
    },
    async run(args, ctx) {
      const payload = body({
        full_name: args.full_name,
        description: args.description,
        website: args.website,
        location: args.location,
        visibility: args.visibility,
      });
      requireSomeFields(payload, 'the organisation');
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `/orgs/${encodeURIComponent(args.org)}`,
        body: payload,
      });
      return { organization: slimOrg(res.data) };
    },
  }),
  defineTool({
    name: 'team_list',
    module: M,
    title: 'List teams',
    description: 'Lists the teams of an organisation with their permissions.',
    access: 'read',
    input: { ...profileShape, org: orgSchema, ...pagingShape },
    async run(args, ctx) {
      const res = await ctx.client.paginate(`/orgs/${encodeURIComponent(args.org)}/teams`, {}, args);
      return listResult(res, 'teams', slimTeam);
    },
  }),
  defineTool({
    name: 'team_get',
    module: M,
    title: 'Get team',
    description: 'Returns a team with its members and repositories.',
    access: 'read',
    input: { ...profileShape, org: orgSchema, team: teamRef },
    async run(args, ctx) {
      const t = await findTeam(ctx, args.org, args.team);
      const [team, members, repos] = await Promise.all([
        ctx.client.request({ path: `/teams/${t.id}` }),
        ctx.client.paginate(`/teams/${t.id}/members`, {}, { limit: 200 }),
        ctx.client.paginate(`/teams/${t.id}/repos`, {}, { limit: 200 }),
      ]);
      return {
        ...slimTeam(team.data),
        members: members.items.map((m) => (m as { login: string }).login),
        repositories: repos.items.map((r) => (slimRepo(r) as { full_name?: string }).full_name),
      };
    },
  }),
  defineTool({
    name: 'team_create',
    module: M,
    title: 'Create team',
    description: 'Creates a team in an organisation. Administrative; requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      org: orgSchema,
      name: z.string().min(1).max(255),
      description: z.string().max(255).optional(),
      permission: permissionSchema.default('read'),
      includes_all_repositories: z.boolean().default(false),
      can_create_org_repo: z.boolean().default(false),
      units_map: unitsSchema,
    },
    confirm(args) {
      return {
        target: `${args.org}/${args.name}`,
        action: `Create team "${args.name}" in ${args.org} with ${args.permission} permission${args.includes_all_repositories ? ' on ALL repositories' : ''}.`,
      };
    },
    async run(args, ctx) {
      const res = await ctx.client.request({
        method: 'POST',
        path: `/orgs/${encodeURIComponent(args.org)}/teams`,
        body: body({
          name: args.name,
          description: args.description,
          permission: args.permission,
          includes_all_repositories: args.includes_all_repositories,
          can_create_org_repo: args.can_create_org_repo,
          units_map: args.units_map,
          units: args.units_map
            ? Object.keys(args.units_map)
            : ['repo.code', 'repo.issues', 'repo.pulls', 'repo.releases', 'repo.wiki', 'repo.actions'],
        }),
      });
      return { created: true, team: slimTeam(res.data) };
    },
  }),
  defineTool({
    name: 'team_update',
    module: M,
    title: 'Edit team',
    description:
      'Edits a team (name, description, permission, repository scope). Administrative; requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      org: orgSchema,
      team: teamRef,
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(255).optional(),
      permission: permissionSchema.optional(),
      includes_all_repositories: z.boolean().optional(),
      can_create_org_repo: z.boolean().optional(),
      units_map: unitsSchema,
    },
    confirm(args) {
      return {
        target: `${args.org}/${String(args.team)}`,
        action: `Change team ${String(args.team)} in ${args.org} (permissions may change).`,
      };
    },
    async run(args, ctx) {
      const t = await findTeam(ctx, args.org, args.team);
      const payload = body({
        name: args.name ?? t.name,
        description: args.description,
        permission: args.permission,
        includes_all_repositories: args.includes_all_repositories,
        can_create_org_repo: args.can_create_org_repo,
        units_map: args.units_map,
      });
      const res = await ctx.client.request({ method: 'PATCH', path: `/teams/${t.id}`, body: payload });
      return { team: slimTeam(res.data) };
    },
  }),
  defineTool({
    name: 'team_delete',
    module: M,
    title: 'Delete team',
    description:
      'Deletes a team; its members lose the access granted through it. Administrative; requires confirmation.',
    access: 'admin',
    input: { ...profileShape, org: orgSchema, team: teamRef },
    confirm(args) {
      return {
        target: `${args.org}/${String(args.team)}`,
        action: `Delete team ${String(args.team)} in ${args.org}; members lose its access.`,
      };
    },
    async run(args, ctx) {
      const t = await findTeam(ctx, args.org, args.team);
      await ctx.client.request({ method: 'DELETE', path: `/teams/${t.id}` });
      return { deleted: t.name };
    },
  }),
  defineTool({
    name: 'team_member_set',
    module: M,
    title: 'Add or remove team member',
    description:
      'Adds a user to a team or removes them. Changes permissions; administrative and requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      org: orgSchema,
      team: teamRef,
      username: userSchema,
      action: z.enum(['add', 'remove']),
    },
    confirm(args) {
      return {
        target: `${args.org}/${String(args.team)}:${args.username}`,
        action: `${args.action === 'add' ? 'Add' : 'Remove'} ${args.username} ${args.action === 'add' ? 'to' : 'from'} team ${String(args.team)} in ${args.org}.`,
      };
    },
    async run(args, ctx) {
      const t = await findTeam(ctx, args.org, args.team);
      await ctx.client.request({
        method: args.action === 'add' ? 'PUT' : 'DELETE',
        path: `/teams/${t.id}/members/${encodeURIComponent(args.username)}`,
      });
      return { team: t.name, username: args.username, action: args.action };
    },
  }),
  defineTool({
    name: 'team_repo_set',
    module: M,
    title: 'Grant or revoke team repository access',
    description: 'Adds a repository to a team or removes it. Administrative; requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      org: orgSchema,
      team: teamRef,
      repo: nameSchema('Repository'),
      action: z.enum(['add', 'remove']),
    },
    confirm(args) {
      return {
        target: `${args.org}/${String(args.team)}:${args.repo}`,
        action: `${args.action === 'add' ? 'Grant' : 'Revoke'} team ${String(args.team)} access to ${args.org}/${args.repo}.`,
      };
    },
    async run(args, ctx) {
      const t = await findTeam(ctx, args.org, args.team);
      await ctx.client.request({
        method: args.action === 'add' ? 'PUT' : 'DELETE',
        path: `/teams/${t.id}/repos/${encodeURIComponent(args.org)}/${encodeURIComponent(args.repo)}`,
      });
      return { team: t.name, repository: `${args.org}/${args.repo}`, action: args.action };
    },
  }),
  defineTool({
    name: 'collaborator_list',
    module: M,
    title: 'List collaborators',
    description: 'Lists the collaborators of a repository with their permission level.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ...pagingShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate<{ login: string }>(`${repo.api}/collaborators`, {}, args);
      const withPerm = await Promise.all(
        res.items.map(async (u) => {
          const perm = await ctx.client
            .request<{ permission: string; role_name?: string }>({
              path: `${repo.api}/collaborators/${encodeURIComponent(u.login)}/permission`,
            })
            .then((r) => r.data)
            .catch(() => undefined);
          return { login: u.login, permission: perm?.permission, role: perm?.role_name };
        }),
      );
      return { has_more: res.hasMore, collaborators: withPerm };
    },
  }),
  defineTool({
    name: 'collaborator_set',
    module: M,
    title: 'Add, change or remove collaborator',
    description:
      'Adds a collaborator with a permission (read/write/admin), changes the permission, or removes the collaborator. Changes access rights; administrative and requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      ...repoShape,
      username: userSchema,
      action: z.enum(['add', 'remove']),
      permission: permissionSchema.default('write'),
    },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}:${args.username}`,
        action:
          args.action === 'add'
            ? `Give ${args.username} ${args.permission} access to ${repo.fullName}.`
            : `Remove ${args.username}'s collaborator access to ${repo.fullName}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const path = `${repo.api}/collaborators/${encodeURIComponent(args.username)}`;
      if (args.action === 'add')
        await ctx.client.request({ method: 'PUT', path, body: { permission: args.permission } });
      else await ctx.client.request({ method: 'DELETE', path });
      return {
        repository: repo.fullName,
        username: args.username,
        action: args.action,
        permission: args.action === 'add' ? args.permission : undefined,
      };
    },
  }),
  defineTool({
    name: 'repo_permissions_analyze',
    module: M,
    title: 'Analyse repository access',
    description:
      "Shows who can access a repository: your own permission, collaborators with their levels, the owning organisation's teams with access to it, and branch protections. Useful for access reviews.",
    access: 'read',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const base = repo.api;
      const info = (
        await ctx.client.request<{
          private: boolean;
          owner: { login: string };
          permissions?: unknown;
          internal?: boolean;
        }>({ path: base })
      ).data;
      const [collaborators, teams, protections] = await Promise.all([
        ctx.client
          .paginate<{ login: string }>(`${base}/collaborators`, {}, { limit: 500 })
          .then(async (r) =>
            Promise.all(
              r.items.map(async (u) => ({
                login: u.login,
                permission: await ctx.client
                  .request<{ permission: string }>({
                    path: `${base}/collaborators/${encodeURIComponent(u.login)}/permission`,
                  })
                  .then((p) => p.data.permission)
                  .catch(() => undefined),
              })),
            ),
          )
          .catch((err: unknown) => ({ error: err instanceof GiteaError ? err.code : String(err) })),
        ctx.client
          .request<unknown[]>({ path: `${base}/teams` })
          .then((r) => r.data.map(slimTeam))
          .catch(() => undefined),
        ctx.client
          .request<
            { rule_name?: string; branch_name?: string; required_approvals?: number; enable_push?: boolean }[]
          >({
            path: `${base}/branch_protections`,
          })
          .then((r) =>
            r.data.map((p) => ({
              rule: p.rule_name ?? p.branch_name,
              required_approvals: p.required_approvals,
              push_enabled: p.enable_push,
            })),
          )
          .catch(() => undefined),
      ]);
      const admins = Array.isArray(collaborators)
        ? collaborators.filter((c) => c.permission === 'admin').map((c) => c.login)
        : undefined;
      return {
        repository: repo.fullName,
        visibility: info.private ? 'private' : 'public',
        owner: info.owner.login,
        your_permissions: info.permissions,
        collaborators,
        teams_with_access: teams,
        admin_collaborators: admins,
        branch_protections: protections,
        observations: [
          ...(info.private ? [] : ['Repository is public: everyone can read it.']),
          ...(Array.isArray(protections) && protections.length === 0
            ? ['No branch protection rules configured.']
            : []),
          ...(admins && admins.length > 3 ? [`${admins.length} collaborators have admin rights.`] : []),
        ],
      };
    },
  }),
];
