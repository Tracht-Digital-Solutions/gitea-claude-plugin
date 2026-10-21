import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import * as z from 'zod/v4';
import { GiteaError } from '../gitea/errors.js';
import { registerSecret } from '../security/redact.js';
import { normalizeBaseUrl } from '../security/url.js';

export type AccessLevel = 'read' | 'write' | 'destructive' | 'admin';

export interface Permissions {
  write: boolean;
  destructive: boolean;
  admin: boolean;
}

export interface Profile {
  name: string;
  baseUrl: URL;
  /** Never logged; registered with the redactor on load. */
  token: string | undefined;
  caFile: string | undefined;
  allowHttp: boolean;
  readOnly: boolean;
  source: 'plugin-config' | 'environment' | 'profiles-file';
}

export interface ServerConfig {
  profiles: Map<string, Profile>;
  defaultProfile: string | undefined;
  permissions: Permissions;
  timeoutMs: number;
  maxRetries: number;
  caFile: string | undefined;
  useSystemCa: boolean;
  /** Problems found while loading, reported by the connection tools instead of crashing. */
  warnings: string[];
}

const ProfileFileSchema = z.object({
  default: z.string().min(1).optional(),
  profiles: z.record(
    z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'profile names may contain letters, digits, ".", "_" and "-"'),
    z
      .object({
        url: z.string().min(1),
        tokenEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .optional(),
        tokenFile: z.string().min(1).optional(),
        caFile: z.string().min(1).optional(),
        allowHttp: z.boolean().optional(),
        readOnly: z.boolean().optional(),
      })
      .strict(),
  ),
});

export type ProfilesFile = z.infer<typeof ProfileFileSchema>;

type Env = Record<string, string | undefined>;

/**
 * Claude Code substitutes `${user_config.KEY}` in the MCP server env. An option the user never
 * set may arrive empty or as the literal placeholder; both mean "unset".
 */
export function envValue(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!v || /^\$\{[^}]*\}$/.test(v)) return undefined;
  return v;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseIntInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}

