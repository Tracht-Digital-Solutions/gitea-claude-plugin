# Gitea plugin for Claude Code

Connects Claude Code to any Gitea instance — gitea.com or a self-hosted server. A bundled MCP
server provides 154 tools for repositories, files, branches, commits, tags, issues, labels,
milestones, project boards, pull requests and reviews, organisations, teams and collaborators, Gitea Actions
(runs, jobs, logs, re-runs, artifacts), releases and assets, webhooks and notifications. Seven
skills guide common workflows: setup, pull request from local changes, pull request review, issue
triage, CI failure analysis, releases and repository overviews.

Install:

```bash
claude plugin install gitea --marketplace jtracht/claude-code-gitea
# or inside Claude Code:
/plugin marketplace add jtracht/claude-code-gitea
/plugin install gitea@jtracht-gitea
```

Configure the Gitea server URL and a personal access token in `/plugin` → gitea → Configure. The
token is kept in the operating system's credential store. Destructive and administrative
operations are disabled by default and always require confirmation. Node.js 22.19 or newer must be
on the PATH.

Documentation: https://github.com/jtracht/claude-code-gitea
