import { readFileSync } from 'node:fs';

/**
 * The version is read from the plugin manifest at runtime instead of being compiled into the
 * bundle, so a release only changes the manifest and the bundle stays reproducible.
 */
export function serverVersion(): string {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT
      ? `${process.env.CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`
      : undefined,
    new URL('../.claude-plugin/plugin.json', import.meta.url), // bundled: plugin/dist/server.mjs
    new URL('../../plugin/.claude-plugin/plugin.json', import.meta.url), // sources: src/util/version.ts
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0-dev';
}
