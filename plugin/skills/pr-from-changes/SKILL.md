---
name: pr-from-changes
description: Turn local changes into a Gitea pull request — commit (with the user's consent), create or reuse a feature branch, push it, and open a pull request with a generated title and description, reviewers and labels. Use when the user says things like "create a pull request from my changes", "open a PR on Gitea" or "push this and make a PR".
argument-hint: '[base-branch] [extra instructions]'
---

# Pull request from local changes

Arguments (optional): $ARGUMENTS

## 1. Understand the local state

Call `local_repo_context` of the gitea MCP server. From the result determine:

- the Gitea repository (`remotes[].giteaRepo`) — if no remote points to the configured Gitea
  server, ask which repository to use
- current branch, upstream, ahead/behind counts, uncommitted files

## 2. Commit (only with consent)

If there are uncommitted changes, show a short summary (`git status`, `git diff --stat`) and ask
whether to commit them and with which scope. Use Conventional Commit messages (`feat:`, `fix:`,
`docs:` …) that describe the change. Do not commit files that look like secrets (`.env`, keys,
tokens) — point them out instead.

## 3. Branch

If the current branch is the default branch (see `repo_get` → `default_branch`) create a feature
branch locally first (`git switch -c <type>/<short-topic>`). Never push directly to the default
branch for this workflow.

## 4. Push

Call `local_branch_push` (it never force-pushes and uses the user's git credentials). If the push
is rejected, explain why (e.g. the remote branch has diverged) and stop.

## 5. Write the pull request

Inspect the changes relative to the base branch (`git log` / `git diff <base>...HEAD`, or the
`compare` tool). Write:

- **Title**: Conventional-Commit style, imperative, ≤ 72 characters
- **Body**: what changed and why, notable implementation details, how it was tested, and any
  follow-ups. Reference issues with `Closes #123` when the user mentions them or the branch/commits
  do.

Check `pr_list` with `state: open` for an existing pull request from the same head branch; if one
exists, offer to update it with `pr_update` instead of creating a duplicate.

## 6. Create and report

Call `pr_create` with `head`, `base` (argument or default branch), title and body. Add `reviewers`,
`labels` or `milestone` only if the user asked for them or they are obvious from context (use
`label_list` to pick existing labels). Report the PR number and link, and offer to run
`pr_merge_check`.
