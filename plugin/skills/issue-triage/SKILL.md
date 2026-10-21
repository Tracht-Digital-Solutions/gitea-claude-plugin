---
name: issue-triage
description: Analyse and triage the issues of a Gitea repository — summarise all open issues or tasks by priority, label, assignee, milestone and age, find stale, duplicate or unlabelled issues, and propose (then, with consent, apply) labels, priorities, assignees and milestones. Use for "analyse all open issues", "show all open tasks of the project" or "triage the backlog".
argument-hint: '[owner/repo] [focus, e.g. bugs or milestone v1.0]'
---

# Issue analysis and triage

Arguments: $ARGUMENTS

## 1. Overview

Call `issues_summary` of the gitea MCP server (default: open issues). If the user gave a focus,
pass `labels` or `milestone`. Present:

- total open issues and the split by priority, label, assignee and milestone
- age distribution and stale issues (no activity for 30+ days)
- the most important open tasks (`top_priority`)
- milestones with their progress (`milestone_list`)

## 2. Details where needed

Use `issue_list` with filters (`priority`, `labels`, `assigned_to`, `query`, `milestones`) and
`issue_get` for issues whose content matters for the triage. For work across all repositories of
the user, use `issue_search` (e.g. `assigned: true`).

If the repository (or its organisation) uses project boards, `project_list` and `project_get`
show which issues are in which column (e.g. backlog, in progress, done); include that status.

## 3. Triage proposal

Propose, as a compact table, per issue: suggested priority, labels, assignee or milestone, and
possible duplicates (similar titles/bodies) or issues that can be closed. Use only labels that
exist (`label_list`); suggest new labels separately.

## 4. Apply (only with consent)

Ask before changing anything. Then use `issue_labels`, `issue_assign`, `issue_update` (milestone,
due date), `issue_comment_create`, and `project_issue_add` / `project_issue_move` for board columns. Close issues with `issue_set_state` only when the user agreed
for each one, and leave a short comment explaining why. Summarise what was changed.
