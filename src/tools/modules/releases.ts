import * as z from 'zod/v4';
import { GiteaError, ifFound } from '../../gitea/errors.js';
import { FormData } from '../../gitea/http.js';
import { slimAsset, slimCommit, slimRelease } from '../../gitea/models.js';
import { readWorkdirFile } from '../../security/workdir.js';
import { body, pagingShape, profileShape, repoShape, requireSomeFields } from '../common.js';
import { defineTool, type ToolContext, type RepoRef, type ToolDefinition } from '../types.js';
import { defaultBranch } from '../shared/repo-files.js';
import { commitType } from './git.js';

/** Releases, release assets and release notes generated from Conventional Commits. */
const M = 'releases';
const tagInput = z.string().min(1).max(255).describe('Tag name, e.g. v1.2.0');
const releaseRef = z
  .union([z.number().int().min(1), z.string().min(1).max(255)])
  .describe('Release id or tag name');

interface RawRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  created_at: string;
  published_at?: string;
  target_commitish: string;
}

interface CompareCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  author?: { login?: string } | null;
}

const SECTION_TITLES: Record<string, string> = {
  breaking: '⚠ Breaking changes',
  feat: 'Features',
  fix: 'Bug fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Build system',
  ci: 'Continuous integration',
  chore: 'Chores',
  other: 'Other changes',
};

/**
 * Whether a tag names a pre-release: any SemVer pre-release suffix (`v1.2.0-rc.1`, `1.0.0-test.1`),
 * or a common pre-release word in tags that are not SemVer.
 */
