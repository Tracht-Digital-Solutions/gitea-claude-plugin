import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact, slimJob, slimRun } from '../../gitea/models.js';
import { body, pagingShape, profileShape, repoPath, repoShape, truncateText } from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';
import { readTextFile } from './contents.js';

const M = 'actions';
const runId = z.number().int().min(1).describe('Workflow run id');
const jobId = z.number().int().min(1).describe('Job id');
const workflowId = z.string().min(1).max(255).describe('Workflow id or file name, e.g. "ci.yml"');

const ERROR_LINE =
  /(##\[error\]|\bERR!|\berror\b|\bfailed\b|\bfailure\b|\bfatal\b|\bexception\b|panic:|traceback|exit code [1-9]|✗|✘)/i;

/** Reduces a job log to the lines most useful for diagnosing a failure. */
export function analyzeLog(log: string, tailLines: number) {
  const lines = log.split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));
  const errorLines: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length && errorLines.length < 60; i++) {
    const text = lines[i]!;
    if (ERROR_LINE.test(text) && !/^\s*$/.test(text))
      errorLines.push({ line: i + 1, text: text.slice(0, 500) });
  }
  return {
    total_lines: lines.length,
    error_lines: errorLines,
    tail: lines.slice(-tailLines).join('\n'),
  };
}

async function jobsOfRun(ctx: ToolContext, owner: string, repo: string, run: number) {
  const res = await ctx.client.paginate<Record<string, unknown>>(
    `${repoPath(owner, repo)}/actions/runs/${run}/jobs`,
    {},
    { limit: 200, key: 'jobs' },
  );
  return res.items;
}

async function jobLog(ctx: ToolContext, owner: string, repo: string, job: number, maxBytes: number) {
  const res = await ctx.client.request<string>({
    path: `${repoPath(owner, repo)}/actions/jobs/${job}/logs`,
    responseType: 'text',
    maxBytes,
    allowForeignRedirect: true,
  });
  return { text: res.data, truncated: res.truncated };
}

/** Restricts downloads to the working directory (or an explicit absolute path inside it). */
function safeOutputPath(cwd: string, requested: string): string {
  const full = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const rel = relative(resolve(cwd), full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new GiteaError('INVALID_INPUT', `Output path must be inside the working directory (${cwd}).`);
  }
  return full;
}

