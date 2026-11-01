# Roadmap

**Current:** see the [npm version](https://www.npmjs.com/package/@tmhs/local-ai-mcp) and [CHANGELOG](CHANGELOG.md)

## Local AI MCP

### v0.1.x: Foundation (shipped)

- [x] Core provider adapters (Ollama, LM Studio)
- [x] Initial tool surface (discovery, lifecycle, ops, registry, delegated inference)
- [x] stdio transport, CI/CD workflows, GitHub Pages site
- [x] Platform-isolated hardware probing (Windows, Linux)
- [x] Offline test suite (mocked HTTP, stubbed hardware)

### v0.2.0: Hosted expansion (shipped)

- [x] Moonshot AI (Kimi) adapter behind the same `Provider` interface
- [x] `.env.example` documenting all environment variables

### v0.3.0: Streaming + fit (shipped)

- [x] Streaming delegated `complete` via MCP progress notifications
- [x] KV-cache-aware `fit_check`

### v0.4.0: More local runtimes (shipped)

- [x] Generic OpenAI-compatible adapter and first-class llama.cpp adapter
- [x] Expanded model catalog

### v0.5.0: Local-first router + ops depth (shipped)

- [x] Hosted providers are never used implicitly; results report where inference ran
- [x] Model-aware routing across runtimes; lifecycle acts on one provider
- [x] Accurate fit: architecture-exact KV cache, multi-GPU, partial offload, quantized KV
- [x] macOS / Apple Silicon hardware probe; AMD (Linux) and 64-bit Windows VRAM
- [x] Docker Model Runner, MLX, vLLM, Foundry Local adapters; multiple instances
- [x] `delegate`, `ensure_model` (evict-to-fit), `search_models` (Hugging Face GGUF)
- [x] Pull progress, cancellation, idle-timeout streaming, richer `benchmark`
- [x] Structured output, tool annotations, elicitation-confirmed deletes, resources and prompts
- [x] MCP Registry listing, Claude Desktop `.mcpb` bundle, one-click installs
- [x] Cross-OS CI, lint, coverage, nightly integration against real runtimes

### v0.6.0: Smarter delegation

- [ ] Learn per-machine speed: cache `benchmark` results and use them in `delegate` ranking
- [ ] Quality-aware routing (task-specific evals on small fixtures) beyond size as a proxy
- [ ] Background pull jobs (`pull_status`) for clients that don't render progress
- [ ] Second hosted provider, capability-honest (complete-only is acceptable)
- [ ] More adapters by request: LocalAI, KoboldCpp, Lemonade, llamafile

### v1.0.0: Stable release

- [ ] Freeze the `Provider` interface (`src/providers/types.ts`) under semver discipline
- [ ] Freeze tool names, arguments, and output schemas
- [ ] Multi-page documentation site with a generated tool reference from `mcp-tools.json`

## Non-goals

- No chat UI: `complete`/`embed`/`delegate` are delegated-inference primitives, not a conversational surface
- stdio only: no HTTP/SSE transport through 1.0
- No network listener: the server stays a client to your runtimes
