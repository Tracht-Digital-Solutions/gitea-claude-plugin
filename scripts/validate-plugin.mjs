#!/usr/bin/env node
// Validates the plugin and marketplace manifests with the Claude Code CLI (strict mode) and
// checks that all version numbers agree. Requires `claude` on PATH.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkg = read('package.json');
const plugin = read('plugin/.claude-plugin/plugin.json');
const marketplace = read('.claude-plugin/marketplace.json');
const manifest = read('.release-please-manifest.json');
const errors = [];

if (pkg.version !== plugin.version)
  errors.push(`package.json ${pkg.version} != plugin.json ${plugin.version}`);
if (manifest['.'] !== pkg.version)
  errors.push(`.release-please-manifest.json ${manifest['.']} != package.json ${pkg.version}`);
const entry = marketplace.plugins.find((p) => p.name === plugin.name);
if (!entry) errors.push(`marketplace.json has no entry for plugin "${plugin.name}"`);
else if (entry.version)
  errors.push('marketplace.json must not set a version (plugin.json is the single source)');
if (
  entry &&
  (entry.source?.source !== 'git-subdir' || entry.source.path !== 'plugin' || entry.source.ref !== 'stable')
) {
  errors.push('marketplace entry must point to git-subdir path "plugin" on ref "stable"');
}

// Every file of the plugin except the build output must be tracked: an over-broad .gitignore rule
// would silently drop it from the release (git ls-files lists ignored files that exist on disk).
const gitList = (...args) =>
  execFileSync('git', ['ls-files', ...args, 'plugin'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
const ignored = gitList('--others', '--ignored', '--exclude-standard').filter(
  (f) => !f.startsWith('plugin/dist/'),
);
if (ignored.length) {
  errors.push(`files under plugin/ are ignored by .gitignore and would not ship: ${ignored.join(', ')}`);
}
const untracked = gitList('--others', '--exclude-standard');
if (untracked.length) errors.push(`untracked files under plugin/: ${untracked.join(', ')}`);

// On Windows `claude` may be a .cmd shim that needs a shell; the arguments are fixed literals.
const run = (args) => {
  const out =
    process.platform === 'win32'
      ? execFileSync(`claude ${args.join(' ')}`, { encoding: 'utf8', shell: true })
      : execFileSync('claude', args, { encoding: 'utf8' });
  process.stdout.write(out);
};
try {
  run(['plugin', 'validate', 'plugin', '--strict']);
  run(['plugin', 'validate', '.', '--strict']);
} catch (err) {
  errors.push(`claude plugin validate failed: ${err.stdout ?? err.message}`);
}

if (errors.length) {
  console.error(`\n${errors.map((e) => `✘ ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n✔ manifests valid, version ${pkg.version} consistent`);
