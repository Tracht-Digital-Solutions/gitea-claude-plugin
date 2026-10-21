import type { Profile, ServerConfig } from '../config/config.js';
import { detectCapabilities, type Capabilities } from '../gitea/capabilities.js';
import { GiteaError } from '../gitea/errors.js';
import { GiteaHttpClient, type HttpClientOptions } from '../gitea/http.js';
import { localContext } from '../git/local.js';
import { serverVersion } from '../util/version.js';

/**
 * Long-lived server state shared by all tool calls: profile resolution, one HTTP client and one
 * capability detection per profile, and the repository detected from the working directory.
 */
export class Runtime {
  private readonly clients = new Map<string, GiteaHttpClient>();
  private readonly caps = new Map<string, Promise<Capabilities>>();
  private readonly remotes = new Map<string, Promise<{ owner: string; repo: string } | undefined>>();

  constructor(
    readonly config: ServerConfig,
    readonly cwd: string,
    private readonly httpOverrides: Partial<HttpClientOptions> = {},
  ) {}

  /** The named profile, or the default one; throws INVALID_INPUT / NOT_CONFIGURED. */
  profile(name: string | undefined): Profile {
    const key = name ?? this.config.defaultProfile;
    const profile = key ? this.config.profiles.get(key) : undefined;
    if (profile) return profile;
    if (name) {
      throw new GiteaError('INVALID_INPUT', `Unknown profile "${name}".`, {
        hint: `Configured profiles: ${[...this.config.profiles.keys()].join(', ') || '(none)'}`,
      });
    }
    throw notConfigured(this.config.warnings);
  }

  client(profile: Profile): GiteaHttpClient {
    let client = this.clients.get(profile.name);
    if (!client) {
      client = new GiteaHttpClient(profile, {
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        caFile: this.config.caFile,
        useSystemCa: this.config.useSystemCa,
        userAgent: `claude-code-gitea/${serverVersion()}`,
        ...this.httpOverrides,
      });
      this.clients.set(profile.name, client);
    }
    return client;
  }

  /** Detected once per profile; a failed detection is not cached so it can be retried. */
  capabilities(profile: Profile): Promise<Capabilities> {
    let pending = this.caps.get(profile.name);
    if (!pending) {
      pending = detectCapabilities(this.client(profile));
      pending.catch(() => this.caps.delete(profile.name));
      this.caps.set(profile.name, pending);
    }
    return pending;
  }

  /** owner/repo of the working directory's git remote that points to the profile's server. */
  repoFromCwd(profile: Profile): Promise<{ owner: string; repo: string } | undefined> {
    const key = `${profile.name}|${this.cwd}`;
    let pending = this.remotes.get(key);
    if (!pending) {
      pending = localContext(this.cwd, profile.baseUrl)
        .then((lc) => {
          const match =
            lc.remotes.find((r) => r.name === 'origin' && r.giteaRepo) ?? lc.remotes.find((r) => r.giteaRepo);
          return match?.giteaRepo;
        })
        .catch(() => undefined);
      this.remotes.set(key, pending);
    }
    return pending;
  }
}

export function notConfigured(warnings: string[] = []): GiteaError {
  return new GiteaError('NOT_CONFIGURED', 'No Gitea server is configured.', {
    hint: [
      'Run /plugin, select the "gitea" plugin and choose Configure to set the Gitea URL and an API token,',
      'or run `claude plugin configure gitea` in a terminal.',
      ...warnings,
    ].join(' '),
  });
}
