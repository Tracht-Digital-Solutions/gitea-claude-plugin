import type * as z from 'zod/v4';
import type { AccessLevel, Profile, ServerConfig } from '../config/config.js';
import type { Capabilities, Feature } from '../gitea/capabilities.js';
import type { GiteaHttpClient } from '../gitea/http.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ConfirmRequest {
  /** Exact string the user must confirm, e.g. `owner/repo` or `owner/repo#12`. */
  target: string;
  /** Human readable description of the consequence. */
  action: string;
}

export interface ToolContext {
  config: ServerConfig;
  /** The selected profile; throws NOT_CONFIGURED when no Gitea server is configured. */
  readonly profile: Profile;
  /** The selected profile, or undefined (for tools that also work without a server). */
  readonly maybeProfile: Profile | undefined;
  readonly client: GiteaHttpClient;
  /** Resolves owner/repo from the arguments, or from the git remote of the working directory. */
  repo(args: { owner?: string | undefined; repo?: string | undefined }): Promise<RepoRef>;
  capabilities(): Promise<Capabilities>;
  /** Working directory used for local git operations. */
  cwd: string;
  /** Sends an MCP progress/log message if the client supports it. */
  notify(message: string): Promise<void>;
}

export type Shape = z.ZodRawShape;
export type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

export interface ToolDefinition<S extends Shape = Shape> {
  name: string;
  title: string;
  description: string;
  access: AccessLevel;
  /** Logical module, used for documentation and grouping. */
  module: string;
  input: S;
  /** Feature that must be supported by the server version; checked before the call. */
  feature?: Feature;
  /** When set, the call needs an informed confirmation from the user. */
  confirm?: (args: Args<S>, ctx: ToolContext) => ConfirmRequest | Promise<ConfirmRequest>;
  /** Whether the call is idempotent (for MCP annotations). */
  idempotent?: boolean;
  /** Does not need a configured Gitea connection (e.g. local git inspection). */
  local?: boolean;
  run(args: Args<S>, ctx: ToolContext): Promise<unknown>;
}

/** Identity helper that keeps the argument type of each tool definition. */
export function defineTool<S extends Shape>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}
