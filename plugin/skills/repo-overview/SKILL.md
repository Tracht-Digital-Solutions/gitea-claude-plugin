---
name: repo-overview
description: Give an overview of Gitea repositories or the health of one repository — list or search the user's repositories, and for a single repository report activity, open issues and pull requests, latest release, CI results, branch protection, community files, access rights and concrete improvement suggestions. Use for "show my Gitea repositories", "how healthy is this repo?" or "audit repository settings".
argument-hint: '[owner/repo | search term]'
---

# Repository overview

Arguments: $ARGUMENTS

## Many repositories

Without a specific repository, call `repo_list` of the gitea MCP server (or `repo_search` for a
search term, `owner` for an organisation). Present a compact table: name, visibility, description,
last update, open issues/PRs, archived/fork flags. Point out archived, empty or long inactive
repositories.

## One repository

1. `repo_analyze` — metadata, languages, activity, issues/PRs, latest release, Actions results,
   branch protection, community files and suggestions.
2. If access is relevant (public repository, many collaborators, an audit request), add
   `repo_permissions_analyze`.
3. For CI problems mentioned there, offer the ci-failures workflow; for many open issues, offer the
   issue-triage workflow.

Report the findings as a short health summary followed by prioritised, concrete suggestions.
Change settings (`repo_update`, `branch_protection_set`, `repo_topics_set` …) only when the user
asks; protection and permission changes require the admin operation level and a confirmation.
