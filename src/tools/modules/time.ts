import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact } from '../../gitea/models.js';
import { dateSchema, indexSchema, pagingShape, profileShape, repoShape } from '../common.js';
import { defineTool, type ToolDefinition } from '../types.js';

/** Time tracking: tracked times and stopwatches of issues and pull requests. */
const M = 'time_tracking';

interface RawTime {
  id: number;
  created: string;
  time: number;
  user_name?: string;
  issue_id?: number;
  issue?: { number?: number; title?: string } | null;
}

/**
 * Parses a duration given as seconds or as a human string such as "1h30m", "90m", "2h 15m",
 * "45s" or "1.5h". Returns whole seconds.
 */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') return Math.round(value);
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v)) return Number(v);
  const re = /(\d+(?:[.,]\d+)?)\s*(std|min|sek|sec|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]!.replace(',', '.'));
    const unit = m[2]!;
    total += unit.startsWith('h') || unit === 'std' ? n * 3600 : unit.startsWith('m') ? n * 60 : n;
    consumed += m[0];
  }
  if (!consumed || consumed.replace(/\s/g, '') !== v.replace(/\s/g, '')) {
    throw new GiteaError('INVALID_INPUT', `Cannot parse duration "${value}".`, {
      hint: 'Use seconds or a value such as "1h30m", "90m", "2h" or "45s".',
    });
  }
  return Math.round(total);
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s || (!h && !m) ? `${s}s` : ''].join('');
}

const slimTime = (t: RawTime) =>
  compact({
    id: t.id,
    user: t.user_name,
    seconds: t.time,
    duration: formatDuration(t.time),
    created: t.created,
    issue: t.issue?.number,
    issue_title: t.issue?.title,
  });

function summarize(times: RawTime[]) {
  const byUser = new Map<string, number>();
  for (const t of times) byUser.set(t.user_name ?? '?', (byUser.get(t.user_name ?? '?') ?? 0) + t.time);
  const total = times.reduce((s, t) => s + t.time, 0);
  return {
    total_seconds: total,
    total: formatDuration(total),
    by_user: Object.fromEntries([...byUser].map(([u, s]) => [u, formatDuration(s)])),
  };
}

const durationInput = z
  .union([z.number().int().min(1).max(10_000_000), z.string().min(1).max(50)])
  .describe('Duration as seconds or text like "1h30m", "90m", "2h", "45s"');

