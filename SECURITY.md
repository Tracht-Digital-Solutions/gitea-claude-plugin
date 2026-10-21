# Security policy

## Supported versions

Security fixes are released for the latest minor version. Please update to the newest release
(`claude plugin update gitea@jtracht-gitea`) before reporting an issue.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting instead: **Security → Report a vulnerability** on
<https://github.com/jtracht/claude-code-gitea/security/advisories/new>.

Include the affected version, a description of the impact, and steps to reproduce. Never include
real API tokens, even revoked ones. You will receive an acknowledgement within 7 days; confirmed
issues are fixed and disclosed through a GitHub security advisory and a release.

## Security design

- **Credentials** — the Gitea token is a `sensitive` plugin option and lives in the operating
  system's credential store. The server registers it with a central redactor that removes it (and
  common credential patterns) from all logs, errors and tool results. It is sent only as an
  `Authorization` header to the configured origin, never in a URL and never to redirect targets on
  other hosts.
- **Transport** — `https://` is required; `http://` needs an explicit opt-in. TLS certificate
  verification cannot be disabled; private CAs are supported through a CA file or the OS store.
- **Least privilege** — destructive and administrative tools are off by default and not registered
  until enabled. Use tokens with the narrowest scopes you need (see
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#recommended-token-scopes)).
- **Informed confirmation** — deletions, merges, visibility and permission changes require an
  explicit user confirmation for every call (MCP elicitation, or a confirmation token the model may
  only send after the user agreed).
- **Input handling** — all tool inputs are schema-validated; API paths are built from encoded
  segments and must stay below `/api/v1`; repository file paths reject traversal; local git commands
  run via `execFile` without a shell and with validated arguments; local file uploads and downloads
  are confined to the working directory.
- **Supply chain** — dependencies are bundled at build time and audited (`npm audit`, Dependabot,
  dependency review); GitHub Actions are pinned to commit SHAs and analysed with zizmor; CodeQL and
  gitleaks run on every change; releases include SHA-256 checksums and a CycloneDX SBOM.

## Scope

The plugin acts with the permissions of the configured token. Prompt injection through content
stored in Gitea (issue bodies, file contents, logs) cannot be fully prevented by a tool server;
the confirmation requirement for consequential actions and Claude Code's permission prompts limit
its impact. Review actions proposed after reading untrusted content.
