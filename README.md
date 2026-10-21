# Gitea for Claude Code

[![CI](https://github.com/jtracht/gitea-claude-plugin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jtracht/gitea-claude-plugin/actions/workflows/ci.yml)
[![Security](https://github.com/jtracht/gitea-claude-plugin/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/jtracht/gitea-claude-plugin/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/jtracht/gitea-claude-plugin?sort=semver)](https://github.com/jtracht/gitea-claude-plugin/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)

A [Claude Code](https://code.claude.com) plugin that connects Claude to **any Gitea instance** — gitea.com or your own self-hosted server. It ships a bundled MCP server with **154 tools** and **7 workflow skills** for repositories, files, branches, issues, pull requests and reviews, organisations and teams, Gitea Actions, releases, webhooks and notifications.

> 🇩🇪 Deutsche Dokumentation: [docs/de/README.md](docs/de/README.md)

```text
You:    Analyse the failed Gitea Actions runs and fix the pipeline.
Claude: ▸ gitea · actions_failures_analyze   → run #42 failed in job "test", step "npm test"
        ▸ gitea · actions_job_logs           → error: Cannot find module './config.js'
        The test imports a file that was renamed in 3f2c1a9 …
```

## Features

| Area              | What Claude can do                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repositories**  | list, search, inspect, create, configure, change visibility, archive, fork, delete (confirmed), topics                                                                       |
| **Files**         | read, list directories and trees, find files by glob, search contents, create/update/delete, multi-file commits, compare a file between refs                                 |
| **Git**           | branches, commits with diffs, history analysis, compare refs, tags, commit status, branch and tag protection, local repository inspection and push                           |
| **Issues**        | list/filter by priority, labels, assignee, milestone; search across repositories; create, edit, assign, label, comment, close/reopen; backlog summary; labels and milestones |
| **Projects**      | kanban boards on repositories, organisations and your account: create (templates or own columns), show the board, add/move/remove issues, manage columns                     |
| **Time tracking** | book time on issues (also for other users), list totals per user/issue/repository with date filters, delete entries, start/stop/cancel the stopwatch                         |
| **Pull requests** | list, create, edit, diff, files, commits, reviews and inline comments, review requests, merge-readiness check, merge (confirmed), update branch, close                       |
| **Organisations** | users, organisations, members, teams and team members, collaborators, repository access analysis                                                                             |
| **Gitea Actions** | workflows and their YAML, runs, jobs, logs, failure analysis, re-run, dispatch, cancel, artifacts                                                                            |
| **Releases**      | list, create (with generated notes), edit, delete, assets upload/delete, notes generation, compare releases                                                                  |
| **More**          | webhooks (repository and organisation), notifications, repository health analysis                                                                                            |

Full list: [docs/TOOLS.md](docs/TOOLS.md).

**Skills** (invoke with `/gitea:<name>` or just ask in natural language): `setup`, `pr-from-changes`, `pr-review`, `issue-triage`, `ci-failures`, `release`, `repo-overview`.

## Requirements

- Claude Code 2.1.x or newer
- **Node.js ≥ 22.19** on your `PATH` (the MCP server is a single bundled JavaScript file; no `npm install`, no build step)
- A Gitea instance with the API enabled and a personal access token. Tested against Gitea 28.2; feature detection adapts to older versions and Forgejo.

## Installation

In Claude Code:

```text
/plugin marketplace add jtracht/gitea-claude-plugin
/plugin install gitea@jtracht-gitea
```

Or from a terminal:

```bash
claude plugin install gitea --marketplace jtracht/gitea-claude-plugin
# equivalent:
claude plugin marketplace add jtracht/gitea-claude-plugin
claude plugin install gitea@jtracht-gitea
```

> No GitHub SSH key? Set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before adding the marketplace.

Claude Code then asks for the plugin options. You can change them at any time with `/plugin` → **gitea** → **Configure**, or `claude plugin configure gitea`. Run `/reload-plugins` (or restart Claude Code) afterwards.

Offline / air-gapped: download `gitea-plugin-<version>.zip` from the [releases](https://github.com/jtracht/gitea-claude-plugin/releases), verify it against `SHA256SUMS`, unpack it and start Claude Code with `claude --plugin-dir ./gitea`.

## Configuration

| Option                          | Default | Description                                                                                     |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| Gitea server URL                | –       | e.g. `https://git.example.com` (https required)                                                 |
| Gitea API token                 | –       | stored in the OS credential store, never in `settings.json`                                     |
| Allow write operations          | on      | create/edit repositories, files, branches, issues, PRs, releases                                |
| Allow destructive operations    | **off** | deletions; each one still needs your confirmation                                               |
| Allow administrative operations | **off** | organisations, teams, collaborators, protection rules, webhooks; each change needs confirmation |
| CA certificate file             | –       | PEM file of a private CA for self-hosted servers                                                |
| Trust the OS CA store           | off     | also trust certificates installed in the operating system                                       |
| Profiles file                   | –       | JSON file with additional Gitea servers                                                         |
| Allow insecure HTTP             | off     | only for local test instances                                                                   |

### Connecting to your own Gitea

1. In Gitea open **Settings → Applications → Manage Access Tokens** and create a token. Recommended scopes for everyday work: `write:repository`, `write:issue`, `write:user`, `read:organization`, `write:notification` (read-only use: the `read:` variants).
2. Configure the plugin with your server, e.g. `https://git.tracht-digital.de`, and the token.
3. Ask Claude: _"Test the Gitea connection."_ — `connection_test` reports the server version, the user, granted scopes, supported features and enabled operation levels.

Self-signed or internal certificates: set **CA certificate file** to your CA's PEM file or enable **Trust the OS CA store**. TLS verification is never disabled.

Multiple servers, read-only profiles and all environment variables: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Usage examples

- "Show me my Gitea repositories."
- "Create a new private repository called `inventory-service` with a README."
- "Analyse all open issues and suggest priorities."
- "Show the failed Gitea Actions runs."
- "Create a pull request from my changes."
- "Analyse the last pull request."
- "Create a release for this repository."
- "Compare the last two releases."
- "Show me all open tasks of the project."

When you work inside a clone whose remote points to your Gitea server, `owner` and `repo` are detected automatically.

## Security

- The token is kept in the system credential store, sent only to the configured origin, and redacted from every log line, error and tool result.
- Plain `http://` is refused unless explicitly allowed; redirects to other hosts are never followed with credentials.
- Operations are split into **read**, **write**, **destructive** and **admin**. Destructive and admin tools are not even registered until you enable them.
- Deleting, merging, changing visibility and changing permissions require an **informed confirmation**: Claude Code asks you directly (MCP elicitation) or the call must carry a confirmation token that Claude may only send after you agreed.
- Local git operations run without a shell and with validated arguments; file uploads are restricted to the working directory.

Details: [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

| Symptom                 | Fix                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `NOT_CONFIGURED`        | Configure URL and token via `/plugin` → gitea → Configure, then `/reload-plugins`.               |
| `UNAUTHORIZED`          | Token invalid, expired or revoked — create a new one.                                            |
| `FORBIDDEN … scope`     | The token lacks a scope; create one with the scope named in the message.                         |
| `TLS_ERROR`             | Private CA: set **CA certificate file** or **Trust the OS CA store**.                            |
| `REDIRECT_BLOCKED`      | Configure the final canonical URL (scheme, host, sub path).                                      |
| `PERMISSION_DENIED`     | The operation level is disabled in the plugin options.                                           |
| `UNSUPPORTED`           | Your Gitea version lacks that API; `connection_test` lists supported features.                   |
| MCP server not starting | Check `node --version` (≥ 22.19) and `claude mcp list`; set `GITEA_LOG_LEVEL=debug` for details. |

More: [docs/INSTALLATION.md](docs/INSTALLATION.md#troubleshooting).

## Development

```bash
npm ci
npm run check            # typecheck, lint, format, docs, unit + MCP tests, build, smoke test
npm run gitea:up         # isolated Gitea + Actions runner in Docker (127.0.0.1 only)
npm run test:integration # exercises every tool against it and verifies each request against the OpenAPI spec
npm run gitea:down
claude --plugin-dir ./plugin   # try the local build
```

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE). Gitea is a trademark of its respective owners; this project is not affiliated with Gitea or Anthropic.
