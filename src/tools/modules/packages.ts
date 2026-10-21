import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import * as z from 'zod/v4';
import { GiteaError } from '../../gitea/errors.js';
import { compact } from '../../gitea/models.js';
import { nameSchema, ownerSchema, pagingShape, profileShape } from '../common.js';
import { defineTool, type ToolDefinition } from '../types.js';

const M = 'packages';

const PACKAGE_TYPES = [
  'alpine',
  'cargo',
  'chef',
  'composer',
  'conan',
  'conda',
  'container',
  'cran',
  'debian',
  'generic',
  'go',
  'helm',
  'maven',
  'npm',
  'nuget',
  'pub',
  'pypi',
  'rpm',
  'rubygems',
  'swift',
  'terraform',
  'vagrant',
] as const;

interface RawPackage {
  id: number;
  name: string;
  type: string;
  version: string;
  html_url?: string;
  created_at?: string;
  creator?: { login?: string } | null;
  repository?: { full_name?: string } | null;
}

const slimPackage = (p: RawPackage) =>
  compact({
    id: p.id,
    type: p.type,
    name: p.name,
    version: p.version,
    repository: p.repository?.full_name,
    creator: p.creator?.login,
    created_at: p.created_at,
    html_url: p.html_url,
  });

const typeSchema = z.enum(PACKAGE_TYPES);
const pkgName = z.string().min(1).max(255).describe('Package name');
const owner = ownerSchema.describe('User or organisation that owns the package');
const seg = encodeURIComponent;

