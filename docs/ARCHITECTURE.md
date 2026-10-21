# Architecture

## Overview

```text
┌──────────────────────────── Claude Code ─────────────────────────────┐
│  plugin "gitea"                                                      │
│   ├─ skills/            7 workflow skills (setup, pr-review, …)      │
│   ├─ .mcp.json          starts: node ${CLAUDE_PLUGIN_ROOT}/dist/server.mjs
│   └─ userConfig         URL, token (OS credential store), levels, TLS │
└───────────────┬──────────────────────────────────────────────────────┘
                │ MCP over stdio (JSON-RPC)
┌───────────────▼──────────────── MCP server (src/) ───────────────────┐
│ index.ts        process entry, Node version check, stdio transport   │
│ server.ts       tool registration, permission gate, feature gate,    │
│                 confirmation (elicitation / token), result formatting │
│ tools/          registry + 14 modules (repos, contents, git, issues, projects, time, │
│                 pulls, orgs, actions, releases, packages, wiki, extended, connection) │
│ gitea/          http client · errors · capabilities · models         │
│ config/         plugin options, env, profiles file, access levels    │
│ security/       redaction · URL/path validation                       │
│ git/            local git via execFile (no shell)                     │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS (undici), token header, custom CA
          ┌─────▼─────┐
          │   Gitea   │  REST API /api/v1 + /swagger.v1.json
          └───────────┘
```

## Request flow of a tool call

1. Claude Code sends `tools/call`. The MCP SDK validates the arguments against the tool's zod
   schema — invalid input never reaches a handler.
2. `server.ts` resolves the **profile** (argument `profile` or the default).
3. **Permission gate**: the tool's access level (`read`, `write`, `destructive`, `admin`) is checked
   against the plugin options and the profile's `readOnly` flag. Disabled levels are not even
   registered; the runtime check also covers read-only profiles.
4. **Feature gate**: tools that depend on optional APIs (Actions, tag protection, …) check the
   instance's capabilities, detected once per profile from `/api/v1/version` and the instance's own
   OpenAPI document. A missing endpoint yields `UNSUPPORTED` instead of a confusing 404.
5. **Confirmation**: consequential tools declare a `confirm()` that returns the exact target and a
   description of the consequence. If the client supports MCP elicitation the user confirms in the
   Claude Code UI; otherwise the call must carry `confirm: "<target>"`, which the model may only send
   after the user agreed (the server instructions and error hint say so). Without confirmation
   nothing is sent to Gitea.
6. The handler runs, using the HTTP client and returning a compact projection of Gitea's objects
   (`gitea/models.ts`) to keep context usage low.
7. Results and errors are serialised as JSON, **redacted**, and truncated at 150 000 characters.

## HTTP client (`gitea/http.ts`)

- undici `fetch` with a dedicated `Agent`; custom CA files and the OS store are added to Node's
  default roots (never replacing them, never disabling verification).
- Paths are built from encoded segments and must stay below `/api/v1`; file paths reject `..`,
  empty segments, backslashes and control characters.
- Redirects are handled manually: same-origin `GET` redirects are followed (max. 3); redirects to
  another origin are refused, except for downloads (artifacts, logs) where an `https` target is
  followed **without** the `Authorization` header.
- Timeouts via `AbortSignal.timeout` and undici header/body timeouts.
- Retries with exponential backoff and jitter for idempotent requests on network errors, 502, 503,
  504; `429` honours `Retry-After` up to 60 s and otherwise reports `RATE_LIMITED`.
- Pagination helper with an upper bound (`limit`) and support for wrapped lists
  (`workflow_runs`, `jobs`, …); endpoints without pagination use `list()`.
- Response bodies are size-limited; logs and diffs report truncation.

## Errors

Every failure is a `GiteaError` with a stable `code` (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `VALIDATION_FAILED`, `RATE_LIMITED`, `SERVER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`,
`TLS_ERROR`, `REDIRECT_BLOCKED`, `UNSUPPORTED`, `PERMISSION_DENIED`, `CONFIRMATION_REQUIRED`,
`CANCELLED`, `NOT_CONFIGURED`, `INVALID_INPUT`, `INVALID_CONFIG`, `GIT_ERROR`), the HTTP status, the
Gitea message and an actionable `hint`. Tool results set `isError: true` and contain
`{"error": {...}}`.

## Security model

| Threat                           | Mitigation                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token leakage                    | OS credential store via `sensitive` userConfig; central redaction of all output (registered secrets + header/URL/JSON patterns); token sent only to the configured origin; never in URLs |
| Eavesdropping                    | `https://` required; `http://` only with explicit opt-in                                                                                                                                 |
| Untrusted / private certificates | verification always on; trust is extended only by explicit CA files or the OS store                                                                                                      |
| SSRF / other network targets     | all API URLs derive from the configured base; cross-origin redirects refused; webhook targets are only created with confirmation                                                         |
| Path traversal                   | encoded segments, file-path validation, API base containment; local uploads/downloads confined to the working directory                                                                  |
| Command injection                | git via `execFile` without shell, fixed argument vectors, validated branch/remote names, `refs/heads/` prefixes, no force push                                                           |
| Accidental destructive actions   | access levels (destructive/admin off by default and unregistered), per-call informed confirmation, merge-readiness check before merging                                                  |
| Excessive output / DoS           | page limits, body size limits, result truncation                                                                                                                                         |
| Tests modifying real servers     | integration tests refuse non-loopback instances and run against a throwaway Docker container                                                                                             |

