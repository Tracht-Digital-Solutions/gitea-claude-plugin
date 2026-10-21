import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the shipped plugin layout. The skills are listed explicitly so that a file missing from
 * the repository (for example because of an over-broad .gitignore rule) fails CI instead of
 * silently disappearing from a release.
 */
const SKILLS = [
  'ci-failures',
  'issue-triage',
  'pr-from-changes',
  'pr-review',
  'release',
  'repo-overview',
  'setup',
];

describe('plugin layout', () => {
  it('ships exactly the documented skills', () => {
    const dirs = readdirSync('plugin/skills', { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(SKILLS);
    const readme = readFileSync('README.md', 'utf8');
    for (const skill of SKILLS) expect(readme).toContain(`\`${skill}\``);
  });

  it.each(SKILLS)('skill %s has frontmatter with matching name and a description', (skill) => {
    const text = readFileSync(`plugin/skills/${skill}/SKILL.md`, 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
    expect(front).toMatch(new RegExp(`^name: ${skill}$`, 'm'));
    expect(/^description: (.+)$/m.exec(front)?.[1]?.length ?? 0).toBeGreaterThan(80);
  });

  it('has a manifest, MCP configuration and icon', () => {
    for (const f of [
      '.claude-plugin/plugin.json',
      '.claude-plugin/icon.png',
      '.mcp.json',
      'README.md',
      'LICENSE',
    ]) {
      expect(existsSync(`plugin/${f}`), f).toBe(true);
    }
    const mcp = JSON.parse(readFileSync('plugin/.mcp.json', 'utf8')) as {
      mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
    };
    expect(mcp.mcpServers.gitea?.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
    expect(mcp.mcpServers.gitea?.env.GITEA_TOKEN).toBe('${user_config.gitea_token}');
  });

  it('declares the token as a sensitive option and keeps destructive and admin operations off by default', () => {
    const manifest = JSON.parse(readFileSync('plugin/.claude-plugin/plugin.json', 'utf8')) as {
      userConfig: Record<string, { sensitive?: boolean; default?: unknown }>;
    };
    expect(manifest.userConfig.gitea_token?.sensitive).toBe(true);
    expect(manifest.userConfig.allow_destructive?.default).toBe(false);
    expect(manifest.userConfig.allow_admin?.default).toBe(false);
    expect(manifest.userConfig.allow_insecure_http?.default).toBe(false);
  });
});
