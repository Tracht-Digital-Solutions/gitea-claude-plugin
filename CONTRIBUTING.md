# Contributing

Thanks for helping to improve the Gitea plugin for Claude Code! Bug reports, feature requests and
pull requests are welcome. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: Node.js ≥ 22.19, npm, git, Docker (for integration tests) and the Claude Code CLI
(for manifest validation).

```bash
git clone https://github.com/jtracht/claude-code-gitea.git
cd claude-code-gitea
npm ci
npm run check
```

`npm run check` runs the TypeScript type check, ESLint, Prettier, the generated-docs check, unit and
MCP protocol tests, the build and an MCP smoke test of the bundle.

### Integration tests

```bash
npm run gitea:up           # Gitea + act_runner in Docker on 127.0.0.1:3301
npm run test:integration
npm run gitea:down
```

The suite creates and deletes its own users, organisations and repositories, exercises **every**
tool and fails if a request uses an endpoint or query parameter that is not in the Gitea OpenAPI
document (`test/fixtures/gitea-swagger.v1.json`). It refuses to run against non-loopback hosts.

### Trying your build in Claude Code

```bash
npm run build
claude --plugin-dir ./plugin
```

## Adding or changing a tool

1. Implement it in the matching module under `src/tools/modules/` with `defineTool`: a precise
   description, a zod input schema with limits, the correct `access` level, `feature` if it depends
   on an optional API, and `confirm` if it deletes data, merges, or changes visibility or
   permissions.
2. Use only endpoints that exist in the Gitea OpenAPI document; add the endpoint to
   `FEATURE_ENDPOINTS` if older versions may lack it.
3. Return compact projections (`src/gitea/models.ts`), not raw API objects.
4. Add unit tests for non-trivial logic and cover the tool in `test/integration/gitea.test.ts` (the
   suite fails for tools that were not exercised).
5. Run `npm run docs:tools` to regenerate `docs/TOOLS.md`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `ci:`, `chore:`; mark breaking changes with `!` or a `BREAKING CHANGE:`
  footer. Release Please derives versions and the changelog from them.
- Keep pull requests focused, describe the motivation and how you tested.
- CI must be green: type check, lint, tests on Linux/Windows/macOS, integration tests, plugin
  validation and security scans.
- Never commit tokens or other secrets; gitleaks runs on every pull request.

## Releases

Maintainers merge the release pull request opened by Release Please (its CI is started by the
release workflow, because pull requests opened with `GITHUB_TOKEN` do not trigger workflows). The
release workflow then runs the full CI against the tag, builds and packages the plugin, attaches the
zip, checksums, source archive and SBOM to the draft release, updates the `stable` branch that the
marketplace serves, publishes the release, and finally installs the published plugin from the
marketplace to verify it (`verify-release.yml`, also run weekly).

If publishing stops after the draft release was created, fix the cause and resume with
**Actions → Release → Run workflow** and the tag (e.g. `v1.2.3`); a published release is never
published twice.
