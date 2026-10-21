# Development progress

Task ledger for the initial development of the plugin, kept so that a later session can continue
where the previous one stopped. A task counts only after it was verified (command output, test run
or published artefact). Weights per phase follow the project brief.

Last update: 2026-10-21 — initial development complete, first public release **v0.2.0**.

| Phase                                |    Weight |      Done |
| ------------------------------------ | --------: | --------: |
| 1 Analysis and requirements          |       8 % |       8 % |
| 2 Architecture and project structure |      10 % |      10 % |
| 3 Gitea MCP implementation           |      28 % |      28 % |
| 4 Security and authentication        |      12 % |      12 % |
| 5 Claude Code plugin and marketplace |      10 % |      10 % |
| 6 Tests and quality assurance        |      15 % |      15 % |
| 7 CI/CD and release automation       |      10 % |      10 % |
| 8 Documentation and publication      |       7 % |       7 % |
| **Total**                            | **100 %** | **100 %** |

## Tasks

### 1 Analysis (8 %)

- [x] (2) Environment: Node 24.16, npm 11.13, git 2.55, Claude Code 2.1.306, Docker 29.8, gh as `jtracht`
- [x] (3) Current plugin/marketplace spec (userConfig `sensitive`, git-subdir sources, reserved names), MCP SDK 1.32
- [x] (3) Gitea API baseline: OpenAPI document of Gitea 28.2.0 stored as test fixture

### 2 Architecture (10 %)

- [x] (3) Module structure (`src/config`, `gitea`, `security`, `git`, `tools`) — `tsc` strict passes
- [x] (3) Tooling: ESLint strict-type-checked, Prettier, Vitest projects — all green
- [x] (4) `docs/ARCHITECTURE.md` with ADRs, security model and test strategy

### 3 Gitea MCP implementation (28 %)

Verified by the integration suite, which exercises every one of the 126 tools against Gitea 28.2 +
act_runner and checks each request against the OpenAPI document.

- [x] (4) HTTP client, errors, capabilities, models
- [x] (4) Repositories and contents (incl. code search, multi-file commits)
- [x] (4) Branches, commits, tags, compare, protections, local git
- [x] (4) Issues, labels, milestones, triage summary
- [x] (4) Pull requests, reviews, merge readiness, merge
- [x] (3) Users, organisations, teams, collaborators, access analysis
- [x] (3) Gitea Actions (runs, jobs, logs, failure analysis, rerun, dispatch, cancel, artifacts)
- [x] (2) Releases, assets, notes, comparison; webhooks, notifications, repository analysis

### 4 Security (12 %)

- [x] (3) Config from userConfig/env/profiles file; token in OS credential store (verified via real install)
- [x] (2) TLS: private CA file and OS store, verification never disabled (real TLS handshake test)
- [x] (2) Redaction of logs, errors and results (unit + MCP + integration tests)
- [x] (3) Access levels and informed confirmation (elicitation + token) (MCP + integration tests)
- [x] (2) Timeouts, retry/backoff, Retry-After, redirect policy, pagination (unit tests)

### 5 Plugin and marketplace (10 %)

- [x] (3) `plugin.json` + `.mcp.json` — `claude plugin validate --strict` passes
- [x] (3) 7 skills — loaded by Claude Code (`claude plugin details gitea`), guarded by a unit test
- [x] (2) `marketplace.json` — `claude plugin validate . --strict` passes
- [x] (2) Install from the public marketplace (`claude plugin marketplace add jtracht/claude-code-gitea`),
      `claude mcp list` → Connected, natural-language end-to-end run via `claude -p`

### 6 Tests (15 %)

- [x] (5) Unit tests (redaction, URL, config, HTTP, TLS, git, analysis, plugin layout)
- [x] (3) MCP protocol tests (in-memory transport)
- [x] (5) Integration tests (Docker Gitea + runner, all tools, OpenAPI conformance)
- [x] (2) Security tests (traversal, injection, invalid token, missing scope, redirects, TLS)

### 7 CI/CD (10 %)

- [x] (4) `ci.yml` green on GitHub (Linux/Windows/macOS × Node 22/24, integration, plugin validation)
- [x] (2) `security.yml` green (CodeQL, gitleaks full history, npm audit, dependency review, zizmor)
- [x] (3) `release.yml`: Release Please PR → CI on the tag → assets → stable branch → published release
      → `verify-release.yml` (install from marketplace, files identical to the zip, MCP connects)
- [x] (1) Dependabot for npm, ci-tools and GitHub Actions

### 8 Documentation and publication (7 %)

- [x] (3) README (EN), docs/de, CONFIGURATION, INSTALLATION/troubleshooting, ARCHITECTURE, TOOLS, community files
- [x] (2) Public repository `jtracht/claude-code-gitea`, history secret-scanned before the first push
- [x] (2) Release v0.2.0 with plugin zip, source archive, SBOM and checksums; marketplace install verified

## Release history notes

- **0.1.0 was not published.** The pipeline stopped before publication (draft releases were not
  visible to the resolve job; the stable branch could not be created with `GITHUB_TOKEN`), and the
  package turned out to miss the `release` skill because of an over-broad `.gitignore` rule. The
  draft and tag were withdrawn; **0.2.0 is the first published release**.

## Possible next steps

- Verify against older Gitea versions and Forgejo in the CI matrix (feature detection is in place).
- Wiki and package registry tools; repository migration/mirroring; Gitea projects (kanban).
- Streamable HTTP transport for use outside Claude Code.
- Submit the plugin to Anthropic's plugin directory.
