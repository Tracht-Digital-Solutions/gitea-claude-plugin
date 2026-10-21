import { isAllowed, type AccessLevel, type Permissions } from '../config/config.js';
import type { ToolDefinition } from './types.js';
import { actionTools } from './modules/actions.js';
import { connectionTools } from './modules/connection.js';
import { contentTools } from './modules/contents.js';
import { extendedTools } from './modules/extended.js';
import { gitTools } from './modules/git.js';
import { issueTools } from './modules/issues.js';
import { orgTools } from './modules/orgs.js';
import { packageTools } from './modules/packages.js';
import { projectTools } from './modules/projects.js';
import { pullTools } from './modules/pulls.js';
import { releaseTools } from './modules/releases.js';
import { repoTools } from './modules/repos.js';
import { timeTools } from './modules/time.js';
import { wikiTools } from './modules/wiki.js';

/** Every tool the server knows, in display order. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...connectionTools,
  ...repoTools,
  ...contentTools,
  ...gitTools,
  ...issueTools,
  ...projectTools,
  ...timeTools,
  ...pullTools,
  ...orgTools,
  ...actionTools,
  ...releaseTools,
  ...packageTools,
  ...wikiTools,
  ...extendedTools,
];

/**
 * Tools exposed to the client. Tools whose access level is disabled by configuration are not
 * registered at all, so the model cannot call them by accident; `connection_test` reports what
 * is disabled and how to enable it.
 */
export function enabledTools(permissions: Permissions): ToolDefinition[] {
  return ALL_TOOLS.filter((t) => isAllowed(t.access, permissions));
}

export function toolsByAccess(): Record<AccessLevel, string[]> {
  const out: Record<AccessLevel, string[]> = { read: [], write: [], destructive: [], admin: [] };
  for (const t of ALL_TOOLS) out[t.access].push(t.name);
  return out;
}
