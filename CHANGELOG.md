# Changelog

All notable changes to Local AI MCP are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/). Bump the version in
each PR (following conventional-commit intent); on merge the release workflow
tags that version and publishes it.

## [Unreleased]

## [0.3.0] - 2026-07-18

### Added

- Streaming delegated `complete`: providers request OpenAI-compatible SSE
  when streaming is enabled (default). Token deltas are forwarded as MCP
  `notifications/progress` when the client supplies a `progressToken`.
  Pass `stream: false` for a single non-streamed response.
- KV-cache-aware `fit_check`: estimates context overhead from parameter size
  and an optional `contextLength` (default 4096), returning weight/kv/required
  bytes in the result. `suggest_model` uses the same estimate.
- Docs site catch-up: Moonshot adapter row, full environment variable list,
  streaming/`fit_check` descriptions.

### Changed

- Shared OpenAI-compatible completion helper used by Ollama, LM Studio, and
  Moonshot adapters.

## [0.2.1] - 2026-07-18

### Changed

- Expanded `ROADMAP.md` to reflect shipped v0.2.0 and outline concrete
  milestones through v1.0.0 (streaming, macOS hardware, llama.cpp, ops depth).

## [0.2.0] - 2026-07-16

### Added

- Moonshot AI (Kimi) provider adapter (`moonshot`): the first hosted,
  OpenAI-compatible provider behind the same `Provider` interface. Configured
  via `MOONSHOT_API_KEY` (Bearer auth, required) and `MOONSHOT_HOST` (default
  `https://api.moonshot.ai/v1`). Supports `complete`, `listModels`,
  `modelInfo`, `health_check`, and detection; lifecycle operations and `embed`
  are intentionally unsupported for the hosted API. Flagship model: `kimi-k3`.
- `.env.example` documenting all environment variables with placeholders.

### Changed

- README now frames the server as local-first with optional hosted providers,
  instead of exclusively local offload.

## [0.1.2] - 2026-06-14

### Changed

- Release chain is now PAT-free: `release.yml` uses the default `GITHUB_TOKEN`
  to push tags and create the GitHub Release, then explicitly dispatches
  `publish.yml` (a `GITHUB_TOKEN` release does not auto-trigger it). Removed the
  dependency on `RELEASE_PAT`, which was read-only and could not push.

## [0.1.1] - 2026-06-14

### Changed

- Docs and metadata now describe an MCP server (provider adapters, tool
  registration, stdio transport, npx install) instead of cursor-plugin
  boilerplate.
- Adopted a tag-only release model compatible with the protected `main` branch:
  bump the version in your PR; `release.yml` tags it and creates the release,
  and `publish.yml` builds, tests, and publishes (skipping a version already on
  npm). CI never writes to `main`.

### Fixed

- `pull_model` no longer aborts multi-GB downloads at the default request
  timeout; it uses a dedicated, longer pull timeout
  (`LOCAL_AI_PULL_TIMEOUT_MS`, default 1 hour).
- `remove_model` now requires an explicit `provider` so a confirmed delete
  cannot fan out across every detected runtime at once.

### Added

- `npm` Dependabot ecosystem alongside the existing GitHub Actions ecosystem.

## [0.1.0] - 2026-06-14

Initial release, published to npm as
[`@tmhs/local-ai-mcp`](https://www.npmjs.com/package/@tmhs/local-ai-mcp).

### Added

- Provider-agnostic MCP server (stdio transport only) for managing local model
  runtimes.
- Ollama and LM Studio provider adapters behind a common `Provider` interface,
  with auto-detection of live runtimes.
- 16 tools across discovery, lifecycle (confirm-gated `remove_model`,
  multi-GB-warning `pull_model`), ops (`system_resources`, `fit_check`,
  `benchmark`), registry (`search_available`, `suggest_model`), and delegated
  inference (`complete`, `embed`).
- Platform-isolated hardware probing (total/free RAM, GPU name and VRAM).
- Offline test suite (mocked HTTP, stubbed hardware).
- CI/CD workflows (ci, release, publish, drift-check, pages, stale, label-sync).
- GitHub Pages documentation site.
