import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { ACCESS_ENABLE_HINT, isAllowed, type Profile, type ServerConfig } from './config/config.js';
import { assertFeature, detectCapabilities, type Capabilities } from './gitea/capabilities.js';
import { GiteaError, toGiteaError } from './gitea/errors.js';
import { GiteaHttpClient, type HttpClientOptions } from './gitea/http.js';
import { localContext } from './git/local.js';
import { redact } from './security/redact.js';
import { enabledTools } from './tools/registry.js';
import type { ConfirmRequest, RepoRef, ToolContext, ToolDefinition } from './tools/types.js';
import { log } from './util/log.js';
import { serverVersion } from './util/version.js';

const MAX_RESULT_CHARS = 150_000;

export const SERVER_INSTRUCTIONS = `Tools for a Gitea server (repositories, files, branches, commits, issues, pull requests, organisations, teams, Gitea Actions, releases, webhooks, notifications).
- owner/repo default to the git remote of the current working directory that points to the configured Gitea server; pass them explicitly for other repositories.
- If a call fails with UNAUTHORIZED, NOT_CONFIGURED or TLS_ERROR, run connection_test and show the user its hint.
- Tools that delete data, merge, change visibility or change permissions require an informed confirmation. When a tool returns CONFIRMATION_REQUIRED, explain the consequence to the user and only call it again with the confirm value after the user explicitly agreed. Never supply confirm on your own initiative.
- Write, destructive and administrative tools may be disabled by the user's configuration; connection_test explains how to enable them.`;

export interface ServerDeps {
  /** Override HTTP options (tests inject a mock dispatcher). */
  http?: Partial<HttpClientOptions>;
  /** Working directory for local git operations. */
  cwd?: string;
}