export const actionTools: ToolDefinition[] = [
  defineTool({
    name: 'actions_workflow_list',
    module: M,
    title: 'List workflows',
    description: 'Lists the Gitea Actions workflows of a repository with their state.',
    access: 'read',
    feature: 'actions_workflows',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const workflows = await ctx.client.list<Record<string, unknown>>(
        `${repoPath(owner, repo)}/actions/workflows`,
        {},
        'workflows',
      );
      return {
        total: workflows.length,
        workflows: workflows.map((w) =>
          compact({ id: w.id, name: w.name, path: w.path, state: w.state, html_url: w.html_url }),
        ),
      };
    },
  }),
  defineTool({
    name: 'actions_workflow_get',
    module: M,
    title: 'Read workflow configuration',
    description: 'Returns a workflow and its YAML configuration file.',
    access: 'read',
    feature: 'actions_workflows',
    input: { ...profileShape, ...repoShape, workflow: workflowId, ref: z.string().max(255).optional() },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request<{ path?: string; name?: string; state?: string; id?: string }>({
        path: `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(args.workflow)}`,
      });
      const yaml = res.data.path ? await readTextFile(ctx, owner, repo, res.data.path, args.ref) : undefined;
      return {
        ...compact({ id: res.data.id, name: res.data.name, path: res.data.path, state: res.data.state }),
        content: yaml,
      };
    },
  }),
  defineTool({
    name: 'actions_run_list',
    module: M,
    title: 'List workflow runs',
    description:
      'Lists Gitea Actions workflow runs, newest first, filtered by status (e.g. failure, success, in_progress), branch, event, actor, commit or workflow.',
    access: 'read',
    feature: 'actions_runs',
    input: {
      ...profileShape,
      ...repoShape,
      workflow: workflowId.optional().describe('Only runs of this workflow (id or file name).'),
      status: z
        .enum([
          'pending',
          'queued',
          'in_progress',
          'waiting',
          'success',
          'failure',
          'cancelled',
          'skipped',
          'blocked',
        ])
        .optional(),
      branch: z.string().max(255).optional(),
      event: z.string().max(100).optional(),
      actor: z.string().max(100).optional(),
      head_sha: z.string().max(64).optional(),
      ...pagingShape,
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const path = args.workflow
        ? `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(args.workflow)}/runs`
        : `${repoPath(owner, repo)}/actions/runs`;
      const res = await ctx.client.paginate(
        path,
        {
          status: args.status,
          branch: args.branch,
          event: args.event,
          actor: args.actor,
          head_sha: args.head_sha,
        },
        { limit: args.limit, page: args.page, key: 'workflow_runs' },
      );
      return { total: res.totalCount, has_more: res.hasMore, runs: res.items.map(slimRun) };
    },
  }),
  defineTool({
    name: 'actions_run_get',
    module: M,
    title: 'Get workflow run',
    description: 'Returns a workflow run with its status, conclusion and jobs (including steps).',
    access: 'read',
    feature: 'actions_runs',
    input: { ...profileShape, ...repoShape, run_id: runId },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const run = await ctx.client.request({ path: `${repoPath(owner, repo)}/actions/runs/${args.run_id}` });
      const jobs = await jobsOfRun(ctx, owner, repo, args.run_id).catch(() => undefined);
      return { ...slimRun(run.data), jobs: jobs?.map(slimJob) };
    },
  }),
  defineTool({
    name: 'actions_job_logs',
    module: M,
    title: 'Get job logs',
    description:
      'Returns the log of a job: lines that look like errors and the last `tail_lines` lines (or the full log).',
    access: 'read',
    feature: 'actions_job_logs',
    input: {
      ...profileShape,
      ...repoShape,
      job_id: jobId,
      tail_lines: z.number().int().min(10).max(5000).default(200),
      full: z.boolean().default(false).describe('Return the full log (truncated to max_chars).'),
      max_chars: z.number().int().min(1000).max(1_000_000).default(100_000),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const log = await jobLog(ctx, owner, repo, args.job_id, 20 * 1024 * 1024);
      if (args.full) {
        const t = truncateText(log.text, args.max_chars);
        return { job_id: args.job_id, truncated: t.truncated || log.truncated, log: t.text };
      }
      return {
        job_id: args.job_id,
        download_truncated: log.truncated || undefined,
        ...analyzeLog(log.text, args.tail_lines),
      };
    },
  }),
  defineTool({
    name: 'actions_failures_analyze',
    module: M,
    title: 'Analyse failed workflow runs',
    description:
      'Finds the most recent failed Gitea Actions runs and, for each, the failed jobs and steps plus the error lines and tail of their logs. Use for "show/analyse the failed Actions runs".',
    access: 'read',
    feature: 'actions_runs',
    input: {
      ...profileShape,
      ...repoShape,
      branch: z.string().max(255).optional(),
      workflow: workflowId.optional(),
      max_runs: z.number().int().min(1).max(20).default(5),
      tail_lines: z.number().int().min(10).max(500).default(60),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const caps = await ctx.capabilities();
      const path = args.workflow
        ? `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(args.workflow)}/runs`
        : `${repoPath(owner, repo)}/actions/runs`;
      const runs = await ctx.client.paginate<Record<string, unknown>>(
        path,
        { status: 'failure', branch: args.branch },
        { limit: args.max_runs, key: 'workflow_runs' },
      );
      const analysed = [];
      for (const run of runs.items) {
        const id = Number(run.id);
        const jobs = await jobsOfRun(ctx, owner, repo, id).catch(() => [] as Record<string, unknown>[]);
        const failed = jobs.filter((j) => j.conclusion === 'failure' || j.status === 'failure');
        const failedJobs = [];
        for (const job of failed.slice(0, 5)) {
          let log: Record<string, unknown> | undefined;
          if (caps.features.actions_job_logs !== false) {
            log = await jobLog(ctx, owner, repo, Number(job.id), 5 * 1024 * 1024)
              .then((l) => analyzeLog(l.text, args.tail_lines))
              .catch((err: unknown) => ({
                unavailable: err instanceof GiteaError ? err.message : String(err),
              }));
          }
          const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
          failedJobs.push({
            ...slimJob(job),
            steps: undefined,
            failed_steps: steps
              .filter((s) => s.conclusion === 'failure' || s.status === 'failure')
              .map((s) => s.name),
            log,
          });
        }
        analysed.push({ ...slimRun(run), failed_jobs: failedJobs });
      }
      return {
        repository: `${owner}/${repo}`,
        failed_runs_found: runs.totalCount ?? runs.items.length,
        runs: analysed,
        note: runs.items.length ? undefined : 'No failed runs found.',
      };
    },
  }),
  defineTool({
    name: 'actions_workflow_dispatch',
    module: M,
    title: 'Start workflow',
    description:
      'Starts a workflow that has a workflow_dispatch trigger on a branch or tag, with optional inputs.',
    access: 'write',
    feature: 'actions_dispatch',
    input: {
      ...profileShape,
      ...repoShape,
      workflow: workflowId,
      ref: z.string().min(1).max(255).describe('Branch or tag to run on'),
      inputs: z.record(z.string(), z.string()).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`,
        query: { return_run_details: true },
        body: body({ ref: args.ref, inputs: args.inputs }),
      });
      return {
        dispatched: true,
        workflow: args.workflow,
        ref: args.ref,
        run: res.data ? res.data : undefined,
      };
    },
  }),
  defineTool({
    name: 'actions_run_rerun',
    module: M,
    title: 'Re-run workflow run',
    description: 'Re-runs a whole workflow run, only its failed jobs, or a single job.',
    access: 'write',
    feature: 'actions_rerun',
    input: {
      ...profileShape,
      ...repoShape,
      run_id: runId,
      mode: z.enum(['all', 'failed', 'job']).default('all'),
      job_id: jobId.optional().describe('Required for mode "job".'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/actions/runs/${args.run_id}`;
      let path = `${base}/rerun`;
      if (args.mode === 'failed') {
        const caps = await ctx.capabilities();
        if (caps.features.actions_rerun_failed === false) {
          throw new GiteaError('UNSUPPORTED', 'This Gitea version cannot re-run only failed jobs.');
        }
        path = `${base}/rerun-failed-jobs`;
      } else if (args.mode === 'job') {
        if (!args.job_id) throw new GiteaError('INVALID_INPUT', 'job_id is required for mode "job".');
        path = `${base}/jobs/${args.job_id}/rerun`;
      }
      const res = await ctx.client.request({ method: 'POST', path });
      return { rerun: args.mode, run_id: args.run_id, result: res.data ? slimRun(res.data) : undefined };
    },
  }),
  defineTool({
    name: 'actions_run_cancel',
    module: M,
    title: 'Cancel workflow run',
    description: 'Cancels a queued or running workflow run.',
    access: 'write',
    feature: 'actions_cancel',
    input: { ...profileShape, ...repoShape, run_id: runId },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      await ctx.client.request({
        method: 'POST',
        path: `${repoPath(owner, repo)}/actions/runs/${args.run_id}/cancel`,
      });
      return { cancelled: args.run_id };
    },
  }),
  defineTool({
    name: 'actions_artifact_list',
    module: M,
    title: 'List workflow artifacts',
    description: 'Lists artifacts of a workflow run, or of the whole repository.',
    access: 'read',
    feature: 'actions_artifacts',
    input: {
      ...profileShape,
      ...repoShape,
      run_id: runId.optional(),
      name: z.string().max(255).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const path = args.run_id
        ? `${repoPath(owner, repo)}/actions/runs/${args.run_id}/artifacts`
        : `${repoPath(owner, repo)}/actions/artifacts`;
      const artifacts = await ctx.client.list<Record<string, unknown>>(
        path,
        { name: args.name },
        'artifacts',
      );
      return {
        total: artifacts.length,
        artifacts: artifacts.slice(0, args.limit).map((a) =>
          compact({
            id: a.id,
            name: a.name,
            size_in_bytes: a.size_in_bytes,
            expired: a.expired,
            created_at: a.created_at,
            expires_at: a.expires_at,
          }),
        ),
      };
    },
  }),
  defineTool({
    name: 'actions_artifact_download',
    module: M,
    title: 'Download workflow artifact',
    description:
      'Downloads an artifact as a zip file into the working directory (default: ./artifacts/<name>.zip). Does not overwrite existing files unless `overwrite` is true.',
    access: 'read',
    feature: 'actions_artifact_download',
    input: {
      ...profileShape,
      ...repoShape,
      artifact_id: z.number().int().min(1),
      output_path: z
        .string()
        .max(4096)
        .optional()
        .describe('Target file, relative to the working directory.'),
      overwrite: z.boolean().default(false),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const meta = await ctx.client.request<{ name: string; size_in_bytes: number; expired?: boolean }>({
        path: `${repoPath(owner, repo)}/actions/artifacts/${args.artifact_id}`,
      });
      if (meta.data.expired) throw new GiteaError('NOT_FOUND', `Artifact ${args.artifact_id} has expired.`);
      const safeName = meta.data.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const target = safeOutputPath(ctx.cwd, args.output_path ?? `artifacts/${safeName}.zip`);
      if (existsSync(target) && !args.overwrite) {
        throw new GiteaError('CONFLICT', `${target} already exists. Set overwrite to true to replace it.`);
      }
      if (existsSync(target) && statSync(target).isDirectory()) {
        throw new GiteaError('INVALID_INPUT', `${target} is a directory.`);
      }
      const res = await ctx.client.request<Buffer>({
        path: `${repoPath(owner, repo)}/actions/artifacts/${args.artifact_id}/zip`,
        responseType: 'binary',
        maxBytes: 500 * 1024 * 1024,
        allowForeignRedirect: true,
      });
      if (res.truncated)
        throw new GiteaError('INVALID_INPUT', 'Artifact is larger than 500 MB; download it in the web UI.');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, res.data);
      return { saved_to: target, bytes: res.data.length, name: meta.data.name };
    },
  }),
  defineTool({
    name: 'actions_runner_list',
    module: M,
    title: 'List Actions runners',
    description:
      'Lists the Actions runners available to a repository, an organisation (org) or your user account, with status, labels and whether they are busy. Use it to find out why a workflow run stays queued.',
    access: 'read',
    feature: 'actions_runners',
    input: {
      ...profileShape,
      ...repoShape,
      scope: z.enum(['repo', 'org', 'user']).default('repo'),
      org: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,100}$/)
        .optional(),
    },
    async run(args, ctx) {
      let path: string;
      if (args.scope === 'user') path = '/user/actions/runners';
      else if (args.scope === 'org') {
        if (!args.org) throw new GiteaError('INVALID_INPUT', 'org is required for scope "org".');
        path = `/orgs/${encodeURIComponent(args.org)}/actions/runners`;
      } else {
        const { owner, repo } = await ctx.repo(args);
        path = `${repoPath(owner, repo)}/actions/runners`;
      }
      const runners = await ctx.client.list<Record<string, unknown>>(path, {}, 'runners');
      return {
        scope: args.scope,
        total: runners.length,
        online: runners.filter((r) => r.status === 'online' || r.status === 'idle' || r.status === 'active')
          .length,
        runners: runners.map((r) =>
          compact({
            id: r.id,
            name: r.name,
            status: r.status,
            busy: r.busy,
            disabled: r.disabled || undefined,
            labels: Array.isArray(r.labels)
              ? r.labels.map((l: unknown) =>
                  typeof l === 'object' && l !== null ? (l as { name?: string }).name : l,
                )
              : undefined,
          }),
        ),
        note: runners.length
          ? undefined
          : 'No runner is registered for this scope; workflow runs will stay queued. Instance-wide runners are not listed here.',
      };
    },
  }),
];
