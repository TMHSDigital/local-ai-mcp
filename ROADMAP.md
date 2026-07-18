<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.2.1

## Local AI MCP

### v0.1.x -- Foundation (shipped)

- [x] Core provider adapters (Ollama, LM Studio)
- [x] Initial tool surface (16 tools: discovery, lifecycle, ops, registry, delegated inference)
- [x] stdio transport
- [x] CI/CD workflows (ci, release, publish, drift-check, pages, stale, label-sync)
- [x] GitHub Pages documentation site
- [x] Platform-isolated hardware probing (Windows, Linux)
- [x] Offline test suite (mocked HTTP, stubbed hardware)

### v0.2.0 -- Hosted expansion (shipped)

- [x] Moonshot AI (Kimi) adapter: first hosted, OpenAI-compatible provider behind the same `Provider` interface
- [x] Local-first framing: hosted providers are explicit opt-in via API key, never auto-detected
- [x] `.env.example` documenting all environment variables

### v0.3.0 -- Streaming + hardware parity

- [ ] Streaming delegated `complete` (MCP progress notifications / chunked results where the SDK allows)
- [ ] macOS hardware probe in `src/hardware/` (RAM + Apple Silicon unified memory / Metal VRAM where detectable)
- [ ] Smarter `fit_check`: account for KV-cache/context overhead, not just weight size
- [ ] Docs site catch-up: Moonshot adapter row, environment variables, current tool count

### v0.4.0 -- More local runtimes

- [ ] Generic OpenAI-compatible local adapter (arbitrary host via config; covers llama.cpp server, vLLM, Jan, and friends)
- [ ] First-class llama.cpp server adapter (native `/health`, `/props`, slot introspection)
- [ ] Expand the model catalog and `search_available` coverage for current model families

### v0.5.0 -- Ops depth

- [ ] Pull progress / long-running operation status for `pull_model`
- [ ] Load/unload policy helpers (e.g. evict-to-fit before loading a model)
- [ ] Richer `benchmark`: multi-prompt runs, tokens/sec plus latency percentiles
- [ ] Second hosted provider, capability-honest (complete-only is acceptable)

### v1.0.0 -- Stable release

- [ ] Freeze the `Provider` interface (`src/providers/types.ts`) under semver discipline
- [ ] Coverage bar for all adapters and tools
- [ ] Generated tool reference from `mcp-tools.json`
- [ ] Multi-page documentation site (install, providers, tools, contributing)

## Non-goals

- No chat UI: `complete`/`embed` are delegated-inference primitives, not a conversational surface
- stdio only: no HTTP/SSE transport through 1.0
- No network listener: the server stays a client to your runtimes