/** Generic package names, versions and file names (see the Gitea generic registry docs). */
const GENERIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const packageTools: ToolDefinition[] = [
  defineTool({
    name: 'package_list',
    module: M,
    title: 'List packages',
    description:
      'Lists the packages (all registries: npm, container, maven, generic, …) of a user or organisation.',
    access: 'read',
    feature: 'packages',
    input: {
      ...profileShape,
      owner,
      type: typeSchema.optional(),
      query: z.string().max(200).optional().describe('Filter by package name'),
      ...pagingShape,
    },
    async run(args, ctx) {
      const res = await ctx.client.paginate<RawPackage>(
        `/packages/${seg(args.owner)}`,
        { type: args.type, q: args.query },
        args,
      );
      return { has_more: res.hasMore, packages: res.items.map(slimPackage) };
    },
  }),
  defineTool({
    name: 'package_get',
    module: M,
    title: 'Get package',
    description:
      'Shows a package: without `version` all its versions; with `version` (or "latest") that version and its files with sizes and SHA-256 checksums.',
    access: 'read',
    feature: 'packages',
    input: {
      ...profileShape,
      owner,
      type: typeSchema,
      name: pkgName,
      version: z.string().max(255).optional(),
    },
    async run(args, ctx) {
      const base = `/packages/${seg(args.owner)}/${args.type}/${seg(args.name)}`;
      if (!args.version) {
        const res = await ctx.client.paginate<RawPackage>(base, {}, { limit: 200 });
        return { name: args.name, type: args.type, versions: res.items.map(slimPackage) };
      }
      const pkg = (
        await ctx.client.request<RawPackage>({
          path: args.version === 'latest' ? `${base}/-/latest` : `${base}/${seg(args.version)}`,
        })
      ).data;
      const files = await ctx.client.request<{ name: string; size: number; sha256: string }[]>({
        path: `${base}/${seg(pkg.version)}/files`,
      });
      return {
        ...slimPackage(pkg),
        files: files.data.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
      };
    },
  }),
  defineTool({
    name: 'package_upload_generic',
    module: M,
    title: 'Upload generic package',
    description:
      'Publishes a local file (inside the working directory) as a file of a generic package version in the Gitea package registry. Needs the token scope write:package.',
    access: 'write',
    feature: 'packages',
    input: {
      ...profileShape,
      owner,
      name: z.string().regex(GENERIC_NAME, 'letters, digits, ".", "_", "+", "-"').max(255),
      version: z.string().regex(GENERIC_NAME, 'letters, digits, ".", "_", "+", "-"').max(255),
      file: z.string().min(1).max(4096).describe('Local file, relative to the working directory'),
      file_name: z
        .string()
        .regex(GENERIC_NAME, 'letters, digits, ".", "_", "+", "-"')
        .max(255)
        .optional()
        .describe('File name in the package (default: local file name)'),
    },
    async run(args, ctx) {
      const full = isAbsolute(args.file) ? resolve(args.file) : resolve(ctx.cwd, args.file);
      const rel = relative(resolve(ctx.cwd), full);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new GiteaError(
          'INVALID_INPUT',
          `Only files inside the working directory (${ctx.cwd}) can be uploaded.`,
        );
      }
      const st = await stat(full).catch(() => undefined);
      if (!st?.isFile()) throw new GiteaError('INVALID_INPUT', `${args.file} is not a file.`);
      if (st.size > 500 * 1024 * 1024) throw new GiteaError('INVALID_INPUT', 'File is larger than 500 MB.');
      const fileName = args.file_name ?? basename(full);
      if (!GENERIC_NAME.test(fileName)) {
        throw new GiteaError(
          'INVALID_INPUT',
          `File name "${fileName}" is not allowed in generic packages; set file_name.`,
        );
      }
      // Package registry endpoint (outside /api/v1), documented at
      // https://docs.gitea.com/usage/packages/generic
      await ctx.client.request({
        method: 'PUT',
        root: true,
        path: `api/packages/${seg(args.owner)}/generic/${seg(args.name)}/${seg(args.version)}/${seg(fileName)}`,
        raw: await readFile(full),
        responseType: 'text',
      });
      return {
        uploaded: true,
        owner: args.owner,
        name: args.name,
        version: args.version,
        file: fileName,
        bytes: st.size,
      };
    },
  }),
  defineTool({
    name: 'package_link',
    module: M,
    title: 'Link or unlink package and repository',
    description:
      'Links a package to a repository of the same owner (shown on the repository page), or removes the link.',
    access: 'write',
    feature: 'packages',
    input: {
      ...profileShape,
      owner,
      type: typeSchema,
      name: pkgName,
      repo: nameSchema('Repository').optional().describe('Repository to link (omit with action "unlink")'),
      action: z.enum(['link', 'unlink']).default('link'),
    },
    async run(args, ctx) {
      const base = `/packages/${seg(args.owner)}/${args.type}/${seg(args.name)}/-`;
      if (args.action === 'link') {
        if (!args.repo) throw new GiteaError('INVALID_INPUT', 'repo is required to link a package.');
        await ctx.client.request({ method: 'POST', path: `${base}/link/${seg(args.repo)}` });
      } else {
        await ctx.client.request({ method: 'POST', path: `${base}/unlink` });
      }
      return { package: `${args.type}/${args.name}`, action: args.action, repository: args.repo };
    },
  }),
  defineTool({
    name: 'package_delete',
    module: M,
    title: 'Delete package',
    description:
      'Deletes one package version, or (without `version`) the whole package with all versions. Requires confirmation.',
    access: 'destructive',
    feature: 'packages',
    input: {
      ...profileShape,
      owner,
      type: typeSchema,
      name: pkgName,
      version: z.string().max(255).optional(),
    },
    confirm(args) {
      return {
        target: `${args.owner}/${args.type}/${args.name}${args.version ? `@${args.version}` : ''}`,
        action: args.version
          ? `Delete version ${args.version} of package ${args.type}/${args.name} (${args.owner}).`
          : `Delete package ${args.type}/${args.name} of ${args.owner} with ALL versions.`,
      };
    },
    async run(args, ctx) {
      const base = `/packages/${seg(args.owner)}/${args.type}/${seg(args.name)}`;
      await ctx.client.request({
        method: 'DELETE',
        path: args.version ? `${base}/${seg(args.version)}` : base,
      });
      return { deleted: `${args.type}/${args.name}${args.version ? `@${args.version}` : ''}` };
    },
  }),
];
