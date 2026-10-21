---
name: setup
description: Set up, verify or troubleshoot the Gitea connection — first-time configuration of server URL and API token, token scopes, self-signed or private CA certificates, multiple Gitea profiles, and errors such as UNAUTHORIZED, NOT_CONFIGURED, TLS_ERROR or PERMISSION_DENIED. Use when the user wants to connect Claude Code to Gitea or a Gitea tool reports a configuration problem.
---

# Gitea setup and troubleshooting

Goal: a working, least-privilege connection to the user's Gitea server.

## 1. Check the current state

Call the `connection_test` tool of the gitea MCP server (and `profiles_list` if it fails with
NOT_CONFIGURED). Report to the user, briefly:

- server URL and Gitea version, authenticated user
- which read scopes are granted or missing
- which operation levels (write / destructive / admin) are enabled
- any `config_warnings`

If everything is fine, stop here and say so.

## 2. Not configured

Explain the two values the plugin needs and where they are stored:

- **Gitea server URL**, e.g. `https://git.example.com` (https is required)
- **API token** — stored in the operating system's credential store, never in `settings.json`

Tell the user how to create the token in Gitea: _Settings → Applications → Manage Access Tokens_,
with only the scopes they need:

| Use                                         | Scopes                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Read-only (browse, analyse)                 | `read:repository`, `read:issue`, `read:user`, `read:organization`, `read:notification`    |
| Typical development (issues, PRs, releases) | `write:repository`, `write:issue`, `read:user`, `read:organization`, `write:notification` |
| Organisation / team administration          | additionally `write:organization`                                                         |

Then tell them to enter the values with `/plugin` → _gitea_ → _Configure_ (or
`claude plugin configure gitea` in a terminal) and to run `/reload-plugins`. Never ask the user to
paste the token into the chat, and never write it to a file yourself.

## 3. Interpret errors

- **UNAUTHORIZED** — the token is wrong, expired or revoked: create a new one and reconfigure.
- **FORBIDDEN mentioning a scope** — the token lacks that scope: create a token that includes it.
- **TLS_ERROR** — the server uses a certificate from a private CA. Ask for the CA certificate as a
  PEM file and set _CA certificate file_ in the plugin options, or enable _Trust the operating
  system CA store_ if the CA is installed system-wide. TLS verification is never turned off; do not
  suggest `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **NETWORK_ERROR / TIMEOUT** — check the URL, VPN or proxy, and that the server is reachable.
- **REDIRECT_BLOCKED** — the configured URL redirects elsewhere (e.g. http→https or a different
  host). Configure the final canonical URL.
- **PERMISSION_DENIED** — the operation level is disabled in the plugin options. Explain what the
  level allows before suggesting to enable it; destructive and admin operations still require a
  confirmation for every call.

## 4. Several Gitea servers

For more than one server, the user can point _Profiles file_ to a JSON file such as:

```json
{
  "default": "work",
  "profiles": {
    "work": { "url": "https://git.example.com", "tokenEnv": "GITEA_WORK_TOKEN" },
    "home": {
      "url": "https://gitea.home.lan",
      "tokenFile": "~/.config/gitea/home.token",
      "caFile": "~/.config/gitea/home-ca.pem",
      "readOnly": true
    }
  }
}
```

Tokens are referenced by environment variable (`tokenEnv`) or file (`tokenFile`); plain `token`
fields are rejected. Every tool accepts a `profile` argument to pick a server.

After any change, run `connection_test` again and confirm the result.
