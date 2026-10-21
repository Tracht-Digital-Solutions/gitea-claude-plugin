import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { slimRepo } from '../../gitea/models.js';
import {
  body,
  nameSchema,
  ownerSchema,
  pagingShape,
  profileShape,
  repoPath,
  repoShape,
  requireSomeFields,
} from '../common.js';
import { defineTool, type ToolDefinition } from '../types.js';

const M = 'repositories';

export const repoTools: ToolDefinition[] = [
  defineTool({
    name: 'repo_list',
    module: M,
    title: 'List repositories',
    description:
      'Lists repositories. Without `owner` it lists all repositories the authenticated user can access (own, collaborations, organisations). With `owner` it lists the repositories of that user or organisation.',
    access: 'read',
    input: {
      ...profileShape,
      owner: ownerSchema.optional().describe('User or organisation whose repositories to list.'),
      ...pagingShape,
    },
    async run(args, ctx) {
      const opts = { limit: args.limit, page: args.page };
      let result;
      if (!args.owner) {
        result = await ctx.client.paginate('/user/repos', {}, opts);
      } else {
        try {
          result = await ctx.client.paginate(`/orgs/${encodeURIComponent(args.owner)}/repos`, {}, opts);
        } catch (err) {
          if (!(err instanceof GiteaError) || err.code !== 'NOT_FOUND') throw err;
          result = await ctx.client.paginate(`/users/${encodeURIComponent(args.owner)}/repos`, {}, opts);
        }
      }
      return { total: result.totalCount, has_more: result.hasMore, repositories: result.items.map(slimRepo) };
    },
  }),
  defineTool({
    name: 'repo_search',
    module: M,
    title: 'Search repositories',
    description:
      'Searches repositories on the server by keyword (name and optionally description), topic, visibility and archive state, with sorting.',
    access: 'read',
    input: {
      ...profileShape,
      query: z.string().max(200).optional().describe('Keyword to search for.'),
      topic: z.boolean().default(false).describe('Treat `query` as an exact topic name.'),
      include_description: z.boolean().default(false).describe('Also search in descriptions.'),
      private: z.boolean().optional().describe('Only private (true) or only public (false) repositories.'),
      archived: z.boolean().optional().describe('Only archived (true) or only non-archived (false).'),
      mode: z.enum(['fork', 'source', 'mirror', 'collaborative']).optional(),
      sort: z
        .enum(['alpha', 'created', 'updated', 'size', 'git_size', 'lfs_size', 'id', 'stars', 'forks'])
        .optional(),
      order: z.enum(['asc', 'desc']).optional(),
      ...pagingShape,
    },
    async run(args, ctx) {
      const res = await ctx.client.paginate(
        '/repos/search',
        {
          q: args.query,
          topic: args.topic || undefined,
          includeDesc: args.include_description || undefined,
          is_private: args.private,
          archived: args.archived,
          mode: args.mode,
          sort: args.sort,
          order: args.order,
        },
        { limit: args.limit, page: args.page },
      );
      return { total: res.totalCount, has_more: res.hasMore, repositories: res.items.map(slimRepo) };
    },
  }),
  defineTool({
    name: 'repo_get',
    module: M,
    title: 'Get repository details',
    description:
      'Returns repository metadata: visibility, default branch, counters, enabled units, merge settings, topics, languages and your permissions.',
    access: 'read',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = repoPath(owner, repo);
      const [info, languages] = await Promise.all([
        ctx.client.request<Record<string, unknown>>({ path: base }),
        ctx.client.request<Record<string, number>>({ path: `${base}/languages` }).catch(() => undefined),
      ]);
      const d = info.data;
      return {
        ...slimRepo(d),
        merge_settings: {
          allow_merge_commits: d.allow_merge_commits,
          allow_rebase: d.allow_rebase,
          allow_rebase_explicit: d.allow_rebase_explicit,
          allow_squash_merge: d.allow_squash_merge,
          allow_fast_forward_only_merge: d.allow_fast_forward_only_merge,
          default_merge_style: d.default_merge_style,
          default_delete_branch_after_merge: d.default_delete_branch_after_merge,
        },
        languages: languages?.data,
      };
    },
  }),
  defineTool({
    name: 'repo_create',
    module: M,
    title: 'Create repository',
    description:
      'Creates a new repository for the authenticated user or, with `organization`, inside an organisation. Repositories are private by default. Needs the token scope write:user (own account) or write:organization (organisation).',
    access: 'write',
    input: {
      ...profileShape,
      name: nameSchema('Repository'),
      organization: ownerSchema.optional().describe('Create the repository in this organisation.'),
      description: z.string().max(2048).optional(),
      private: z.boolean().default(true).describe('Create as private repository (default true).'),
      auto_init: z.boolean().default(false).describe('Initialise with README/.gitignore/license.'),
      default_branch: z.string().max(100).optional(),
      gitignores: z.string().optional().describe('Comma separated .gitignore templates, e.g. "Node,Go".'),
      license: z.string().optional().describe('License template, e.g. "MIT" or "Apache-2.0".'),
      readme: z.string().optional().describe('Readme template, usually "Default".'),
      template: z.boolean().optional().describe('Mark as template repository.'),
    },
    async run(args, ctx) {
      const path = args.organization ? `/orgs/${encodeURIComponent(args.organization)}/repos` : '/user/repos';
      const res = await ctx.client.request({
        method: 'POST',
        path,
        body: body({
          name: args.name,
          description: args.description,
          private: args.private,
          auto_init: args.auto_init,
          default_branch: args.default_branch,
          gitignores: args.gitignores,
          license: args.license,
          readme: args.readme ?? (args.auto_init ? 'Default' : undefined),
          template: args.template,
        }),
      });
      return { created: true, repository: slimRepo(res.data) };
    },
  }),
  defineTool({
    name: 'repo_update',
    module: M,
    title: 'Update repository settings',
    description:
      'Edits repository settings such as description, website, default branch, enabled units (issues, wiki, pull requests, actions, releases, projects) and allowed merge styles. Visibility and archive state have dedicated tools because they need confirmation.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      description: z.string().max(2048).optional(),
      website: z.string().max(1024).optional(),
      default_branch: z.string().max(255).optional(),
      has_issues: z.boolean().optional(),
      has_wiki: z.boolean().optional(),
      has_pull_requests: z.boolean().optional(),
      has_actions: z.boolean().optional(),
      has_releases: z.boolean().optional(),
      has_projects: z.boolean().optional(),
      has_packages: z.boolean().optional(),
      allow_merge_commits: z.boolean().optional(),
      allow_rebase: z.boolean().optional(),
      allow_rebase_explicit: z.boolean().optional(),
      allow_squash_merge: z.boolean().optional(),
      allow_fast_forward_only_merge: z.boolean().optional(),
      default_merge_style: z
        .enum(['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'])
        .optional(),
      default_delete_branch_after_merge: z.boolean().optional(),
      template: z.boolean().optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const { profile: _p, owner: _o, repo: _r, ...fields } = args;
      const payload = body(fields);
      requireSomeFields(payload, 'the repository');
      const res = await ctx.client.request({ method: 'PATCH', path: repoPath(owner, repo), body: payload });
      return { updated: Object.keys(payload), repository: slimRepo(res.data) };
    },
  }),
  defineTool({
    name: 'repo_set_visibility',
    module: M,
    title: 'Change repository visibility',
    description:
      'Makes a repository private or public. Making a repository public exposes its code, issues and history to everyone, so the user must confirm.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      private: z.boolean().describe('true = private, false = public'),
    },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}`,
        action: args.private
          ? `Make repository ${owner}/${repo} PRIVATE.`
          : `Make repository ${owner}/${repo} PUBLIC — its code, issues and history become visible to everyone.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'PATCH',
        path: repoPath(owner, repo),
        body: { private: args.private },
      });
      return { repository: slimRepo(res.data) };
    },
  }),
  defineTool({
    name: 'repo_archive',
    module: M,
    title: 'Archive or unarchive repository',
    description:
      'Archives a repository (read-only: no pushes, issues or pull requests) or unarchives it. Requires user confirmation.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      archived: z.boolean().default(true).describe('true = archive, false = unarchive'),
    },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}`,
        action: args.archived
          ? `Archive ${owner}/${repo}; it becomes read-only.`
          : `Unarchive ${owner}/${repo}.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'PATCH',
        path: repoPath(owner, repo),
        body: { archived: args.archived },
      });
      return { repository: slimRepo(res.data) };
    },
  }),
  defineTool({
    name: 'repo_delete',
    module: M,
    title: 'Delete repository',
    description:
      'PERMANENTLY deletes a repository including code, issues, pull requests, releases and wiki. This cannot be undone. Requires destructive operations to be enabled and an explicit user confirmation naming the repository.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}`,
        action: `PERMANENTLY delete repository ${owner}/${repo} with all code, issues, pull requests, releases and wiki. This cannot be undone.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({ method: 'DELETE', path: repoPath(owner, repo) });
      return { deleted: `${owner}/${repo}` };
    },
  }),
  defineTool({
    name: 'repo_fork',
    module: M,
    title: 'Fork repository',
    description: 'Forks a repository into your account or into an organisation, optionally under a new name.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      organization: ownerSchema.optional().describe('Organisation to fork into.'),
      name: nameSchema('Fork').optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/forks`,
        body: body({ organization: args.organization, name: args.name }),
      });
      return { forked: true, repository: slimRepo(res.data) };
    },
  }),
  defineTool({
    name: 'repo_forks_list',
    module: M,
    title: 'List forks',
    description: 'Lists the forks of a repository.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ...pagingShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate(`${repoPath(owner, repo)}/forks`, {}, args);
      return { total: res.totalCount, has_more: res.hasMore, forks: res.items.map(slimRepo) };
    },
  }),
  defineTool({
    name: 'repo_topics_set',
    module: M,
    title: 'Set repository topics',
    description: 'Replaces the topics of a repository (lowercase, digits and dashes).',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      topics: z
        .array(
          z.string().regex(/^[a-z0-9][a-z0-9-]{0,34}$/, 'topics are lowercase alphanumerics with dashes'),
        )
        .max(25),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({
        method: 'PUT',
        path: `${repoPath(owner, repo)}/topics`,
        body: { topics: args.topics },
      });
      return { topics: args.topics };
    },
  }),
];