function readTokenFile(path: string): string {
  const full = expandHome(path);
  if (!isAbsolute(full)) {
    throw new GiteaError('INVALID_CONFIG', `tokenFile must be an absolute path (or start with ~): ${path}`);
  }
  try {
    return readFileSync(full, 'utf8').trim();
  } catch (err) {
    throw new GiteaError('INVALID_CONFIG', `Cannot read tokenFile ${path}: ${(err as Error).message}`);
  }
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const warnings: string[] = [];
  const profiles = new Map<string, Profile>();
  const globalAllowHttp = parseBool(envValue(env, 'GITEA_ALLOW_HTTP'), false);

  const url = envValue(env, 'GITEA_URL');
  const token = envValue(env, 'GITEA_TOKEN');
  registerSecret(token);
  const primaryName = envValue(env, 'GITEA_PROFILE_NAME') ?? 'default';
  if (url) {
    try {
      profiles.set(primaryName, {
        name: primaryName,
        baseUrl: normalizeBaseUrl(url, { allowHttp: globalAllowHttp }),
        token,
        caFile: undefined,
        allowHttp: globalAllowHttp,
        readOnly: false,
        source: env.CLAUDE_PLUGIN_ROOT ? 'plugin-config' : 'environment',
      });
    } catch (err) {
      warnings.push(`Profile "${primaryName}": ${(err as Error).message}`);
    }
  } else if (token) {
    warnings.push('An API token is configured but no Gitea URL. Set the Gitea server URL.');
  }

  let fileDefault: string | undefined;
  const profilesFile = envValue(env, 'GITEA_PROFILES_FILE');
  if (profilesFile) {
    try {
      const parsed = parseProfilesFile(readFileSync(expandHome(profilesFile), 'utf8'));
      fileDefault = parsed.default;
      for (const [name, p] of Object.entries(parsed.profiles)) {
        if (profiles.has(name)) {
          warnings.push(`Profile "${name}" from ${profilesFile} is shadowed by the plugin configuration.`);
          continue;
        }
        try {
          let profileToken: string | undefined;
          if (p.tokenEnv) profileToken = envValue(env, p.tokenEnv);
          else if (p.tokenFile) profileToken = readTokenFile(p.tokenFile);
          registerSecret(profileToken);
          const allowHttp = p.allowHttp ?? globalAllowHttp;
          profiles.set(name, {
            name,
            baseUrl: normalizeBaseUrl(p.url, { allowHttp }),
            token: profileToken,
            caFile: p.caFile ? expandHome(p.caFile) : undefined,
            allowHttp,
            readOnly: p.readOnly ?? false,
            source: 'profiles-file',
          });
          if (!profileToken) {
            warnings.push(`Profile "${name}" has no token (tokenEnv/tokenFile unset or empty).`);
          }
        } catch (err) {
          warnings.push(`Profile "${name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      warnings.push(`Cannot load profiles file ${profilesFile}: ${(err as Error).message}`);
    }
  }

  const requestedDefault = envValue(env, 'GITEA_DEFAULT_PROFILE') ?? fileDefault;
  let defaultProfile: string | undefined;
  if (requestedDefault && profiles.has(requestedDefault)) defaultProfile = requestedDefault;
  else {
    if (requestedDefault) warnings.push(`Default profile "${requestedDefault}" does not exist.`);
    defaultProfile = profiles.has(primaryName) ? primaryName : profiles.keys().next().value;
  }

  const caFile = envValue(env, 'GITEA_CA_FILE');
  return {
    profiles,
    defaultProfile,
    permissions: {
      write: parseBool(envValue(env, 'GITEA_ALLOW_WRITE'), true),
      destructive: parseBool(envValue(env, 'GITEA_ALLOW_DESTRUCTIVE'), false),
      admin: parseBool(envValue(env, 'GITEA_ALLOW_ADMIN'), false),
    },
    timeoutMs: parseIntInRange(envValue(env, 'GITEA_TIMEOUT_MS'), 30_000, 1_000, 300_000),
    maxRetries: parseIntInRange(envValue(env, 'GITEA_MAX_RETRIES'), 3, 0, 10),
    caFile: caFile ? expandHome(caFile) : undefined,
    useSystemCa: parseBool(envValue(env, 'GITEA_USE_SYSTEM_CA'), false),
    warnings,
  };
}

export function parseProfilesFile(text: string): ProfilesFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GiteaError('INVALID_CONFIG', `Profiles file is not valid JSON: ${(err as Error).message}`);
  }
  if (json && typeof json === 'object' && JSON.stringify(json).includes('"token"')) {
    throw new GiteaError(
      'INVALID_CONFIG',
      'Profiles file must not contain plain "token" fields. Use "tokenEnv" or "tokenFile" instead.',
    );
  }
  const result = ProfileFileSchema.safeParse(json);
  if (!result.success) {
    throw new GiteaError('INVALID_CONFIG', `Invalid profiles file: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Whether a tool of the given access level may run under the configured permissions. */
export function isAllowed(level: AccessLevel, permissions: Permissions, profile?: Profile): boolean {
  if (level === 'read') return true;
  if (profile?.readOnly) return false;
  if (level === 'write') return permissions.write;
  if (level === 'destructive') return permissions.write && permissions.destructive;
  return permissions.write && permissions.admin;
}

export const ACCESS_ENABLE_HINT: Record<Exclude<AccessLevel, 'read'>, string> = {
  write: 'Enable "Allow write operations" in the gitea plugin options (/plugin → gitea → Configure).',
  destructive:
    'Enable "Allow destructive operations" in the gitea plugin options (/plugin → gitea → Configure). Write operations must be enabled too.',
  admin:
    'Enable "Allow administrative operations" in the gitea plugin options (/plugin → gitea → Configure). Write operations must be enabled too.',
};