## Architecture decisions

**ADR-1 · Plugin name `gitea`, repository `claude-code-gitea`.** Claude Code reserves plugin names
starting with `claude-`; `claude plugin validate` rejects them. The repository keeps the requested
name; the plugin and its tools are namespaced `gitea`.

**ADR-2 · Single-file bundle, no install step.** The server and its dependencies (MCP SDK, zod,
undici, diff) are bundled with esbuild into `plugin/dist/server.mjs` (ESM, Node 22 target).
Installing the plugin needs no `npm install` and no compiler. The version is read from
`plugin.json` at runtime, so a release only changes manifests and the bundle is reproducible.

**ADR-3 · Distribution via a `stable` branch.** `main` contains sources only. For each release the
pipeline runs the full CI against the release tag, builds, and appends a commit to the `stable`
distribution branch whose tree is the tag's `plugin/` directory plus the built bundle (its own
linear history: no force push, and no workflow files, which `GITHUB_TOKEN` may not push). The
marketplace entry uses a `git-subdir` source on `stable`, so installs always get exactly the
tested release. The same files are published as a zip with checksums, and `verify-release.yml`
installs the published plugin from the marketplace and checks that the installed files are
identical to that zip.

**ADR-4 · Access levels instead of a single write flag.** read / write / destructive / admin, with
destructive and admin off by default. Disabled tools are not registered, which also saves context.
Merges, visibility and permission changes additionally require confirmation even though they are
not deletions.

**ADR-5 · Confirmation through MCP elicitation with a token fallback.** Elicitation puts the
decision in front of the user, outside the model. Clients without elicitation (e.g. headless
`claude -p`) get `CONFIRMATION_REQUIRED` with the exact token, which the server instructions allow
only after explicit user consent. Claude Code's own tool-permission prompt is a further layer.

**ADR-6 · Capability detection from the instance's OpenAPI document.** Gitea versions and Forgejo
differ in their APIs. Instead of guessing from version numbers, optional features are mapped to the
endpoint that proves them and checked against `/swagger.v1.json`. If the document is disabled,
features are `unknown` and calls proceed, with `NOT_FOUND` hints mentioning possible version
limits.

**ADR-7 · No endpoint is assumed.** A recorded copy of the Gitea 28.2 OpenAPI document is part of the
tests. The integration suite records every request made while exercising all tools and fails if a
path or query parameter is not documented there.

**ADR-8 · Content search via the API.** Gitea's REST API has no code search endpoint. `code_search`
walks the git tree and scans text files (size-limited, bounded file count), and `files_find`
matches paths with globs.

**ADR-9 · Compact projections.** Gitea objects embed full user and repository objects repeatedly.
Tools return compact shapes (`gitea/models.ts`) to keep results readable and context-efficient.

## Testing strategy

| Layer        | Location                                               | What it proves                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit         | `test/unit`                                            | redaction, URL/path validation, configuration and profiles, permission matrix, HTTP retry/backoff/rate limit/redirect/timeout/error mapping (undici `MockAgent`), real TLS handshake with a generated private CA, git argument validation, analysis helpers |
| MCP protocol | `test/mcp`                                             | initialisation, tool discovery and annotations, schema validation, structured errors, redaction of results, feature gate, repository detection, confirmation via elicitation and token                                                                      |
| Integration  | `test/integration`                                     | every tool against Gitea 28.2 + act_runner in Docker; every request checked against the OpenAPI document                                                                                                                                                    |
| Plugin       | `scripts/validate-plugin.mjs`, `scripts/smoke-mcp.mjs` | `claude plugin validate --strict` for plugin and marketplace, version consistency, bundled server starts and answers over stdio                                                                                                                             |
| Release      | `.github/workflows/release.yml`                        | reproducible package, install from the published marketplace and MCP connection with the released version                                                                                                                                                   |

## Repository layout

```text
.claude-plugin/marketplace.json   marketplace catalogue (points to the stable branch)
plugin/                           the plugin as installed
  .claude-plugin/plugin.json      manifest and userConfig
  .mcp.json                       MCP server definition
  skills/*/SKILL.md               workflow skills
  dist/server.mjs                 built bundle (only on stable / in release zips)
src/                              MCP server sources (TypeScript, strict)
test/                             unit, mcp, integration tests and the OpenAPI fixture
scripts/                          build, package, validate, smoke test, test environment, docs
docs/                             documentation (English, docs/de German)
.github/workflows/                ci, security, release
```
