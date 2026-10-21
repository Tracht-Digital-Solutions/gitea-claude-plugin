import * as z from 'zod/v4';
import { GiteaError } from '../gitea/errors.js';

/** Gitea user, organisation and repository names. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export const ownerSchema = z
  .string()
  .regex(NAME, 'owner may contain letters, digits, "_", "-" and "."')
  .describe('Owner (user or organisation). Defaults to the git remote of the current working directory.');
export const repoSchema = z
  .string()
  .regex(NAME, 'repo may contain letters, digits, "_", "-" and "."')
  .describe('Repository name. Defaults to the git remote of the current working directory.');

export const repoShape = {
  owner: ownerSchema.optional(),
  repo: repoSchema.optional(),
};

export const profileShape = {
  profile: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .optional()
    .describe('Configured Gitea profile to use. Omit for the default profile.'),
};

export const limitSchema = (def = 30, max = 200) =>
  z.number().int().min(1).max(max).default(def).describe(`Maximum number of items to return (1-${max}).`);

export const pageSchema = z.number().int().min(1).default(1).describe('Page to start from (1-based).');

export const pagingShape = {
  limit: limitSchema(),
  page: pageSchema,
};

export const nameSchema = (what: string) =>
  z.string().regex(NAME, `${what} may contain letters, digits, "_", "-" and "."`).describe(`${what} name`);

export const indexSchema = (what = 'issue') => z.number().int().min(1).describe(`${what} number`);

export const refSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !v.startsWith('-') && !v.includes('..') && !/[\s~^:?*[\\]/.test(v), 'invalid git ref')
  .describe('Branch, tag or commit SHA');

export const shaSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{7,64}$/, 'must be a hex commit SHA')
  .describe('Commit SHA');

export const dateSchema = z.iso
  .datetime({ offset: true })
  .describe('ISO-8601 date-time, e.g. 2025-01-31T00:00:00Z');

export const stateSchema = z.enum(['open', 'closed', 'all']).default('open');

export const colorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex value like #ee0701')
  .transform((c) => (c.startsWith('#') ? c : `#${c}`));

export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Ensures that at least one updatable field was supplied. */
export function requireSomeFields(body: Record<string, unknown>, what: string): void {
  if (Object.values(body).every((v) => v === undefined)) {
    throw new GiteaError('INVALID_INPUT', `Provide at least one field to update for ${what}.`);
  }
}

/** Removes undefined values before sending a request body. */
export function body<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} characters]`,
    truncated: true,
  };
}

/** Result of GiteaHttpClient.paginate. */
export interface Page<T> {
  items: T[];
  totalCount: number | undefined;
  hasMore: boolean;
}

/**
 * Uniform shape of list results: `{ total, has_more, <key>: [...] }`. `total` is omitted when
 * Gitea does not report it.
 */
export function listResult<T, K extends string>(
  page: Page<T>,
  key: K,
  map: (item: T) => unknown,
): { total?: number; has_more: boolean } & Record<K, unknown[]> {
  const out: Record<string, unknown> = {};
  if (page.totalCount !== undefined) out.total = page.totalCount;
  out.has_more = page.hasMore;
  out[key] = page.items.map(map);
  return out as { total?: number; has_more: boolean } & Record<K, unknown[]>;
}
