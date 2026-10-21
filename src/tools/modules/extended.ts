import * as z from 'zod/v4';
import { compact, slimHook, slimNotification, slimRelease, slimRepo, slimRun } from '../../gitea/models.js';
import { registerSecret } from '../../security/redact.js';
import {
  body,
  dateSchema,
  ownerSchema,
  pagingShape,
  profileShape,
  repoPath,
  repoShape,
  requireSomeFields,
} from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';
import { readTextFile } from './contents.js';

const M = 'extended';

const HOOK_EVENTS = [
  'create',
  'delete',
  'fork',
  'push',
  'issues',
  'issue_assign',
  'issue_label',
  'issue_milestone',
  'issue_comment',
  'pull_request',
  'pull_request_assign',
  'pull_request_label',
  'pull_request_milestone',
  'pull_request_comment',
  'pull_request_review_approved',
  'pull_request_review_rejected',
  'pull_request_review_comment',
  'pull_request_sync',
  'pull_request_review_request',
  'wiki',
  'repository',
  'release',
  'package',
  'status',
  'workflow_run',
  'workflow_job',
] as const;

const hookScope = {
  org: ownerSchema.optional().describe('Manage organisation webhooks instead of repository webhooks.'),
};

/** API path of the webhooks of the organisation (`org`) or of the repository. */
async function hooksPath(
  ctx: ToolContext,
  args: { org?: string | undefined; owner?: string | undefined; repo?: string | undefined },
): Promise<string> {
  if (args.org) return `/orgs/${encodeURIComponent(args.org)}/hooks`;
  return `${(await ctx.repo(args)).api}/hooks`;
}