function formatResult(value: unknown): string {
  const json = JSON.stringify(value, null, 1) as string | undefined;
  const text = redact(json ?? 'null');
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… [output truncated: ${text.length - MAX_RESULT_CHARS} more characters; narrow the request with limit/page/filters]`;
}

export function errorResult(err: unknown): CallToolResult {
  const e = toGiteaError(err);
  if (!(err instanceof GiteaError))
    log.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return {
    isError: true,
    content: [{ type: 'text', text: redact(JSON.stringify({ error: e.toJSON() }, null, 1)) }],
  };
}

export class GiteaMcpServer {
  readonly mcp: McpServer;
  readonly config: ServerConfig;
  readonly tools: ToolDefinition[];
  private readonly deps: ServerDeps;
  private readonly clients = new Map<string, GiteaHttpClient>();
  private readonly caps = new Map<string, Promise<Capabilities>>();
  private readonly remoteCache = new Map<string, Promise<RepoRef | undefined>>();
  readonly cwd: string;

  constructor(config: ServerConfig, deps: ServerDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.cwd = deps.cwd ?? process.cwd();
    this.mcp = new McpServer(
      { name: 'gitea', title: 'Gitea', version: serverVersion() },
      { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    this.tools = enabledTools(config.permissions);
    for (const tool of this.tools) this.register(tool);
  }

  private profile(name: string | undefined): Profile {
    const key = name ?? this.config.defaultProfile;
    const profile = key ? this.config.profiles.get(key) : undefined;
    if (profile) return profile;
    if (name) {
      throw new GiteaError('INVALID_INPUT', `Unknown profile "${name}".`, {
        hint: `Configured profiles: ${[...this.config.profiles.keys()].join(', ') || '(none)'}`,
      });
    }
    throw new GiteaError('NOT_CONFIGURED', 'No Gitea server is configured.', {
      hint: [
        'Run /plugin, select the "gitea" plugin and choose Configure to set the Gitea URL and an API token,',
        'or run `claude plugin configure gitea` in a terminal.',
        ...this.config.warnings,
      ].join(' '),
    });
  }

  client(profile: Profile): GiteaHttpClient {
    let c = this.clients.get(profile.name);
    if (!c) {
      c = new GiteaHttpClient(profile, {
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        caFile: this.config.caFile,
        useSystemCa: this.config.useSystemCa,
        userAgent: `claude-code-gitea/${serverVersion()}`,
        ...this.deps.http,
      });
      this.clients.set(profile.name, c);
    }
    return c;
  }

  private capabilities(profile: Profile): Promise<Capabilities> {
    let p = this.caps.get(profile.name);
    if (!p) {
      p = detectCapabilities(this.client(profile));
      p.catch(() => this.caps.delete(profile.name)); // do not cache failures
      this.caps.set(profile.name, p);
    }
    return p;
  }

  private async repoFromCwd(profile: Profile): Promise<RepoRef | undefined> {
    const key = `${profile.name}|${this.cwd}`;
    let p = this.remoteCache.get(key);
    if (!p) {
      p = localContext(this.cwd, profile.baseUrl)
        .then((lc) => {
          const match =
            lc.remotes.find((r) => r.name === 'origin' && r.giteaRepo) ?? lc.remotes.find((r) => r.giteaRepo);
          return match?.giteaRepo;
        })
        .catch(() => undefined);
      this.remoteCache.set(key, p);
    }
    return p;
  }

  context(profileName: string | undefined, local: boolean): ToolContext {
    let resolved: Profile | undefined;
    let resolveError: unknown;
    try {
      resolved = this.profile(profileName);
    } catch (err) {
      if (!local) throw err;
      resolveError = err;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      config: this.config,
      cwd: this.cwd,
      get profile(): Profile {
        if (!resolved)
          throw resolveError instanceof Error
            ? resolveError
            : new GiteaError('NOT_CONFIGURED', 'No Gitea server is configured.');
        return resolved;
      },
      maybeProfile: resolved,
      get client(): GiteaHttpClient {
        return self.client(this.profile);
      },
      capabilities: () => this.capabilities(this.profileOrThrow(resolved, resolveError)),
      repo: async (args) => {
        if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
        if (args.owner || args.repo) {
          throw new GiteaError(
            'INVALID_INPUT',
            'Provide both owner and repo, or neither to use the git remote of the working directory.',
          );
        }
        const profile = this.profileOrThrow(resolved, resolveError);
        const detected = await this.repoFromCwd(profile);
        if (!detected) {
          throw new GiteaError('INVALID_INPUT', 'owner and repo are required.', {
            hint: `No git remote in ${this.cwd} points to ${profile.baseUrl.host}. Pass owner and repo explicitly.`,
          });
        }
        return detected;
      },
      notify: async (message) => {
        await this.mcp.sendLoggingMessage({ level: 'info', data: message }).catch(() => undefined);
      },
    };
  }

  private profileOrThrow(p: Profile | undefined, err: unknown): Profile {
    if (p) return p;
    throw err instanceof Error ? err : new GiteaError('NOT_CONFIGURED', 'No Gitea server is configured.');
  }

  /**
   * Obtains an informed confirmation. Prefers MCP elicitation, where the user answers directly
   * in the client UI. Without elicitation the caller must echo the exact target, which the model
   * may only do after asking the user.
   */
  async confirm(req: ConfirmRequest, provided: string | undefined): Promise<void> {
    const clientCaps = this.mcp.server.getClientCapabilities();
    if (clientCaps?.elicitation) {
      let result;
      try {
        result = await this.mcp.server.elicitInput({
          mode: 'form',
          message: `Confirmation required\n\n${req.action}\n\nTarget: ${req.target}`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', title: 'Proceed?', description: `Confirm: ${req.target}` },
            },
            required: ['confirm'],
          },
        });
      } catch (err) {
        log.debug(`elicitation failed, falling back to confirm token: ${String(err)}`);
      }
      if (result) {
        if (result.action === 'accept' && result.content?.confirm === true) return;
        throw new GiteaError('CANCELLED', `The user did not confirm: ${req.action}`, {
          hint: 'The operation was not performed. Do not retry unless the user asks for it again.',
        });
      }
    }
    if (provided !== undefined && provided === req.target) return;
    throw new GiteaError('CONFIRMATION_REQUIRED', `Confirmation required: ${req.action}`, {
      details: { confirm: req.target },
      hint: `Nothing was changed. Explain this consequence to the user and ask for explicit confirmation. Only if the user explicitly agrees, call the tool again with confirm: "${req.target}".${provided !== undefined ? ' The supplied confirm value did not match.' : ''}`,
    });
  }

  private register(tool: ToolDefinition): void {
    const shape: Record<string, z.core.$ZodType> = { ...tool.input };
    if (tool.confirm) {
      shape.confirm = z
        .string()
        .max(500)
        .optional()
        .describe(
          'Confirmation token. Only set after the user explicitly confirmed; see CONFIRMATION_REQUIRED.',
        );
    }
    const destructive = tool.access === 'destructive' || tool.access === 'admin' || Boolean(tool.confirm);
    this.mcp.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description}${tool.access === 'read' ? '' : ` [${tool.access}${tool.confirm ? ', requires confirmation' : ''}]`}`,
        inputSchema: shape,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === 'read',
          destructiveHint: tool.access === 'read' ? undefined : destructive,
          idempotentHint: tool.access === 'read' ? true : tool.idempotent,
          openWorldHint: !tool.local,
        },
      },
      async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const args = rawArgs as Record<string, unknown> & { profile?: string; confirm?: string };
          const ctx = this.context(args.profile, Boolean(tool.local));
          if (tool.access !== 'read' && !isAllowed(tool.access, this.config.permissions, ctx.maybeProfile)) {
            throw new GiteaError(
              'PERMISSION_DENIED',
              `"${tool.name}" is a ${tool.access} operation and is disabled.`,
              {
                hint: ctx.maybeProfile?.readOnly
                  ? `Profile "${ctx.maybeProfile.name}" is configured as read-only.`
                  : ACCESS_ENABLE_HINT[tool.access],
              },
            );
          }
          if (tool.feature) assertFeature(await ctx.capabilities(), tool.feature);
          if (tool.confirm) await this.confirm(await tool.confirm(args, ctx), args.confirm);
          const result = await tool.run(args, ctx);
          return { content: [{ type: 'text', text: formatResult(result) }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
}
