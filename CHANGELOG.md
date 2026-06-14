# Changelog

All notable changes to Local AI MCP are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/). Versions are bumped
automatically from conventional commits by the release workflow; never edit the
version by hand.

## [Unreleased]

## [0.1.1] - 2026-06-14

### Changed

- Docs and metadata now describe an MCP server (provider adapters, tool
  registration, stdio transport, npx install) instead of cursor-plugin
  boilerplate.
- Rewrote the release workflow to auto-bump from conventional commits and create
  the release with a token that actually triggers publishing; the publish
  workflow now runs on a published release or manual dispatch and skips a
  version that is already on npm.

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
