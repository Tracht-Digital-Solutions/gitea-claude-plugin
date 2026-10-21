import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact } from '../../gitea/models.js';
import { profileShape, repoPath, repoShape, truncateText } from '../common.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../types.js';

const M = 'wiki';

interface RawPage {
  title: string;
  sub_url?: string;
  html_url?: string;
  content_base64?: string;
  commit_count?: number;
  sidebar?: string;
  footer?: string;
  last_commit?: { sha?: string; message?: string; author?: { name?: string; date?: string } } | null;
}

const pageInput = z.string().min(1).max(255).describe('Page title or its URL name (e.g. "Getting-Started")');

const slimMeta = (p: RawPage) =>
  compact({
    title: p.title,
    page: p.sub_url,
    html_url: p.html_url,
    last_change: p.last_commit?.author?.date,
    last_message: p.last_commit?.message?.trim(),
  });

/** Gitea addresses pages by their URL name; accept the title as well. */
async function resolvePage(ctx: ToolContext, base: string, page: string): Promise<string> {
  try {
    await ctx.client.request({ path: `${base}/page/${encodeURIComponent(page)}` });
    return page;
  } catch (err) {
    if (!(err instanceof GiteaError) || err.code !== 'NOT_FOUND') throw err;
  }
  const pages = await ctx.client.paginate<RawPage>(`${base}/pages`, {}, { limit: 1000 });
  const found = pages.items.find(
    (p) => p.title.toLowerCase() === page.toLowerCase() || p.sub_url?.toLowerCase() === page.toLowerCase(),
  );
  if (!found?.sub_url) {
    throw new GiteaError('NOT_FOUND', `Wiki page "${page}" does not exist.`, {
      hint: `Pages: ${pages.items.map((p) => p.title).join(', ') || '(none)'}`,
    });
  }
  return found.sub_url;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export const wikiTools: ToolDefinition[] = [
  defineTool({
    name: 'wiki_page_list',
    module: M,
    title: 'List wiki pages',
    description: 'Lists the wiki pages of a repository with their last change.',
    access: 'read',
    feature: 'wiki',
    input: { ...profileShape, ...repoShape },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client.paginate<RawPage>(
        `${repoPath(owner, repo)}/wiki/pages`,
        {},
        { limit: 1000 },
      );
      return { pages: res.items.map(slimMeta) };
    },
  }),
  defineTool({
    name: 'wiki_page_get',
    module: M,
    title: 'Read wiki page',
    description: 'Reads a wiki page (Markdown) by title or URL name, optionally with its revision history.',
    access: 'read',
    feature: 'wiki',
    input: {
      ...profileShape,
      ...repoShape,
      page: pageInput,
      include_history: z.boolean().default(false),
      max_chars: z.number().int().min(100).max(500_000).default(100_000),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/wiki`;
      const name = await resolvePage(ctx, base, args.page);
      const res = await ctx.client.request<RawPage>({ path: `${base}/page/${encodeURIComponent(name)}` });
      const t = truncateText(
        Buffer.from(res.data.content_base64 ?? '', 'base64').toString('utf8'),
        args.max_chars,
      );
      const out: Record<string, unknown> = {
        ...slimMeta(res.data),
        revisions: res.data.commit_count,
        truncated: t.truncated || undefined,
        content: t.text,
      };
      if (args.include_history) {
        const hist = await ctx.client.request<{
          commits?: { sha: string; message: string; author?: { name?: string; date?: string } }[];
        }>({
          path: `${base}/revisions/${encodeURIComponent(name)}`,
        });
        out.history = (hist.data.commits ?? []).map((c) =>
          compact({
            sha: c.sha.slice(0, 10),
            message: c.message.trim(),
            author: c.author?.name,
            date: c.author?.date,
          }),
        );
      }
      return out;
    },
  }),
  defineTool({
    name: 'wiki_page_create',
    module: M,
    title: 'Create wiki page',
    description:
      'Creates a wiki page with Markdown content. The repository wiki is enabled by creating its first page.',
    access: 'write',
    feature: 'wiki',
    input: {
      ...profileShape,
      ...repoShape,
      title: z.string().min(1).max(255),
      content: z
        .string()
        .max(5 * 1024 * 1024)
        .describe('Markdown'),
      message: z.string().max(1000).optional().describe('Commit message'),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const res = await ctx.client
        .request<RawPage>({
          method: 'POST',
          path: `${repoPath(owner, repo)}/wiki/new`,
          body: compact({ title: args.title, content_base64: b64(args.content), message: args.message }),
        })
        .catch(async (err: unknown) => {
          if (err instanceof GiteaError && err.code === 'NOT_FOUND') {
            const info = await ctx.client
              .request<{ has_wiki?: boolean }>({ path: repoPath(owner, repo) })
              .catch(() => undefined);
            if (info?.data.has_wiki === false) {
              throw new GiteaError('UNSUPPORTED', `The wiki of ${owner}/${repo} is disabled.`, {
                hint: 'Enable it with repo_update (has_wiki: true), then create the page again.',
              });
            }
          }
          throw err;
        });
      return { created: true, page: slimMeta(res.data) };
    },
  }),
  defineTool({
    name: 'wiki_page_update',
    module: M,
    title: 'Edit wiki page',
    description: 'Replaces the content of a wiki page and/or renames it (new_title).',
    access: 'write',
    feature: 'wiki',
    input: {
      ...profileShape,
      ...repoShape,
      page: pageInput,
      content: z
        .string()
        .max(5 * 1024 * 1024)
        .optional(),
      new_title: z.string().min(1).max(255).optional(),
      message: z.string().max(1000).optional(),
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      if (args.content === undefined && !args.new_title) {
        throw new GiteaError('INVALID_INPUT', 'Provide content and/or new_title.');
      }
      const base = `${repoPath(owner, repo)}/wiki`;
      const name = await resolvePage(ctx, base, args.page);
      let content = args.content;
      let title = args.new_title;
      if (content === undefined || !title) {
        const current = (
          await ctx.client.request<RawPage>({ path: `${base}/page/${encodeURIComponent(name)}` })
        ).data;
        content ??= Buffer.from(current.content_base64 ?? '', 'base64').toString('utf8');
        title ??= current.title;
      }
      const res = await ctx.client.request<RawPage>({
        method: 'PATCH',
        path: `${base}/page/${encodeURIComponent(name)}`,
        body: compact({ title, content_base64: b64(content), message: args.message }),
      });
      return { updated: true, page: slimMeta(res.data) };
    },
  }),
  defineTool({
    name: 'wiki_page_delete',
    module: M,
    title: 'Delete wiki page',
    description: 'Deletes a wiki page (its history stays in the wiki repository). Requires confirmation.',
    access: 'destructive',
    feature: 'wiki',
    input: { ...profileShape, ...repoShape, page: pageInput },
    async confirm(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      return {
        target: `${owner}/${repo}/wiki/${args.page}`,
        action: `Delete wiki page "${args.page}" of ${owner}/${repo}.`,
      };
    },
    async run(args, ctx) {
      const { owner, repo } = await ctx.repo(args);
      const base = `${repoPath(owner, repo)}/wiki`;
      const name = await resolvePage(ctx, base, args.page);
      await ctx.client.request({ method: 'DELETE', path: `${base}/page/${encodeURIComponent(name)}` });
      return { deleted: name };
    },
  }),
];