export const extendedTools: ToolDefinition[] = [
  defineTool({
    name: 'webhook_list',
    module: M,
    title: 'List webhooks',
    description: 'Lists the webhooks of a repository or organisation. Secrets are never shown.',
    access: 'read',
    input: { ...profileShape, ...repoShape, ...hookScope },
    async run(args, ctx) {
      const res = await ctx.client.paginate(await hooksPath(ctx, args), {}, { limit: 200 });
      return { webhooks: res.items.map(slimHook) };
    },
  }),
  defineTool({
    name: 'webhook_create',
    module: M,
    title: 'Create webhook',
    description:
      'Creates a webhook that sends events to an HTTPS URL. Administrative operation; requires confirmation because repository data is sent to an external system.',
    access: 'admin',
    input: {
      ...profileShape,
      ...repoShape,
      ...hookScope,
      url: z.url({ protocol: /^https?$/ }).describe('Target URL (https strongly recommended)'),
      type: z
        .enum([
          'gitea',
          'gogs',
          'slack',
          'discord',
          'dingtalk',
          'telegram',
          'msteams',
          'feishu',
          'wechatwork',
          'packagist',
        ])
        .default('gitea'),
      content_type: z.enum(['json', 'form']).default('json'),
      secret: z.string().min(8).max(255).optional().describe('Shared secret used to sign payloads'),
      events: z.array(z.enum(HOOK_EVENTS)).min(1).default(['push']),
      branch_filter: z.string().max(255).optional().describe('Glob, e.g. "main" or "{main,release/*}"'),
      active: z.boolean().default(true),
    },
    async confirm(args, ctx) {
      const where = args.org ?? Object.values(await ctx.repo(args)).join('/');
      return {
        target: where,
        action: `Create a webhook on ${where} that sends ${args.events.join(', ')} events to ${new URL(args.url).origin}.`,
      };
    },
    async run(args, ctx) {
      registerSecret(args.secret);
      const res = await ctx.client.request({
        method: 'POST',
        path: await hooksPath(ctx, args),
        body: {
          type: args.type,
          active: args.active,
          events: args.events,
          branch_filter: args.branch_filter,
          config: compact({ url: args.url, content_type: args.content_type, secret: args.secret }),
        },
      });
      return {
        created: true,
        webhook: slimHook(res.data),
        warning: args.url.startsWith('http:') ? 'The webhook URL uses unencrypted http.' : undefined,
      };
    },
  }),
  defineTool({
    name: 'webhook_update',
    module: M,
    title: 'Edit webhook',
    description:
      'Edits a webhook (URL, events, branch filter, active state, secret). Administrative; requires confirmation.',
    access: 'admin',
    input: {
      ...profileShape,
      ...repoShape,
      ...hookScope,
      id: z.number().int().min(1),
      url: z.url({ protocol: /^https?$/ }).optional(),
      content_type: z.enum(['json', 'form']).optional(),
      secret: z.string().min(8).max(255).optional(),
      events: z.array(z.enum(HOOK_EVENTS)).optional(),
      branch_filter: z.string().max(255).optional(),
      active: z.boolean().optional(),
    },
    async confirm(args, ctx) {
      const where = args.org ?? Object.values(await ctx.repo(args)).join('/');
      return { target: `${where}#hook-${args.id}`, action: `Change webhook ${args.id} on ${where}.` };
    },
    async run(args, ctx) {
      registerSecret(args.secret);
      const config = compact({ url: args.url, content_type: args.content_type, secret: args.secret });
      const payload = body({
        config: Object.keys(config).length ? config : undefined,
        events: args.events,
        branch_filter: args.branch_filter,
        active: args.active,
      });
      requireSomeFields(payload, 'the webhook');
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${await hooksPath(ctx, args)}/${args.id}`,
        body: payload,
      });
      return { webhook: slimHook(res.data) };
    },
  }),
  defineTool({
    name: 'webhook_delete',
    module: M,
    title: 'Delete webhook',
    description: 'Deletes a webhook. Administrative; requires confirmation.',
    access: 'admin',
    input: { ...profileShape, ...repoShape, ...hookScope, id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const where = args.org ?? Object.values(await ctx.repo(args)).join('/');
      return { target: `${where}#hook-${args.id}`, action: `Delete webhook ${args.id} on ${where}.` };
    },
    async run(args, ctx) {
      await ctx.client.request({
        method: 'DELETE',
        path: `${await hooksPath(ctx, args)}/${args.id}`,
      });
      return { deleted: args.id };
    },
  }),
  defineTool({
    name: 'webhook_test',
    module: M,
    title: 'Send test webhook',
    description: 'Triggers a test delivery of a repository webhook (sends the latest push event).',
    access: 'write',
    input: { ...profileShape, ...repoShape, id: z.number().int().min(1) },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      await ctx.client.request({ method: 'POST', path: `${repo.api}/hooks/${args.id}/tests` });
      return { triggered: true, id: args.id };
    },
  }),
  defineTool({
    name: 'notification_list',
    module: M,
    title: 'List notifications',
    description:
      'Lists your notifications (unread by default), optionally for one repository or subject type.',
    access: 'read',
    feature: 'notifications',
    input: {
      ...profileShape,
      owner: ownerSchema.optional(),
      repo: z.string().optional(),
      all: z.boolean().default(false).describe('Include read notifications.'),
      subject_type: z.array(z.enum(['issue', 'pull', 'commit', 'repository'])).optional(),
      since: dateSchema.optional(),
      ...pagingShape,
    },
    async run(args, ctx) {
      const path =
        args.owner && args.repo ? `${repoPath(args.owner, args.repo)}/notifications` : '/notifications';
      const res = await ctx.client.paginate(
        path,
        { all: args.all || undefined, 'subject-type': args.subject_type, since: args.since },
        args,
      );
      return { has_more: res.hasMore, notifications: res.items.map(slimNotification) };
    },
  }),
  defineTool({
    name: 'notification_mark_read',
    module: M,
    title: 'Mark notifications as read',
    description:
      'Marks one notification thread, or all notifications (optionally of one repository), as read.',
    access: 'write',
    feature: 'notifications',
    input: {
      ...profileShape,
      thread_id: z.number().int().min(1).optional(),
      owner: ownerSchema.optional(),
      repo: z.string().optional(),
    },
    async run(args, ctx) {
      if (args.thread_id) {
        await ctx.client.request({
          method: 'PATCH',
          path: `/notifications/threads/${args.thread_id}`,
          query: { 'to-status': 'read' },
        });
        return { marked_read: args.thread_id };
      }
      const path =
        args.owner && args.repo ? `${repoPath(args.owner, args.repo)}/notifications` : '/notifications';
      await ctx.client.request({ method: 'PUT', path, query: { 'to-status': 'read', all: true } });
      return { marked_read: args.owner && args.repo ? `${args.owner}/${args.repo}` : 'all' };
    },
  }),
  defineTool({
    name: 'repo_analyze',
    module: M,
    title: 'Analyse repository health',
    description:
      'Produces an overview of a repository: metadata, languages, activity (last commit), open issues and pull requests, latest release, branch protection, recent Actions results and the presence of README, LICENSE, CONTRIBUTING, SECURITY and CI configuration, with improvement suggestions.',
    access: 'read',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const base = repo.api;
      const info = (await ctx.client.request<Record<string, unknown>>({ path: base })).data;
      const branch = typeof info.default_branch === 'string' ? info.default_branch : 'main';
      const soft = <T>(p: Promise<T>) => p.catch(() => undefined);
      const [languages, commits, openPulls, release, protections, runs, rootFiles] = await Promise.all([
        soft(ctx.client.request<Record<string, number>>({ path: `${base}/languages` }).then((r) => r.data)),
        soft(
          ctx.client
            .request<{ sha: string; commit: { message: string; author: { date: string } } }[]>({
              path: `${base}/commits`,
              query: { sha: branch, limit: 1, stat: false, verification: false, files: false },
            })
            .then((r) => r.data),
        ),
        soft(ctx.client.request<unknown[]>({ path: `${base}/pulls`, query: { state: 'open', limit: 1 } })),
        soft(ctx.client.request({ path: `${base}/releases/latest` }).then((r) => slimRelease(r.data, false))),
        soft(
          ctx.client
            .request<{ rule_name?: string; branch_name?: string }[]>({ path: `${base}/branch_protections` })
            .then((r) => r.data),
        ),
        soft(
          ctx.client
            .request<{ workflow_runs?: unknown[] }>({ path: `${base}/actions/runs`, query: { limit: 10 } })
            .then((r) => r.data.workflow_runs ?? []),
        ),
        soft(
          ctx.client
            .request<{ name: string; type: string }[]>({ path: `${base}/contents`, query: { ref: branch } })
            .then((r) => r.data),
        ),
      ]);
      const names = new Set((rootFiles ?? []).map((f) => f.name.toLowerCase()));
      const has = (re: RegExp) => [...names].some((n) => re.test(n));
      const ciDirs = ['.gitea', '.github', '.forgejo'].filter((d) => names.has(d));
      const lastCommit = commits?.[0];
      const lastDate = lastCommit?.commit.author.date;
      const daysSince = lastDate ? Math.round((Date.now() - Date.parse(lastDate)) / 86_400_000) : undefined;
      const slimRuns = (runs ?? []).map(slimRun);
      const failed = slimRuns.filter((r) => (r as { conclusion?: string }).conclusion === 'failure').length;
      const isProtected = (protections ?? []).some((p) => (p.rule_name ?? p.branch_name) === branch);
      const files = {
        readme: has(/^readme(\.|$)/),
        license: has(/^(license|licence|copying)(\.|$)/),
        contributing: has(/^contributing(\.|$)/),
        security: has(/^security(\.|$)/),
        changelog: has(/^changelog(\.|$)/),
        gitignore: names.has('.gitignore'),
        ci_config: ciDirs.length > 0,
      };
      let workflowsPresent = false;
      if (names.has('.gitea')) {
        workflowsPresent = Boolean(
          await soft(
            ctx.client.request({ path: `${base}/contents/.gitea/workflows`, query: { ref: branch } }),
          ),
        );
      }
      const suggestions: string[] = [];
      if (!files.readme) suggestions.push('Add a README describing purpose, setup and usage.');
      if (!files.license) suggestions.push('Add a LICENSE file so others know how they may use the code.');
      if (!files.contributing && !info.private) suggestions.push('Add CONTRIBUTING guidelines.');
      if (!files.security && !info.private)
        suggestions.push('Add a SECURITY policy describing how to report vulnerabilities.');
      if (!isProtected)
        suggestions.push(`Protect the default branch "${branch}" (required reviews / status checks).`);
      if (!files.ci_config) suggestions.push('Add CI (e.g. a Gitea Actions workflow in .gitea/workflows).');
      if (failed > 0)
        suggestions.push(
          `${failed} of the last ${slimRuns.length} Actions runs failed; inspect them with actions_failures_analyze.`,
        );
      if (daysSince !== undefined && daysSince > 180)
        suggestions.push(`No commits for ${daysSince} days; consider archiving if unmaintained.`);
      if (!info.description) suggestions.push('Add a repository description.');
      if (!Array.isArray(info.topics) || info.topics.length === 0)
        suggestions.push('Add topics to make the repository discoverable.');
      const readme = files.readme
        ? await soft(
            readTextFile(ctx, repo, [...names].find((n) => /^readme/.test(n)) ?? 'README.md', branch),
          )
        : undefined;
      return {
        repository: slimRepo(info),
        languages,
        activity: {
          last_commit: lastCommit
            ? { sha: lastCommit.sha, message: lastCommit.commit.message.split('\n')[0], date: lastDate }
            : undefined,
          days_since_last_commit: daysSince,
        },
        open_issues: info.open_issues_count,
        open_pull_requests: openPulls?.totalCount ?? info.open_pr_counter,
        latest_release: release,
        default_branch_protected: isProtected,
        protection_rules: (protections ?? []).map((p) => p.rule_name ?? p.branch_name),
        actions: {
          recent_runs: slimRuns.length,
          failed_recent_runs: failed,
          workflows_directory: workflowsPresent || undefined,
          last_runs: slimRuns.slice(0, 5),
        },
        community_files: files,
        readme_length: readme?.length,
        suggestions,
      };
    },
  }),
];
