import type { Profile, ServerConfig } from '../config/config.js';
import type { Capabilities } from '../gitea/capabilities.js';
import { GiteaError } from '../gitea/errors.js';
import type { GiteaHttpClient } from '../gitea/http.js';
import { repoPath } from '../tools/common.js';
import type { RepoRef, ToolContext } from '../tools/types.js';
import { notConfigured, type Runtime } from './runtime.js';

/**
 * Context of one tool call. The profile is resolved eagerly; for tools that also work without a
 * configured server (`local`), a resolution error is kept and only thrown when the tool actually
 * needs the server.
 */
export class RequestContext implements ToolContext {
  readonly config: ServerConfig;
  readonly cwd: string;
  readonly maybeProfile: Profile | undefined;
  private readonly profileError: unknown;

  constructor(
    private readonly runtime: Runtime,
    profileName: string | undefined,
    local: boolean,
    private readonly sendLog: (message: string) => Promise<void>,
  ) {
    this.config = runtime.config;
    this.cwd = runtime.cwd;
    try {
      this.maybeProfile = runtime.profile(profileName);
    } catch (err) {
      if (!local) throw err;
      this.profileError = err;
    }
  }

  get profile(): Profile {
    if (this.maybeProfile) return this.maybeProfile;
    throw this.profileError instanceof Error ? this.profileError : notConfigured();
  }

  get client(): GiteaHttpClient {
    return this.runtime.client(this.profile);
  }

  capabilities(): Promise<Capabilities> {
    return this.runtime.capabilities(this.profile);
  }

  async repo(args: { owner?: string | undefined; repo?: string | undefined }): Promise<RepoRef> {
    if (args.owner && args.repo) return toRef(args.owner, args.repo);
    if (args.owner || args.repo) {
      throw new GiteaError(
        'INVALID_INPUT',
        'Provide both owner and repo, or neither to use the git remote of the working directory.',
      );
    }
    const detected = await this.runtime.repoFromCwd(this.profile);
    if (!detected) {
      throw new GiteaError('INVALID_INPUT', 'owner and repo are required.', {
        hint: `No git remote in ${this.cwd} points to ${this.profile.baseUrl.host}. Pass owner and repo explicitly.`,
      });
    }
    return toRef(detected.owner, detected.repo);
  }

  notify(message: string): Promise<void> {
    return this.sendLog(message);
  }
}

function toRef(owner: string, name: string): RepoRef {
  return { owner, name, fullName: `${owner}/${name}`, api: repoPath(owner, name) };
}
