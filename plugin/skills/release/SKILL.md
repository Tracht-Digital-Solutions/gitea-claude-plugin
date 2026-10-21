---
name: release
description: Prepare and publish a release on Gitea — determine the next semantic version from Conventional Commits since the last release, generate release notes, create the tag and release (optionally as draft or pre-release), upload assets, or compare two releases. Use for "create a release for this repository", "what changed since the last release?" or "compare the last two releases".
argument-hint: "[version or bump: major|minor|patch] [owner/repo]"
---

# Releases

Arguments: $ARGUMENTS

## Compare releases

For "compare the last two releases" (or two given tags) call `release_compare` of the gitea MCP
server and summarise: time between them, number of commits by type, breaking changes, notable
features and fixes, changed areas of the code. Stop there unless a new release is wanted.

## Create a release

1. **Current state** — `release_get` (latest) and `tag_list` to find the last version; check that
   the default branch is green with `commit_status_get` (warn if not).
2. **Next version** — call `release_notes_generate` with a provisional tag and the target branch.
   Derive the semantic version bump from the grouped commits unless the user specified one:
   breaking changes → major (minor while < 1.0.0), features → minor, otherwise patch. Keep the
   existing tag format (e.g. a `v` prefix).
3. **Confirm** — show the proposed version and the release notes and ask the user to confirm or
   edit them. Ask whether it should be a draft or a pre-release (`-rc.N`, `-beta.N` are detected as
   pre-releases automatically).
4. **Publish** — `release_create` with `tag`, `target`, `name` and the confirmed `body`
   (or `generate_notes: true`). Use `draft: true` when the user wants to review it in the web UI
   first.
5. **Assets** — upload build artifacts the user names with `release_asset_upload` (files must be
   inside the working directory).
6. Report the release link.

Publishing a draft later: `release_update` with `draft: false`.
