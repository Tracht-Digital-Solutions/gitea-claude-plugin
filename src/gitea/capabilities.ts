import { log } from '../util/log.js';
import { GiteaError } from './errors.js';
import type { GiteaHttpClient } from './http.js';

/**
 * Optional API features. Each one is tied to the endpoint that proves its presence in the
 * instance's own OpenAPI document (`/swagger.v1.json`). No endpoint is assumed to exist.
 */
export const FEATURE_ENDPOINTS = {
  actions_workflows: 'GET /repos/{owner}/{repo}/actions/workflows',
  actions_runs: 'GET /repos/{owner}/{repo}/actions/runs',
  actions_run_jobs: 'GET /repos/{owner}/{repo}/actions/runs/{run}/jobs',
  actions_job_logs: 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
  actions_dispatch: 'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
  actions_rerun: 'POST /repos/{owner}/{repo}/actions/runs/{run}/rerun',
  actions_rerun_failed: 'POST /repos/{owner}/{repo}/actions/runs/{run}/rerun-failed-jobs',
  actions_cancel: 'POST /repos/{owner}/{repo}/actions/runs/{run}/cancel',
  actions_artifacts: 'GET /repos/{owner}/{repo}/actions/runs/{run}/artifacts',
  actions_artifact_download: 'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip',
  tag_protections: 'GET /repos/{owner}/{repo}/tag_protections',
  multi_file_commit: 'POST /repos/{owner}/{repo}/contents',
  compare: 'GET /repos/{owner}/{repo}/compare/{basehead}',
  pr_update_branch: 'POST /repos/{owner}/{repo}/pulls/{index}/update',
  notifications: 'GET /notifications',
  projects: 'GET /repos/{owner}/{repo}/projects',
  time_tracking: 'GET /repos/{owner}/{repo}/issues/{index}/times',
  wiki: 'GET /repos/{owner}/{repo}/wiki/pages',
  packages: 'GET /packages/{owner}',
  actions_runners: 'GET /repos/{owner}/{repo}/actions/runners',
  repo_archive_download: 'GET /repos/{owner}/{repo}/archive/{archive}',
} as const;

export type Feature = keyof typeof FEATURE_ENDPOINTS;

export interface Capabilities {
  version: string;
  /** Parsed [major, minor, patch] of the Gitea (or Forgejo-compatible) version, if parseable. */
  semver: [number, number, number] | undefined;
  forgejo: boolean;
  /** `swagger` when detected from the OpenAPI document, `unknown` if it is unavailable. */
  detection: 'swagger' | 'unknown';
  features: Record<Feature, boolean | 'unknown'>;
}

export function parseVersion(version: string): {
  semver: [number, number, number] | undefined;
  forgejo: boolean;
} {
  const forgejo = /forgejo|\+gitea-/i.test(version);
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  return {
    semver: m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined,
    forgejo,
  };
}

/** Normalises a swagger path template for comparison (`{index}` vs `{id}` stay distinct). */
export function endpointSet(swagger: unknown): Set<string> {
  const set = new Set<string>();
  const paths = (swagger as { paths?: Record<string, Record<string, unknown>> } | null)?.paths;
  if (!paths) return set;
  for (const [p, ops] of Object.entries(paths)) {
    for (const method of Object.keys(ops)) {
      if (method === 'parameters') continue;
      set.add(`${method.toUpperCase()} ${p}`);
    }
  }
  return set;
}

export function featuresFromEndpoints(endpoints: Set<string> | undefined): Capabilities['features'] {
  const out = {} as Capabilities['features'];
  for (const [feature, endpoint] of Object.entries(FEATURE_ENDPOINTS) as [Feature, string][]) {
    out[feature] = endpoints ? endpoints.has(endpoint) : 'unknown';
  }
  return out;
}

export async function detectCapabilities(client: GiteaHttpClient): Promise<Capabilities> {
  const version = await client.request<{ version: string }>({ path: '/version' });
  const v = version.data.version;
  let endpoints: Set<string> | undefined;
  try {
    const swagger = await client.request({
      path: '/swagger.v1.json',
      root: true,
      maxBytes: 20 * 1024 * 1024,
    });
    const set = endpointSet(swagger.data);
    if (set.size > 0) endpoints = set;
  } catch (err) {
    log.debug(`swagger not available: ${err instanceof GiteaError ? err.code : String(err)}`);
  }
  const parsed = parseVersion(v);
  return {
    version: v,
    semver: parsed.semver,
    forgejo: parsed.forgejo,
    detection: endpoints ? 'swagger' : 'unknown',
    features: featuresFromEndpoints(endpoints),
  };
}

export function assertFeature(caps: Capabilities, feature: Feature): void {
  if (caps.features[feature] === false) {
    throw new GiteaError(
      'UNSUPPORTED',
      `This Gitea instance (version ${caps.version}) does not provide the API endpoint ${FEATURE_ENDPOINTS[feature]}.`,
      { hint: 'Upgrade Gitea or use the web interface for this operation.' },
    );
  }
}
