## What and why

<!-- What does this change, and what problem does it solve? Link issues: Closes #123 -->

## Checklist

- [ ] Conventional commit title (`feat:`, `fix:`, `docs:`, `chore:`, …)
- [ ] Version bumped with `npm version <patch|minor|major> --no-git-tag-version` (also syncs `server.json` and `mcpb/manifest.json`)
- [ ] `CHANGELOG.md` updated for user-facing changes
- [ ] Tools changed? Ran `npm run gen:tools` and committed `mcp-tools.json`
- [ ] New adapter? Added it to `describeProviderConformance` in `src/__tests__/conformance.test.ts`
- [ ] `npm run lint && npm run typecheck && npm test` pass locally
- [ ] Commits are signed off (`git commit -s`, DCO)
- [ ] No secrets, tokens, or private hostnames in code, tests, or fixtures
