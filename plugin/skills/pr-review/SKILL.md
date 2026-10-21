---
name: pr-review
description: Analyse or review a Gitea pull request — summarise the change, inspect the diff for bugs, risks and missing tests, check CI status, existing reviews and merge readiness, and optionally post a review. Use for "analyse the last pull request", "review PR #12" or "is this PR ready to merge?".
argument-hint: '[pr-number] [owner/repo]'
---

# Pull request analysis and review

Arguments: $ARGUMENTS — a pull request number (omit or `0` for the most recently updated one) and
optionally `owner/repo`.

## 1. Collect the facts

Using the gitea MCP server:

1. `pr_get` — title, description, branches, author, size
2. `pr_files` — changed files; for large PRs decide which files matter most
3. `pr_diff` — the patch (use `files` to focus on relevant files when it is large)
4. `pr_commits` — commit structure and messages
5. `pr_reviews` — existing reviews, inline comments and conversation
6. `pr_merge_check` — conflicts, approvals, required status checks and blockers
7. If checks failed, `actions_failures_analyze` with the head branch for the reason

## 2. Analyse

Read the diff carefully. Look for correctness bugs, edge cases, error handling, security issues
(injection, secrets, authorisation), breaking changes, performance problems, missing or weak
tests, and documentation that should change too. Verify claims against the code instead of
guessing; if the local checkout contains the branch you may read files directly.

## 3. Report to the user

- one-paragraph summary of what the PR does
- findings ordered by severity, each with file/line and a concrete suggestion
- merge readiness: blockers and warnings from `pr_merge_check`
- a verdict: approve / request changes / comment

## 4. Post (only when asked)

Only if the user asks to post the review, call `pr_review_create` with the verdict as `event`
(`APPROVED`, `REQUEST_CHANGES` or `COMMENT`), the summary as `body` and findings as inline
`comments` (`path` + `line` in the new file). Never approve or merge on your own initiative.
Merging uses `pr_merge`, which always requires the user's explicit confirmation.
