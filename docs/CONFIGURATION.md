# Configuration

The plugin is configured through Claude Code's plugin options (`userConfig`). Claude Code shows a
dialog when the plugin is enabled; afterwards use `/plugin` → **gitea** → **Configure**, or from a
terminal:

```bash
claude plugin configure gitea                      # show options and which are unset
claude plugin install gitea@tds-gitea \
  --config gitea_url=https://git.example.com      # set options during installation
```

Enter the token in the interactive dialog rather than on the command line, so it does not end up
in your shell history.

## Options

| Key                   | Type                  | Default | Purpose                                                                                                                                                                              |
| --------------------- | --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gitea_url`           | string                | –       | Base URL of the instance. A trailing `/api/v1` is accepted and stripped. Must be `https://` unless `allow_insecure_http` is on. Must not contain credentials, a query or a fragment. |
| `gitea_token`         | string, **sensitive** | –       | Personal access token. Stored in the platform's secure credential store (macOS Keychain, Windows Credential Manager, libsecret), not in `settings.json`.                             |
| `allow_write`         | boolean               | `true`  | Registers write tools (create/edit).                                                                                                                                                 |
| `allow_destructive`   | boolean               | `false` | Registers deletion tools. Requires `allow_write`.                                                                                                                                    |
| `allow_admin`         | boolean               | `false` | Registers organisation, team, collaborator, protection and webhook management. Requires `allow_write`.                                                                               |
| `ca_file`             | string                | –       | Absolute path to a PEM file with one or more CA certificates to trust in addition to the defaults.                                                                                   |
| `use_system_ca`       | boolean               | `false` | Also trust the operating system's certificate store.                                                                                                                                 |
| `profiles_file`       | string                | –       | JSON file with additional profiles (below).                                                                                                                                          |
| `allow_insecure_http` | boolean               | `false` | Permit `http://` URLs. The token is then sent unencrypted — only for local test instances.                                                                                           |

Tools of a disabled level are **not registered**, so Claude cannot call them. `connection_test`
shows which levels are enabled and how to enable the others. Even when enabled, deletions, merges,
visibility and permission changes need a confirmation for every single call.

## Recommended token scopes

| Use case                            | Scopes                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Read-only (browse, analyse, review) | `read:repository`, `read:issue`, `read:user`, `read:organization`, `read:notification`     |
| Everyday development                | `write:repository`, `write:issue`, `write:user`, `read:organization`, `write:notification` |
| Organisation administration         | additionally `write:organization` (also needed to create repositories in an organisation)  |
| Packages (list, upload, delete)     | additionally `write:package` (`read:package` to only list them)                            |

Gitea assigns creating a repository under your own account to the **user** scope (`write:user`), and creating one in an organisation to `write:organization`; `write:repository` alone is not enough for that.

`connection_test` probes the read scopes without side effects. Missing write scopes are reported
with a hint when a write tool is used.

## Multiple Gitea servers (profiles)

Point `profiles_file` to a JSON file:

```json
{
  "default": "work",
  "profiles": {
    "work": {
      "url": "https://git.example.com",
      "tokenEnv": "GITEA_WORK_TOKEN"
    },
    "home": {
      "url": "https://gitea.home.lan",
      "tokenFile": "~/.config/gitea/home.token",
      "caFile": "~/.config/gitea/home-ca.pem",
      "readOnly": true
    }
  }
}
```

- `tokenEnv` — name of an environment variable available to Claude Code; `tokenFile` — absolute
  path (or `~/…`) of a file containing only the token. Plain `token` fields are rejected so that
  secrets do not end up in configuration files.
- `readOnly: true` blocks every non-read tool for that profile.
- The server configured in the plugin options is the profile `default` and takes precedence.
- Select a profile per call with the `profile` argument, e.g. _"list my repositories on home"_.

An example is in [`examples/profiles.example.json`](../examples/profiles.example.json).

## Environment variables

The MCP server reads these variables. Claude Code sets the first group from the plugin options;
the rest can be set in the environment Claude Code is started from.

| Variable                                                            | Set from                | Description                                                                    |
| ------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `GITEA_URL`, `GITEA_TOKEN`                                          | plugin options          | default profile                                                                |
| `GITEA_ALLOW_WRITE`, `GITEA_ALLOW_DESTRUCTIVE`, `GITEA_ALLOW_ADMIN` | plugin options          | operation levels                                                               |
| `GITEA_CA_FILE`, `GITEA_USE_SYSTEM_CA`, `GITEA_ALLOW_HTTP`          | plugin options          | TLS and transport                                                              |
| `GITEA_PROFILES_FILE`                                               | plugin options          | additional profiles                                                            |
| `GITEA_WORKDIR`                                                     | `${CLAUDE_PROJECT_DIR}` | directory used to detect `owner/repo` from git remotes                         |
| `GITEA_DEFAULT_PROFILE`                                             | environment             | overrides the default profile                                                  |
| `GITEA_PROFILE_NAME`                                                | environment             | name of the profile built from `GITEA_URL` (default `default`)                 |
| `GITEA_TIMEOUT_MS`                                                  | environment             | HTTP timeout, 1 000–300 000 (default 30 000)                                   |
| `GITEA_MAX_RETRIES`                                                 | environment             | retries for idempotent requests, 0–10 (default 3)                              |
| `GITEA_LOG_LEVEL`                                                   | environment             | `debug`, `info`, `warn` (default), `error`; logs go to stderr and are redacted |
| `NODE_EXTRA_CA_CERTS`                                               | environment             | standard Node.js variable, also honoured                                       |

## Using the MCP server without the plugin

The server is a plain stdio MCP server and works with any MCP client:

```json
{
  "mcpServers": {
    "gitea": {
      "command": "node",
      "args": ["/path/to/gitea/dist/server.mjs"],
      "env": { "GITEA_URL": "https://git.example.com", "GITEA_TOKEN": "…" }
    }
  }
}
```
