# Contributing to Local AI MCP

Thank you for your interest in contributing. Questions are welcome in [Discussions](https://github.com/TMHSDigital/local-ai-mcp/discussions); please don't open issues for "how do I…".

## Getting started

1. Fork the repository and create a feature branch from `main`
2. `npm install`
3. Make your changes following the conventions below
4. Run the checks: `npm run lint && npm run typecheck && npm test`
5. Open a pull request (the template has a checklist)

The test suite runs fully offline. Every HTTP call is mocked and hardware probing is stubbed, so you don't need any runtime installed.

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature, provider adapter, or tool
- `fix:` bug fix
- `docs:` documentation changes
- `chore:` maintenance, dependency updates
- `refactor:` code restructuring

Bump the version in your PR with `npm version <patch|minor|major> --no-git-tag-version`. This keeps `package-lock.json`, `server.json` (MCP Registry) and `mcpb/manifest.json` (Claude Desktop extension) in sync. CI tags and publishes on merge.

### Tools

- Register the tool in `src/tools/` with `server.registerTool`, including a `title`, accurate `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) and an `outputSchema`
- Return results with `ok()` so clients get `structuredContent`
- Run `npm run gen:tools` and commit the regenerated `mcp-tools.json`; CI fails if it is stale
- Add tests in `src/__tests__/tools.test.ts`, which drives the real server through an MCP client

### Privacy rules

- Implicit routing (no `provider` argument) must only ever pick **local** providers. Use `ProviderManager.select()`; never pick `providers[0]`.
- Results of inference tools must report `provider`, `host` and `local`.
- Never log or return API keys, even in error messages.

## Adding a runtime adapter

1. **Read the runtime's API docs** and decide which capabilities it supports: list, loaded, pull, remove, load, unload, complete, embed.
2. **Create `src/providers/<runtime>.ts`.** If the runtime speaks the OpenAI REST shape, extend `OpenAICompatibleProvider` from `base.ts` and override only what differs (`v1()`, `detect`, `listModels`, lifecycle). Otherwise extend `BaseProvider`. Unsupported operations should be left to the base class, which throws `UnsupportedOperationError`.
3. **Declare capabilities honestly** in `capabilities()`. Tools filter on them.
4. **Register it:** add the id to `PROVIDER_IDS` in `types.ts`, a `case` in `createProvider` (`manager.ts`), and its env var(s) in `config.ts` (use `optionalHost` for opt-in runtimes whose default port collides with others).
5. **Tests:**
   - Add the runtime's host to `HOSTS` in `src/__tests__/conformance.test.ts`. The shared conformance suite checks identity, that `detect`/`health` never throw, unsupported-op errors, embedding counts, and result provenance.
   - Add runtime-specific tests (URL paths, response mapping, progress parsing) using `mockFetch` from `src/__tests__/support.ts`.
6. **Document it:** the runtime table in `README.md`, `.env.example` (a test enforces every env var is listed), `server.json` / `mcpb/manifest.json` if users should configure it, and `CHANGELOG.md`.

## Pull request process

1. CI must pass: lint, typecheck, tests on Linux/Windows/macOS, the coverage threshold, the `mcp-tools.json` check, and the smoke test
2. Update `CHANGELOG.md` for user-facing changes
3. Use a conventional-commit PR title

## Inbound license grant and DCO

This project's outbound license is CC-BY-NC-ND-4.0. Contributions are accepted inbound under a broader grant via the Developer Certificate of Origin (DCO). Both pieces are required because CC-BY-NC-ND-4.0 alone cannot cleanly accept third-party derivatives.

### Required grant

By submitting a contribution to this repository, you certify that you have the right to do so under the Developer Certificate of Origin (DCO) 1.1, and you grant TMHSDigital a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your contribution under the project's current license (CC-BY-NC-ND-4.0) or any successor license chosen by the project.

### DCO sign-off

Every commit in a pull request must carry a `Signed-off-by:` trailer matching the commit author. Sign at commit time with the `-s` flag:

```bash
git commit -s -m "feat: add new tool"
```

This appends a line like `Signed-off-by: Jane Developer <jane@example.com>` to the commit message. The GitHub DCO App enforces this on every PR.

For the full inbound/outbound model and rationale, see [`standards/licensing.md`](https://github.com/TMHSDigital/Developer-Tools-Directory/blob/main/standards/licensing.md) in the Developer-Tools-Directory meta-repo.
