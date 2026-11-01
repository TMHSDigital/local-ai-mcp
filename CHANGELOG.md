# Changelog

All notable changes to Local AI MCP are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/). Bump the version in
each PR (following conventional-commit intent); on merge the release workflow
tags that version and publishes it.

## [Unreleased]

## [0.5.0] - 2026-10-31

### Breaking

- Calls without a `provider` argument never use a **hosted** provider such as
  Moonshot unless `LOCAL_AI_ALLOW_HOSTED_FALLBACK=1` is set. Moonshot is only
  registered when `MOONSHOT_API_KEY` is set. Results now report `provider`,
  `host`, and `local`.
- `complete`, `embed`, `benchmark`, `load_model`, and `unload_model` run on
  the provider that has the model. `pull_model`, `load_model`, and
  `unload_model` act on exactly one provider; they no longer fan out.
- The tool `provider` argument is now a provider *instance name* (defaults
  equal the runtime type).
- `Provider` interface methods take a `RequestOptions` object (`timeoutMs`,
  `signal`) instead of a positional timeout.
- `fit_check` results gained `partial` as a target and new fields
  (`kvEstimate`, `gpuAvailableBytes`, `ramAvailableBytes`, `gpuFraction`, ...).

### Added

- New runtimes: **Docker Model Runner** (on by default, port 12434),
  **MLX** (`MLX_HOST`), **vLLM** (`VLLM_HOST`, with `/metrics` in
  `health_check`), and **Foundry Local** (`FOUNDRY_LOCAL_HOST`). Multiple
  instances via `LOCAL_AI_PROVIDERS`; skip runtimes with `LOCAL_AI_DISABLE`.
- `delegate`: picks the best local model for a task (loaded, then installed
  and fitting, then optionally pulled), runs it, and explains the choice.
- `ensure_model`: pull (opt-in), fit check, LRU/all eviction, load, verify;
  `dryRun` returns the plan.
- `search_models`: Hugging Face GGUF search with per-quant sizes, the best
  quant for this machine, and `hf.co/<repo>:<quant>` pull references.
- `complete`: `system`, JSON / JSON-Schema `responseFormat` with a validated
  `parsed` result, `seed`, `topP`, `topK`, `repeatPenalty`, `contextLength`,
  `options`, and image inputs for vision models.
- `pull_model` streams download progress (with totals) as MCP progress.
- `benchmark`: warmup, N runs, time-to-first-token, runtime-measured
  generation and prompt speed, median/p90, multi-model comparison.
- macOS / Apple Silicon hardware probe (unified memory, Metal working set,
  `vm_stat` available memory); AMD VRAM on Linux (sysfs); 64-bit VRAM on
  Windows (registry). GPUs report their data source.
- MCP resources (`local-ai://system`, `local-ai://loaded` with
  subscriptions, `local-ai://models/{provider}`) and prompts (`setup`,
  `free-vram`, `benchmark-my-models`, `pick-model`).
- Tool titles, annotations (read-only / destructive / open-world), output
  schemas, and structured content. `remove_model` confirms with the user
  through elicitation when the client supports it.
- Distribution: MCP Registry `server.json`, a Claude Desktop `.mcpb` bundle
  attached to each release, and one-click install links in the README.

### Fixed

- `fit_check` KV-cache estimate was about 16x too small. It is now exact from
  model architecture (Ollama `/api/show`), with a corrected heuristic
  otherwise, support for quantized KV, multi-GPU totals, partial offload, and
  credit for an already-loaded model.
- Ollama prompts were silently truncated: completions now use native
  `/api/chat` so `contextLength` sets `num_ctx`, with a truncation warning.
- Streamed completions (the default) reported no token usage.
- MCP cancellation now stops inference and downloads. Streams use an idle
  timeout (`LOCAL_AI_STREAM_IDLE_TIMEOUT_MS`) instead of a total cap.
- LM Studio lifecycle and hardware probes no longer block the event loop
  (async subprocesses with timeouts and closed stdin). `lms` runs
  non-interactively, and model ids that look like flags are rejected.
- The llama.cpp embedding fallback dropped every input after the first.
- `suggest_model` ranked the *smallest* fitting model first.
- Provider detection is cached (`LOCAL_AI_CACHE_TTL_MS`), so tool calls no
  longer probe every runtime, or call a hosted API, each time.
- Blank host variables (e.g. `OLLAMA_HOST=`) now fall back to defaults.

### Changed

- zod 4, `@modelcontextprotocol/sdk` 1.32, vitest 5; `npm audit` is clean.
- CI: Biome lint, typecheck of tests, Linux/Windows/macOS x Node 22/24,
  coverage thresholds, `mcp-tools.json` drift check, stdio smoke test, Node
  20 runtime check, and a nightly integration run against real runtimes.
  Third-party actions are pinned by SHA.
- Stale bot only closes `needs-info` issues; triaged work is exempt.
- Hardened `.gitignore`; `.gitattributes` enforces LF.

## [0.4.0] - 2026-07-18

### Added

- `llamacpp` provider: first-class llama.cpp server adapter using native
  `/health`, `/props`, `/slots` plus OpenAI-compatible `/v1` routes
  (`LLAMACPP_HOST`, default `http://localhost:8080`).
- `openaicompat` provider: generic OpenAI-compatible local adapter, opt-in via
  `OPENAI_COMPAT_HOST` (and optional `OPENAI_COMPAT_API_KEY`) for vLLM, Jan, and
  similar `/v1` servers.
- Expanded curated model catalog (llama3.3, qwen3, gemma3, phi4, deepseek-r1
  sizes, mistral-nemo/small, more embed/vision/code entries).
- Shared `PROVIDER_IDS` / `providerIdZod` so tool schemas stay in sync.

### Changed

- Deferred macOS hardware probe out of the v0.3 checklist into a Deferred
  section on the roadmap.

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
