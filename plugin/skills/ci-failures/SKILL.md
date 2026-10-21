---
name: ci-failures
description: Diagnose failed Gitea Actions workflow runs — find the failed runs, jobs and steps, extract the relevant log errors, relate them to the workflow configuration and recent code changes, propose a fix and optionally re-run the jobs. Use for "show the failed Gitea Actions runs", "why is CI red?" or "fix the pipeline".
argument-hint: '[owner/repo] [branch]'
---

# Failed Gitea Actions runs

Arguments: $ARGUMENTS

## 1. Find the failures

Call `actions_failures_analyze` of the gitea MCP server (pass `branch` if given). It returns the
latest failed runs with their failed jobs, failed steps, error lines and the end of each log. If it
reports UNSUPPORTED, the Gitea version has no Actions API: tell the user and stop.

If nothing failed recently, say so and show the latest runs with `actions_run_list`.

## 2. Understand the cause

- Read the workflow with `actions_workflow_get` (or the local `.gitea/workflows/*.yml`).
- Fetch more log context with `actions_job_logs` (`tail_lines` or `full: true`) when the error
  lines are not conclusive.
- Relate the failure to recent changes: `commit_list` for the branch, `compare` between the last
  green run's `head_sha` and the failing one.
- Distinguish code failures (tests, build, lint) from infrastructure problems (runner offline,
  network, missing secrets, expired tokens) and flaky failures.

## 3. Report and fix

Explain the root cause in a few sentences with the decisive log lines. Propose a concrete fix; if
the repository is checked out locally, implement it on request and verify locally where possible.

## 4. Re-run (only when asked)

`actions_run_rerun` with `mode: failed` re-runs only the failed jobs (`all` for the whole run);
`actions_workflow_dispatch` starts a workflow with a `workflow_dispatch` trigger. Then check the
new run with `actions_run_get`.
