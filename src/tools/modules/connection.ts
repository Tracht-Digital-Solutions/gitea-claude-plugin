import { ACCESS_ENABLE_HINT } from '../../config/config.js';
import { GiteaError } from '../../gitea/errors.js';
import { slimUser } from '../../gitea/models.js';
import { profileShape } from '../common.js';
import { defineTool, type ToolDefinition } from '../types.js';

/** Read-only probes, one per token scope family. None of them has side effects. */
const SCOPE_PROBES: { scope: string; path: string; paged: boolean }[] = [
  { scope: 'read:user', path: '/user', paged: false },
  { scope: 'read:repository', path: '/user/repos', paged: true },
  { scope: 'read:issue', path: '/repos/issues/search', paged: true },
  { scope: 'read:organization', path: '/user/orgs', paged: true },
  { scope: 'read:notification', path: '/notifications', paged: true },
];

export const connectionTools: ToolDefinition[] = [
  defineTool({
    name: 'connection_test',
    module: 'connection',
    title: 'Test Gitea connection',
    description:
      'Checks the connection to the configured Gitea server: reachability, TLS, token validity, the authenticated user, the Gitea version, which optional API features the server supports and which read scopes the token grants. Use this first when setting up or when other tools fail with authentication errors.',
    access: 'read',
    input: { ...profileShape },
    async run(_args, ctx) {
      let user: Record<string, unknown> | undefined;
      let authError: Record<string, unknown> | undefined;
      try {
        user = slimUser((await ctx.client.request({ path: '/user', retry: true })).data);
      } catch (err) {
        // Network and TLS problems are reported as the tool error (with their hint); an
        // authentication problem is a diagnosis result.
        if (!(err instanceof GiteaError) || !['UNAUTHORIZED', 'FORBIDDEN'].includes(err.code)) throw err;
        authError = err.toJSON();
      }
      // Gitea rejects every request carrying an invalid token, including /version.
      const caps = user ? await ctx.capabilities() : undefined;
      const scopes: Record<string, string> = {};
      if (user) {
        for (const probe of SCOPE_PROBES) {
          try {
            await ctx.client.request({ path: probe.path, query: probe.paged ? { limit: 1 } : {} });
            scopes[probe.scope] = 'granted';
          } catch (err) {
            if (err instanceof GiteaError && err.code === 'FORBIDDEN') scopes[probe.scope] = 'missing';
            else if (err instanceof GiteaError) scopes[probe.scope] = `error: ${err.code}`;
            else throw err;
          }
        }
      }
      const { permissions } = ctx.config;
      return {
        ok: Boolean(user),
        profile: ctx.profile.name,
        server: ctx.profile.baseUrl.href,
        gitea_version: caps?.version,
        forgejo: caps?.forgejo || undefined,
        authenticated_as: user,
        authentication_error: authError,
        token_configured: Boolean(ctx.profile.token),
        read_scopes: user ? scopes : undefined,
        write_scopes_note:
          'Write scopes cannot be verified without side effects; a missing write scope is reported when a write tool runs.',
        feature_detection: caps?.detection,
        features: caps?.features,
        enabled_operations: {
          read: true,
          write: permissions.write && !ctx.profile.readOnly,
          destructive: permissions.write && permissions.destructive && !ctx.profile.readOnly,
          admin: permissions.write && permissions.admin && !ctx.profile.readOnly,
        },
        how_to_enable: {
          write: permissions.write ? undefined : ACCESS_ENABLE_HINT.write,
          destructive: permissions.destructive ? undefined : ACCESS_ENABLE_HINT.destructive,
          admin: permissions.admin ? undefined : ACCESS_ENABLE_HINT.admin,
        },
        config_warnings: ctx.config.warnings.length ? ctx.config.warnings : undefined,
      };
    },
  }),
  defineTool({
    name: 'profiles_list',
    module: 'connection',
    title: 'List Gitea profiles',
    description:
      'Lists the configured Gitea profiles (server URLs, whether a token is set, read-only flag) and the enabled operation levels. Tokens are never shown.',
    access: 'read',
    local: true,
    input: {},
    run(_args, ctx) {
      const { config } = ctx;
      return Promise.resolve({
        default_profile: config.defaultProfile,
        profiles: [...config.profiles.values()].map((p) => ({
          name: p.name,
          url: p.baseUrl.href,
          token_configured: Boolean(p.token),
          read_only: p.readOnly || undefined,
          custom_ca: Boolean(p.caFile ?? config.caFile) || undefined,
          source: p.source,
        })),
        permissions: config.permissions,
        warnings: config.warnings.length ? config.warnings : undefined,
        setup_hint:
          config.profiles.size === 0
            ? 'No Gitea server configured. Run /plugin, select the gitea plugin and choose Configure to set the server URL and API token.'
            : undefined,
      });
    },
  }),
];
