import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { ACCESS_ENABLE_HINT, isAllowed, type ServerConfig } from './config/config.js';
import { assertFeature } from './gitea/capabilities.js';
import { GiteaError } from './gitea/errors.js';
import type { HttpClientOptions } from './gitea/http.js';
import { confirmWithUser } from './runtime/confirmation.js';
import { RequestContext } from './runtime/context.js';
import { errorResult, successResult } from './runtime/results.js';
import { Runtime } from './runtime/runtime.js';
import { enabledTools } from './tools/registry.js';
import type { ToolDefinition } from './tools/types.js';
import { serverVersion } from './util/version.js';

export { errorResult } from './runtime/results.js';

/** Instructions sent to the client during initialisation; they guide how the model uses the tools. */
export const SERVER_INSTRUCTIONS = `Tools for a Gitea server (repositories, files, branches, commits, issues, project boards, time tracking, pull requests, organisations, teams, Gitea Actions, releases, packages, wiki, webhooks, notifications).
- owner/repo default to the git remote of the current working directory that points to the configured Gitea server; pass them explicitly for other repositories.
- If a call fails with UNAUTHORIZED, NOT_CONFIGURED or TLS_ERROR, run connection_test and show the user its hint.
- Tools that delete data, merge, change visibility or change permissions require an informed confirmation. When a tool returns CONFIRMATION_REQUIRED, explain the consequence to the user and only call it again with the confirm value after the user explicitly agreed. Never supply confirm on your own initiative.
- Write, destructive and administrative tools may be disabled by the user's configuration; connection_test explains how to enable them.`;

const confirmSchema = z
  .string()
  .max(500)
  .optional()
  .describe('Confirmation token. Only set after the user explicitly confirmed; see CONFIRMATION_REQUIRED.');

export interface ServerDeps {
  /** Override HTTP options (tests inject a mock dispatcher). */
  http?: Partial<HttpClientOptions>;
  /** Working directory for local git operations and file access. */
  cwd?: string;
}

/**
 * The MCP server: registers every enabled tool and runs each call through the same pipeline —
 * profile resolution → permission gate → feature gate → confirmation → tool → redacted result.
 */
export class GiteaMcpServer {
  readonly mcp: McpServer;
  readonly config: ServerConfig;
  readonly tools: ToolDefinition[];
  readonly cwd: string;
  private readonly runtime: Runtime;

  constructor(config: ServerConfig, deps: ServerDeps = {}) {
    this.config = config;
    this.cwd = deps.cwd ?? process.cwd();
    this.runtime = new Runtime(config, this.cwd, deps.http);
    this.mcp = new McpServer(
      { name: 'gitea', title: 'Gitea', version: serverVersion() },
      { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    this.tools = enabledTools(config.permissions);
    for (const tool of this.tools) this.register(tool);
  }

  private register(tool: ToolDefinition): void {
    const inputSchema: Record<string, z.core.$ZodType> = { ...tool.input };
    if (tool.confirm) inputSchema.confirm = confirmSchema;
    const level =
      tool.access === 'read' ? '' : ` [${tool.access}${tool.confirm ? ', requires confirmation' : ''}]`;
    this.mcp.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description}${level}`,
        inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === 'read',
          destructiveHint:
            tool.access === 'read'
              ? undefined
              : tool.access === 'destructive' || tool.access === 'admin' || Boolean(tool.confirm),
          idempotentHint: tool.access === 'read' ? true : tool.idempotent,
          openWorldHint: !tool.local,
        },
      },
      (args: Record<string, unknown>) => this.call(tool, args),
    );
  }

  private async call(tool: ToolDefinition, rawArgs: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const args = rawArgs as Record<string, unknown> & { profile?: string; confirm?: string };
      const ctx = new RequestContext(this.runtime, args.profile, Boolean(tool.local), (message) =>
        this.mcp.sendLoggingMessage({ level: 'info', data: message }).catch(() => undefined),
      );
      this.assertAllowed(tool, ctx);
      if (tool.feature) assertFeature(await ctx.capabilities(), tool.feature);
      if (tool.confirm) await confirmWithUser(this.mcp.server, await tool.confirm(args, ctx), args.confirm);
      return successResult(await tool.run(args, ctx));
    } catch (err) {
      return errorResult(err);
    }
  }

  /** Disabled levels are not registered at all; this also covers read-only profiles. */
  private assertAllowed(tool: ToolDefinition, ctx: RequestContext): void {
    if (tool.access === 'read' || isAllowed(tool.access, this.config.permissions, ctx.maybeProfile)) return;
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
}