export function isPrereleaseTag(tag: string): boolean {
  if (/^v?\d+(?:\.\d+){0,2}-[0-9A-Za-z][0-9A-Za-z.-]*(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) return true;
  return /(?:^|[-_.])(alpha|beta|rc|pre|preview|dev|snapshot|nightly)(?:$|[-_.\d])/i.test(tag);
}

/** Groups commits by Conventional Commit type into Markdown release notes. */
export function buildReleaseNotes(
  commits: CompareCommit[],
  opts: { previousTag?: string | undefined; tag: string; compareUrl?: string | undefined },
): string {
  const groups = new Map<string, string[]>();
  for (const c of commits) {
    const subject = c.commit.message.split('\n')[0]!.trim();
    if (/^Merge (branch|pull request|remote-tracking)/i.test(subject)) continue;
    const t = commitType(c.commit.message);
    const clean = subject.replace(/^\w+(\([^)]*\))?!?:\s*/, '');
    const scope = t.scope ? `**${t.scope}:** ` : '';
    const who = c.author?.login ? ` (@${c.author.login})` : '';
    const line = `- ${scope}${clean} (${c.sha.slice(0, 7)})${who}`;
    const key = t.breaking ? 'breaking' : SECTION_TITLES[t.type] ? t.type : 'other';
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const parts = [`## ${opts.tag}`, ''];
  for (const key of Object.keys(SECTION_TITLES)) {
    const lines = groups.get(key);
    if (!lines?.length) continue;
    parts.push(`### ${SECTION_TITLES[key]}`, '', ...lines, '');
  }
  if (groups.size === 0) parts.push('No changes.', '');
  if (opts.previousTag && opts.compareUrl) parts.push(`**Full changelog:** ${opts.compareUrl}`);
  return parts.join('\n').trim();
}

async function getRelease(ctx: ToolContext, repo: RepoRef, ref: number | string): Promise<RawRelease> {
  const base = `${repo.api}/releases`;
  const path =
    typeof ref === 'number'
      ? `${base}/${ref}`
      : ref === 'latest'
        ? `${base}/latest`
        : `${base}/tags/${encodeURIComponent(ref)}`;
  return (await ctx.client.request<RawRelease>({ path })).data;
}

/** Most recent published release tag older than `tag` (by creation date). */
async function previousReleaseTag(ctx: ToolContext, repo: RepoRef, tag: string, includePrerelease: boolean) {
  const res = await ctx.client.paginate<RawRelease>(`${repo.api}/releases`, { draft: false }, { limit: 100 });
  const sorted = res.items
    .filter((r) => !r.draft && (includePrerelease || !r.prerelease))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const idx = sorted.findIndex((r) => r.tag_name === tag);
  const candidates = idx >= 0 ? sorted.slice(idx + 1) : sorted;
  return candidates.find((r) => r.tag_name !== tag)?.tag_name;
}

async function commitsBetween(ctx: ToolContext, repo: RepoRef, base: string | undefined, head: string) {
  if (!base) {
    const res = await ctx.client.paginate<CompareCommit>(
      `${repo.api}/commits`,
      { sha: head, stat: false, verification: false, files: false },
      { limit: 500 },
    );
    return res.items;
  }
  const res = await ctx.client.request<{ commits?: CompareCommit[] }>({
    path: `${repo.api}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  });
  return res.data.commits ?? [];
}

async function generateNotes(
  ctx: ToolContext,
  repo: RepoRef,
  tag: string,
  target: string | undefined,
  previous: string | undefined,
  includePrerelease: boolean,
) {
  const prev = previous ?? (await previousReleaseTag(ctx, repo, tag, includePrerelease));
  // An existing tag is the head; for a tag that is about to be created, use its target branch.
  const tagExists =
    (await ifFound(ctx.client.request({ path: `${repo.api}/tags/${encodeURIComponent(tag)}` }))) !==
    undefined;
  const head = (tagExists ? tag : target) ?? (await defaultBranch(ctx, repo));
  const commits = await commitsBetween(ctx, repo, prev, head);
  const compareUrl = prev
    ? new URL(`${repo.fullName}/compare/${prev}...${tag}`, ctx.profile.baseUrl).href
    : undefined;
  return {
    previous_tag: prev,
    commit_count: commits.length,
    notes: buildReleaseNotes(commits, { previousTag: prev, tag, compareUrl }),
  };
}

/** Largest file uploaded as a release asset. */
const MAX_ASSET_BYTES = 500 * 1024 * 1024;

export const releaseTools: ToolDefinition[] = [
  defineTool({
    name: 'release_list',
    module: M,
    title: 'List releases',
    description: 'Lists releases (newest first), optionally excluding drafts or pre-releases.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      draft: z.boolean().optional().describe('Filter by draft state.'),
      prerelease: z.boolean().optional().describe('Filter by pre-release state.'),
      include_body: z.boolean().default(false),
      ...pagingShape,
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const res = await ctx.client.paginate(
        `${repo.api}/releases`,
        { draft: args.draft, 'pre-release': args.prerelease },
        args,
      );
      return {
        total: res.totalCount,
        has_more: res.hasMore,
        releases: res.items.map((r) => slimRelease(r, args.include_body)),
      };
    },
  }),
  defineTool({
    name: 'release_get',
    module: M,
    title: 'Get release',
    description: 'Returns a release by id, tag name, or "latest" with notes and assets.',
    access: 'read',
    input: { ...profileShape, ...repoShape, release: releaseRef.default('latest') },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      return slimRelease(await getRelease(ctx, repo, args.release));
    },
  }),
  defineTool({
    name: 'release_notes_generate',
    module: M,
    title: 'Generate release notes',
    description:
      'Generates Markdown release notes for a tag (or a target branch/commit that will be tagged) from the commits since the previous release, grouped by Conventional Commit type. Does not change anything.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      tag: tagInput.describe('The (future) tag of the release'),
      target: z.string().max(255).optional().describe('Branch or commit if the tag does not exist yet'),
      previous_tag: z
        .string()
        .max(255)
        .optional()
        .describe('Compare against this tag instead of the previous release'),
      include_prereleases: z.boolean().default(false),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      return generateNotes(ctx, repo, args.tag, args.target, args.previous_tag, args.include_prereleases);
    },
  }),
  defineTool({
    name: 'release_create',
    module: M,
    title: 'Create release',
    description:
      'Creates a release for a tag. If the tag does not exist it is created on `target` (default branch). Set generate_notes to build the notes from commits since the previous release. Use draft or prerelease for unfinished versions.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      tag: tagInput,
      target: z.string().max(255).optional().describe('Branch or commit for a new tag'),
      name: z.string().max(255).optional().describe('Release title (default: the tag)'),
      body: z.string().max(100_000).optional().describe('Release notes (Markdown)'),
      generate_notes: z.boolean().default(false),
      previous_tag: z.string().max(255).optional(),
      draft: z.boolean().default(false),
      prerelease: z
        .boolean()
        .optional()
        .describe('Default: true for SemVer pre-release tags such as v1.0.0-rc.1 or v1.0.0-test.1'),
      tag_message: z.string().max(10_000).optional().describe('Annotation for a newly created tag'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      let notes = args.body;
      let generated: Record<string, unknown> | undefined;
      if (args.generate_notes) {
        const g = await generateNotes(ctx, repo, args.tag, args.target, args.previous_tag, false);
        notes = notes ? `${notes}\n\n${g.notes}` : g.notes;
        generated = { previous_tag: g.previous_tag, commit_count: g.commit_count };
      }
      const prerelease = args.prerelease ?? isPrereleaseTag(args.tag);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repo.api}/releases`,
        body: body({
          tag_name: args.tag,
          target_commitish: args.target,
          name: args.name ?? args.tag,
          body: notes,
          draft: args.draft,
          prerelease,
          tag_message: args.tag_message,
        }),
      });
      return { created: true, generated_notes: generated, release: slimRelease(res.data) };
    },
  }),
  defineTool({
    name: 'release_update',
    module: M,
    title: 'Edit release',
    description:
      'Edits a release: title, notes, tag, target, draft or pre-release flag (e.g. publish a draft).',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      release: releaseRef,
      name: z.string().max(255).optional(),
      body: z.string().max(100_000).optional(),
      tag: z.string().max(255).optional(),
      target: z.string().max(255).optional(),
      draft: z.boolean().optional(),
      prerelease: z.boolean().optional(),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const rel = await getRelease(ctx, repo, args.release);
      const payload = body({
        name: args.name,
        body: args.body,
        tag_name: args.tag,
        target_commitish: args.target,
        draft: args.draft,
        prerelease: args.prerelease,
      });
      requireSomeFields(payload, 'the release');
      const res = await ctx.client.request({
        method: 'PATCH',
        path: `${repo.api}/releases/${rel.id}`,
        body: payload,
      });
      return { release: slimRelease(res.data) };
    },
  }),
  defineTool({
    name: 'release_delete',
    module: M,
    title: 'Delete release',
    description:
      'Deletes a release and its assets (the git tag is kept unless delete_tag is set). Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, release: releaseRef, delete_tag: z.boolean().default(false) },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${String(args.release)}`,
        action: `Delete release ${String(args.release)} of ${repo.fullName} with its assets${args.delete_tag ? ' AND its git tag' : ''}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const rel = await getRelease(ctx, repo, args.release);
      await ctx.client.request({ method: 'DELETE', path: `${repo.api}/releases/${rel.id}` });
      if (args.delete_tag) {
        await ctx.client.request({
          method: 'DELETE',
          path: `${repo.api}/tags/${encodeURIComponent(rel.tag_name)}`,
        });
      }
      return { deleted: rel.tag_name, tag_deleted: args.delete_tag };
    },
  }),
  defineTool({
    name: 'release_asset_list',
    module: M,
    title: 'List release assets',
    description: 'Lists the files attached to a release.',
    access: 'read',
    input: { ...profileShape, ...repoShape, release: releaseRef },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const rel = await getRelease(ctx, repo, args.release);
      const res = await ctx.client.request<unknown[]>({
        path: `${repo.api}/releases/${rel.id}/assets`,
      });
      return { release: rel.tag_name, assets: res.data.map(slimAsset) };
    },
  }),
  defineTool({
    name: 'release_asset_upload',
    module: M,
    title: 'Upload release asset',
    description: 'Uploads a local file (inside the working directory) as an asset of a release.',
    access: 'write',
    input: {
      ...profileShape,
      ...repoShape,
      release: releaseRef,
      file: z.string().min(1).max(4096).describe('Path of the local file, relative to the working directory'),
      name: z.string().max(255).optional().describe('Asset name (default: file name)'),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const rel = await getRelease(ctx, repo, args.release);
      const file = await readWorkdirFile(ctx.cwd, args.file, MAX_ASSET_BYTES);
      const name = args.name ?? file.name;
      const form = new FormData();
      form.append('attachment', new Blob([file.data]), name);
      const res = await ctx.client.request({
        method: 'POST',
        path: `${repo.api}/releases/${rel.id}/assets`,
        query: { name },
        form,
      });
      return { uploaded: true, release: rel.tag_name, asset: slimAsset(res.data) };
    },
  }),
  defineTool({
    name: 'release_asset_delete',
    module: M,
    title: 'Delete release asset',
    description: 'Deletes a file attached to a release. Requires confirmation.',
    access: 'destructive',
    input: { ...profileShape, ...repoShape, release: releaseRef, asset_id: z.number().int().min(1) },
    async confirm(args, ctx) {
      const repo = await ctx.repo(args);
      return {
        target: `${repo.fullName}@${String(args.release)}#asset-${args.asset_id}`,
        action: `Delete asset ${args.asset_id} from release ${String(args.release)} of ${repo.fullName}.`,
      };
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      const rel = await getRelease(ctx, repo, args.release);
      await ctx.client.request({
        method: 'DELETE',
        path: `${repo.api}/releases/${rel.id}/assets/${args.asset_id}`,
      });
      return { deleted: args.asset_id };
    },
  }),
  defineTool({
    name: 'release_compare',
    module: M,
    title: 'Compare two releases',
    description:
      'Compares two releases (default: the latest two published releases): commits between them grouped by type, changed files and both release notes.',
    access: 'read',
    input: {
      ...profileShape,
      ...repoShape,
      base: z.string().max(255).optional().describe('Older release tag'),
      head: z.string().max(255).optional().describe('Newer release tag'),
      include_prereleases: z.boolean().default(true),
    },
    async run(args, ctx) {
      const repo = await ctx.repo(args);
      let { base, head } = args;
      if (!base || !head) {
        const list = await ctx.client.paginate<RawRelease>(
          `${repo.api}/releases`,
          { draft: false },
          { limit: 50 },
        );
        const sorted = list.items
          .filter((r) => !r.draft && (args.include_prereleases || !r.prerelease))
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        head ??= sorted[0]?.tag_name;
        base ??= sorted.find((r) => r.tag_name !== head)?.tag_name;
      }
      if (!base || !head)
        throw new GiteaError('NOT_FOUND', 'At least two releases are needed for a comparison.');
      const [baseRel, headRel] = await Promise.all([
        getRelease(ctx, repo, base).catch(() => undefined),
        getRelease(ctx, repo, head).catch(() => undefined),
      ]);
      const res = await ctx.client.request<{
        total_commits?: number;
        commits?: (CompareCommit & { files?: { filename: string; status: string }[] })[];
      }>({
        path: `${repo.api}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      });
      const commits = res.data.commits ?? [];
      const files = new Map<string, string>();
      for (const c of commits) for (const f of c.files ?? []) files.set(f.filename, f.status);
      const byType: Record<string, number> = {};
      for (const c of commits) {
        const t = commitType(c.commit.message);
        const key = t.breaking ? 'breaking' : t.type;
        byType[key] = (byType[key] ?? 0) + 1;
      }
      return {
        base: baseRel ? slimRelease(baseRel, false) : { tag_name: base },
        head: headRel ? slimRelease(headRel, false) : { tag_name: head },
        days_between:
          baseRel && headRel
            ? Math.round((Date.parse(headRel.created_at) - Date.parse(baseRel.created_at)) / 86_400_000)
            : undefined,
        total_commits: res.data.total_commits ?? commits.length,
        commits_by_type: byType,
        commits: commits.slice(0, 200).map((c) => slimCommit(c)),
        changed_files: [...files].map(([filename, status]) => ({ filename, status })),
        base_notes: baseRel?.body,
        head_notes: headRel?.body,
      };
    },
  }),
];
