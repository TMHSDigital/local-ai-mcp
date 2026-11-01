<!-- standards-version: 1.10.0 -->

# AGENTS.md

This file tells AI coding agents how the Local AI MCP repo works and how to contribute correctly.

**This repository is public.** Never commit secrets, API keys, tokens, private hostnames, or filled-in `.env` files. `.gitignore` covers the usual locations; keep it that way.

## Repository overview

This is an MCP server (TypeScript, stdio only, no network listener). It contains:

- **`src/index.ts`**: stdio entry point; **`src/server.ts`**: `createServer` (used by the entry point, tests, and `scripts/`)
- **`src/providers/`**: runtime adapters implementing `Provider` (`types.ts`) via `BaseProvider` / `OpenAICompatibleProvider` (`base.ts`); `manager.ts` creates them, caches detection, and routes (`select`)
- **`src/tools/`**: MCP tools, resources (`local-ai://…`) and prompts
- **`src/fit.ts`**: KV-cache and VRAM fit math; **`src/hardware/`**: per-OS GPU/RAM probes
- **`src/catalog/`**: curated catalog and Hugging Face GGUF search
- **`mcp-tools.json`**: generated list of tools (`npm run gen:tools`); CI fails if it is stale
- **`server.json`** / **`mcpb/manifest.json`**: MCP Registry entry and Claude Desktop extension manifest
- **`scripts/`**: `gen-tools.mjs`, `smoke.mjs`, `integration.mjs`, `sync-version.mjs`
- **`docs/`**: GitHub Pages site; **`CHANGELOG.md`**: release history

## Invariants

- Implicit routing (no `provider` argument) only selects **live local** providers that have the model. Go through `ProviderManager.select()`.
- Inference results report `provider`, `host`, and `local`.
- Lifecycle tools act on exactly one provider; `remove_model` requires an explicit provider and user confirmation (elicitation, or `confirm: true` when the client cannot elicit).
- Subprocesses go through `runCommand` (`src/exec.ts`): async, with a timeout, stdin closed, no shell.
- API keys never appear in results, logs, or errors.

## Branching and commit model

- **Single branch**: `main` only. No develop/release branches.
- **Conventional commits** are required. Use them to choose the version bump:
  - `feat:` or `feat(scope):`: bump the **minor** version
  - `feat!:` or a `BREAKING CHANGE` trailer: bump the **major** version once at 1.0.0 or later; **before 1.0.0, breaking changes bump the minor** (semver for 0.x)
  - everything else (`fix:`, `chore:`, `docs:`, etc.): bump the **patch** version

  Apply the bump with `npm version <patch|minor|major> --no-git-tag-version`. It keeps `package.json`, the lockfile, `server.json`, and `mcpb/manifest.json` in sync. `release.yml` tags and publishes that version on merge.
- Commit messages should be concise and describe the "why", not the "what".

## CI/CD workflows

### `ci.yml` (PRs and pushes to main)

- Lint (Biome), typecheck (src and tests), `npm audit --omit=dev --audit-level=high`, and the `mcp-tools.json` freshness check
- Tests on Linux, Windows, and macOS with Node 22 and 24, with coverage thresholds on one leg, plus a stdio smoke test
- A Node 20 runtime smoke job (the package supports Node 20; the test toolchain needs 22)

### `integration.yml` (nightly and manual)

Runs `scripts/integration.mjs` against pinned real Ollama and llama.cpp containers with tiny models. Opens an issue on failure.

### `release.yml` (push to main)

If `package.json` has a version with no matching tag, it creates `v<version>` (plus floating `vMAJOR` / `vMAJOR.MINOR`) and a GitHub Release, then dispatches `publish.yml`.

### `publish.yml` (release published or manual)

Runs lint, typecheck, build, tests, and smoke, then publishes to npm with provenance, builds and attaches the Claude Desktop `.mcpb` bundle, and publishes `server.json` to the MCP Registry (GitHub OIDC).

### `drift-check.yml`, `pages.yml`, `stale.yml`, `label-sync.yml`

- `drift-check.yml`: ecosystem standards drift check.
- `pages.yml`: deploys `docs/`.
- `stale.yml`: only closes `needs-info` issues after 90 days; triaged backlog is exempt.
- `label-sync.yml`: labels PRs by path (`provider`, `tools`, `hardware`, `testing`, `documentation`, `ci`).

## Adding content

### New provider adapter

See CONTRIBUTING.md → "Adding a runtime adapter". In short:

1. Implement it in `src/providers/` (extend the base classes), with honest `capabilities()`
2. Add the id to `PROVIDER_IDS`, a `case` in `createProvider`, and env vars in `config.ts` and `.env.example`
3. Add it to the conformance suite and write runtime-specific tests
4. Use the `feat:` commit prefix

### New tool

1. Register it in `src/tools/` with `registerTool`, `annotations`, and an `outputSchema`
2. Run `npm run gen:tools` and commit `mcp-tools.json`
3. Add tests in `src/__tests__/tools.test.ts` (real MCP client over an in-memory transport)
4. Use the `feat:` commit prefix

## License

CC-BY-NC-ND-4.0, with inbound contributions under the DCO and grant described in CONTRIBUTING.md.