export const timeTools: ToolDefinition[] = [
  defineTool({
    name: 'time_list',
    module: M,
    title: 'List tracked time',
    description:
      'Lists tracked time with totals per user: for one issue (`number`), for a whole repository, or (`mine: true`) your own entries across all repositories. Filter by user and date range.',
    access: 'read',
    feature: 'time_tracking',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('issue or pull request').optional(),
      mine: z.boolean().default(false).describe('Only your own tracked time across all repositories.'),
      user: z.string().max(100).optional().describe('Only entries of this user.'),
      since: dateSchema.optional(),
      before: dateSchema.optional(),
      ...pagingShape,
      limit: z.number().int().min(1).max(1000).default(200),
    },
    async run(args, ctx) {
      let path: string;
      let query: Record<string, string | undefined> = { since: args.since, before: args.before };
      if (args.mine) path = '/user/times';
      else {
        const repo = await ctx.repo(args);
        path = args.number ? `${repo.api}/issues/${args.number}/times` : `${repo.api}/times`;
        query = { ...query, user: args.user };
      }
      const res = await ctx.client.paginate<RawTime>(path, query, { limit: args.limit, page: args.page });
      return { has_more: res.hasMore, ...summarize(res.items), entries: res.items.map(slimTime) };
    },
  }),
  defineTool({
    name: 'time_add',
    module: M,
    title: 'Add tracked time',
    description:
      'Books time on an issue or pull request. Optionally backdate it (`created`) or, as a repository admin, book it for another user (`user_name`).',
    access: 'write',
    feature: 'time_tracking',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('issue or pull request'),
      duration: durationInput,
      created: dateSchema.optional().describe('When the work was done (default: now).'),
      user_name: z.string().max(100).optional().describe('Book for this user (requires admin rights).'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const seconds = parseDuration(args.duration);
      if (seconds <= 0) throw new GiteaError('INVALID_INPUT', 'Duration must be positive.');
      const res = await ctx.client.request<RawTime>({
        method: 'POST',
        path: `${repo.api}/issues/${args.number}/times`,
        body: compact({ time: seconds, created: args.created, user_name: args.user_name }),
      });
      // The POST response echoes the requested date; read the stored entry back to report what
      // Gitea actually saved (some versions ignore `created` and store the current time).
      let stored = res.data;
      let warning: string | undefined;
      if (args.created) {
        const list = await ctx.client.paginate<RawTime>(
          `${repo.api}/issues/${args.number}/times`,
          {},
          { limit: 1000 },
        );
        stored = list.items.find((t) => t.id === res.data.id) ?? stored;
        if (Date.parse(stored.created) !== Date.parse(args.created)) {
          warning = `This Gitea server ignored the requested date ${args.created} and stored ${stored.created}. Backdating tracked time is not supported here.`;
        }
      }
      return { added: slimTime(stored), warning };
    },
  }),
  defineTool({
    name: 'time_delete',
    module: M,
    title: 'Delete tracked time',
    description:
      'Deletes one tracked-time entry (`id`) of an issue, or with `all: true` resets all of your tracked time on that issue. Requires confirmation.',
    access: 'destructive',
    feature: 'time_tracking',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('issue or pull request'),
      id: z.number().int().min(1).optional(),
      all: z.boolean().default(false),
    },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      if (!args.id && !args.all) throw new GiteaError('INVALID_INPUT', 'Pass id, or all: true.');
      return {
        target: `${repo.fullName}#${args.number}:time-${args.all ? 'all' : String(args.id)}`,
        action: args.all
          ? `Delete ALL of your tracked time on ${repo.fullName}#${args.number}.`
          : `Delete tracked-time entry ${String(args.id)} on ${repo.fullName}#${args.number}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const base = `${repo.api}/issues/${args.number}/times`;
      await ctx.client.request({ method: 'DELETE', path: args.all ? base : `${base}/${String(args.id)}` });
      return { deleted: args.all ? 'all' : args.id };
    },
  }),
  defineTool({
    name: 'stopwatch',
    module: M,
    title: 'Start or stop the stopwatch',
    description:
      'Starts the stopwatch on an issue, stops it (the elapsed time is booked as tracked time) or cancels it (discarded).',
    access: 'write',
    feature: 'time_tracking',
    input: {
      ...profileShape,
      ...repoShape,
      number: indexSchema('issue or pull request'),
      action: z.enum(['start', 'stop', 'cancel']),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const base = `${repo.api}/issues/${args.number}/stopwatch`;
      if (args.action === 'cancel') await ctx.client.request({ method: 'DELETE', path: `${base}/delete` });
      else await ctx.client.request({ method: 'POST', path: `${base}/${args.action}` });
      return {
        issue: args.number,
        stopwatch:
          args.action === 'start'
            ? 'running'
            : args.action === 'stop'
              ? 'stopped (time booked)'
              : 'cancelled',
      };
    },
  }),
  defineTool({
    name: 'stopwatch_list',
    module: M,
    title: 'List running stopwatches',
    description: 'Lists your running stopwatches with the issue and the elapsed time.',
    access: 'read',
    feature: 'time_tracking',
    input: { ...profileShape },
    async run(_args, ctx) {
      const res = await ctx.client.paginate<Record<string, unknown>>('/user/stopwatches', {}, { limit: 100 });
      return {
        stopwatches: res.items.map((s) =>
          compact({
            repository: `${String(s.repo_owner_name)}/${String(s.repo_name)}`,
            issue: s.issue_index,
            title: s.issue_title,
            elapsed: typeof s.seconds === 'number' ? formatDuration(s.seconds) : s.duration,
            started: s.created,
          }),
        ),
      };
    },
  }),
];
