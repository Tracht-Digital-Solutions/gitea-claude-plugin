# Installation and troubleshooting

## Prerequisites

| Requirement                                   | Check                           |
| --------------------------------------------- | ------------------------------- |
| Claude Code 2.1 or newer                      | `claude --version`              |
| Node.js 22.19 or newer on `PATH`              | `node --version`                |
| git (for the marketplace and local git tools) | `git --version`                 |
| A Gitea instance and a personal access token  | Gitea → Settings → Applications |

Node.js is needed because the MCP server runs as `node dist/server.mjs`. The file is
self-contained: nothing is downloaded or compiled during installation.

## Install from the marketplace

```bash
claude plugin marketplace add jtracht/claude-code-gitea
claude plugin install gitea@jtracht-gitea
```

or inside Claude Code: `/plugin marketplace add jtracht/claude-code-gitea`, then
`/plugin install gitea@jtracht-gitea`.

The marketplace entry points to the `stable` branch, which contains exactly the files of the latest
release (the tagged sources plus the built server). Updates arrive with
`claude plugin update gitea@jtracht-gitea` or `/plugin marketplace update jtracht-gitea`; enable
auto-update for the marketplace in `/plugin` → **Marketplaces** if you like.

Without a GitHub SSH key set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before adding the marketplace.

## Configure

1. Create a token in Gitea (**Settings → Applications → Manage Access Tokens**) with the scopes from
   [CONFIGURATION.md](CONFIGURATION.md#recommended-token-scopes).
2. `/plugin` → **gitea** → **Configure**: enter the server URL and the token.
3. `/reload-plugins`.
4. Ask Claude _"Test the Gitea connection"_ or run `/gitea:setup`.

## Install a release archive manually

```bash
curl -LO https://github.com/jtracht/claude-code-gitea/releases/download/vX.Y.Z/gitea-plugin-X.Y.Z.zip
curl -LO https://github.com/jtracht/claude-code-gitea/releases/download/vX.Y.Z/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
unzip gitea-plugin-X.Y.Z.zip            # creates ./gitea
claude --plugin-dir ./gitea
```

## Build from source

```bash
git clone https://github.com/jtracht/claude-code-gitea.git
cd claude-code-gitea
npm ci
npm run build                 # writes plugin/dist/server.mjs
claude --plugin-dir ./plugin
```

## Uninstall

```bash
claude plugin uninstall gitea@jtracht-gitea
claude plugin marketplace remove jtracht-gitea   # also deletes the stored options and token
```

## Troubleshooting

**Check the server status.** `claude mcp list` should show
`plugin:gitea:gitea … ✔ Connected`. Inside Claude Code, `/mcp` shows the same and lets you
reconnect.

| Problem                                        | Cause and fix                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin:gitea:gitea … ✘ Failed`                | Node.js missing or too old. Install Node.js ≥ 22.19 and make sure `node` is on the `PATH` Claude Code sees.                                               |
| `NOT_CONFIGURED`                               | URL or token not set. Configure the plugin and run `/reload-plugins`.                                                                                     |
| `INVALID_CONFIG … unencrypted http://`         | Use `https://`. For a local test server enable _Allow insecure HTTP_.                                                                                     |
| `UNAUTHORIZED`                                 | Token wrong, expired or revoked. Create a new token and configure it.                                                                                     |
| `FORBIDDEN … required scope(s)`                | Token lacks a scope. Create a token with the scope named in the message.                                                                                  |
| `FORBIDDEN` without scope                      | Your Gitea user lacks permission for that repository or organisation.                                                                                     |
| `TLS_ERROR`                                    | The certificate is not trusted. Set _CA certificate file_ to your CA (PEM) or enable _Trust the OS CA store_. Alternatively export `NODE_EXTRA_CA_CERTS`. |
| `NETWORK_ERROR … ENOTFOUND / ECONNREFUSED`     | Wrong host/port, VPN not connected, firewall or proxy.                                                                                                    |
| `REDIRECT_BLOCKED`                             | The URL redirects (e.g. http→https, `www.` prefix, other host). Configure the final URL.                                                                  |
| `NOT_FOUND` for an existing private repository | The token user has no access to it.                                                                                                                       |
| `PERMISSION_DENIED`                            | The operation level (write/destructive/admin) is disabled in the plugin options, or the profile is read-only.                                             |
| `CONFIRMATION_REQUIRED`                        | Expected for consequential actions: confirm when Claude asks.                                                                                             |
| `UNSUPPORTED`                                  | The Gitea version does not provide that API (e.g. older Actions APIs). `connection_test` shows supported features.                                        |
| `owner and repo are required`                  | You are not in a clone whose remote points to the configured server. Name the repository explicitly.                                                      |
| Tools do not appear                            | Destructive/admin tools are hidden until enabled. After changing options run `/reload-plugins`.                                                           |

**Debug logging.** Start Claude Code with `GITEA_LOG_LEVEL=debug` and run `claude --debug`; the
server logs to stderr. All log lines are redacted, but review them before sharing anyway.

**Platform notes.**

- _Windows_: the server runs with the `node` from `PATH`; paths in options may use `C:\…` or `~`.
- _macOS_: tokens are stored in the login keychain.
- _Linux_: tokens are stored via libsecret; on headless systems Claude Code may fall back to its own
  credential file.
