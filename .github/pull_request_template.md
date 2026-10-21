## What and why

<!-- Describe the change and its motivation. Link issues with "Closes #123". -->

## How was it tested?

- [ ] `npm run check`
- [ ] `npm run test:integration` (for changes to tools or the HTTP client)

## Checklist

- [ ] Conventional Commit title (`feat:`, `fix:`, `docs:` …)
- [ ] New or changed tools use only documented Gitea endpoints and have the right access level / confirmation
- [ ] `docs/TOOLS.md` regenerated (`npm run docs:tools`) if tools changed
- [ ] No secrets or tokens in code, tests or fixtures
