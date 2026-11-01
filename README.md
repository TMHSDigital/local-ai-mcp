# Local AI MCP

**One MCP server for every local model runtime on your machine. It knows what fits your GPU, and it never sends a prompt to the cloud unless you tell it to.**

[![npm](https://img.shields.io/npm/v/@tmhs/local-ai-mcp?color=7c3aed)](https://www.npmjs.com/package/@tmhs/local-ai-mcp)
[![CI](https://github.com/TMHSDigital/local-ai-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TMHSDigital/local-ai-mcp/actions/workflows/ci.yml)
![License: CC-BY-NC-ND-4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)
![Type](https://img.shields.io/badge/type-mcp--server-7c3aed)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=local-ai&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0bWhzL2xvY2FsLWFpLW1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF?logo=visualstudiocode)](https://insiders.vscode.dev/redirect/mcp/install?name=local-ai&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tmhs%2Flocal-ai-mcp%22%5D%7D)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-.mcpb_bundle-d97757)](https://github.com/TMHSDigital/local-ai-mcp/releases/latest)

Local AI MCP gives your agent (Claude, Cursor, VS Code, and others) one control plane for **Ollama, LM Studio, llama.cpp, Docker Model Runner, MLX, vLLM and Foundry Local**. Your agent can see what's installed and loaded, check what will actually fit in your VRAM, get models ready, and hand work off to the best local model with a single `delegate` call.

```text
# illustrative session
You:    Summarise these 40 pages of meeting notes locally, I don't want them in the cloud.
Agent:  → delegate { task: "summarize", prompt: "...", contextLength: 32768 }
        ← routing: ollama / qwen3:14b — already loaded (no load cost); general model; fits: gpu
          local: true · 412 tokens · 38 tok/s
```

## Why use it

- **It knows your hardware.** `fit_check` sizes the KV cache from the model's actual layer architecture, adds up VRAM across GPUs, models partial GPU/CPU offload, and understands Apple Silicon unified memory. It answers "will this model run, and where?" with numbers rather than guesses.
- **It works across runtimes.** If you run Ollama *and* LM Studio, each call goes to the runtime that actually has the model. Lifecycle actions such as pull, load and unload affect exactly one runtime.
- **It keeps data local by default.** Hosted providers such as Moonshot are opt-in, and a call without a `provider` argument never uses one. Every result reports `provider`, `host` and `local`, so you can see where inference ran.
- **It handles operations, not just chat.** Pull with progress, load with a context size, evict least-recently-used models to make room, benchmark time-to-first-token and tokens per second, and search Hugging Face for GGUF quantizations that fit your machine.

## Things to ask your agent

- "What can I run for coding on this laptop?" → `suggest_model`, then `ensure_model`
- "Free up my GPU." → `list_loaded`, then `unload_model` (or use the `free-vram` prompt)
- "Benchmark my installed coder models and tell me which is fastest." → `benchmark { models: [...] }`
- "Find a newer Gemma build that fits my 12 GB card." → `search_models { source: "huggingface" }`
- "Extract the invoice fields from this text as JSON, locally." → `delegate { task: "extract", responseFormat: { type: "json_schema", ... } }`
- "Will Llama 3.1 70B run here with 32K context?" → `fit_check { model, contextLength: 32768 }`

## Quick start

Install at least one runtime ([Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [llama.cpp](https://github.com/ggml-org/llama.cpp), Docker Model Runner, MLX, vLLM or Foundry Local), then add the server to your client. No configuration is needed for runtimes on their default ports.

**Claude Code**

```bash
claude mcp add local-ai -- npx -y @tmhs/local-ai-mcp
```

**Claude Desktop.** Download the `.mcpb` file from the [latest release](https://github.com/TMHSDigital/local-ai-mcp/releases/latest) and open it. You get a settings screen for hosts and no JSON to edit. Alternatively, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-ai": { "command": "npx", "args": ["-y", "@tmhs/local-ai-mcp"] }
  }
}
```

**Cursor / VS Code.** Use the install buttons above, or add the same `command`/`args` to `.cursor/mcp.json` or `.vscode/mcp.json` (VS Code uses a top-level `"servers"` key instead of `"mcpServers"`).

**Windsurf, Cline, Zed and other clients.** Any stdio MCP client works: the command is `npx`, the args are `["-y", "@tmhs/local-ai-mcp"]`.

> **Windows:** a few clients can't launch `npx` directly. If the server doesn't start, use `"command": "cmd", "args": ["/c", "npx", "-y", "@tmhs/local-ai-mcp"]`.

**Adding a hosted provider (optional).** Put `MOONSHOT_API_KEY` in the server's `env`. It is only used when a tool call names `provider: "moonshot"`, unless you also set `LOCAL_AI_ALLOW_HOSTED_FALLBACK=1`.

## Supported runtimes

| Runtime | Enabled | Default host | List / loaded | Pull | Load / unload | Remove | Embed | Notes |
|---|---|---|---|---|---|---|---|---|
| **Ollama** | always | `localhost:11434` | ✓ / ✓ | ✓ progress | ✓ (`keep_alive`, `num_ctx`) | ✓ | ✓ | Native `/api/chat`: `contextLength` sets `num_ctx`, exact timings, JSON-schema `format` |
| **LM Studio** | always | `localhost:1234` | ✓ / ✓ | ✓ via `lms` | ✓ via `lms` (TTL, context) | ✓ via `lms` | ✓ | Lifecycle needs the [`lms` CLI](https://lmstudio.ai/docs/cli); without it, models load on first request |
| **llama.cpp** (`llama-server`) | always | `localhost:8080` | ✓ / ✓ (`/slots`) | – | – | – | ✓ | One model per server; start with `--embeddings` for `embed` |
| **Docker Model Runner** | always | `localhost:12434` | ✓ / – | ✓ progress | on first request | ✓ | ✓ | Enable host-side TCP support in Docker Desktop |
| **MLX** (`mlx_lm.server`) | `MLX_HOST` | – | ✓ / – | – | on first request | – | – | Apple Silicon; switches models per request |
| **vLLM** | `VLLM_HOST` | – | ✓ / ✓ | – | – | – | ✓ | `health_check` reports KV-cache usage and queue depth from `/metrics` |
| **Foundry Local** | `FOUNDRY_LOCAL_HOST` | dynamic port | ✓ / ✓ | ✓ progress | ✓ (TTL) | – | – | Find the port with `foundry service status` |
| **OpenAI-compatible** (Jan, LocalAI, …) | `OPENAI_COMPAT_HOST` | – | ✓ / ✓ | – | – | – | ✓ | Local or hosted, inferred from the host |
| **Moonshot AI (Kimi)** | `MOONSHOT_API_KEY` | `api.moonshot.ai/v1` | ✓ / – | – | – | – | – | **Hosted**: never selected implicitly |

You can run more than one instance of a runtime, for example a second Ollama box on your LAN, with `LOCAL_AI_PROVIDERS='[{"type":"ollama","name":"ollama-gpu2","host":"http://192.168.1.20:11434"}]'`. Use `LOCAL_AI_DISABLE=lmstudio,dockermodelrunner` to skip probing runtimes you don't use.

## Privacy model

- Each provider is either **local** or **hosted**. The kind is inferred from its host: loopback, private LAN ranges, `*.local`, Tailscale CGNAT and `host.docker.internal` count as local. You can override it per instance in `LOCAL_AI_PROVIDERS`.
- With no `provider` argument, `complete`, `embed`, `delegate`, `benchmark`, `load_model` and the other model-scoped tools only consider **live local** providers that have the model. If the model exists only on a hosted provider, the call fails and tells you how to opt in.
- Hosted providers are never probed on routine calls. Only `health_check` contacts them.
- `search_models` with `source: "huggingface"` queries the Hugging Face Hub, and only when you ask it to. Set `LOCAL_AI_DISABLE_NETWORK_SEARCH=1` to forbid it.
- The server uses **stdio only**. It never opens a network listener.

## Tools (19)

Every tool declares MCP annotations (read-only, destructive, open-world) and an output schema, and returns structured content.

| Group | Tool | What it does |
|---|---|---|
| Discovery | `list_providers` | Configured runtimes: kind (local/hosted), live status, capabilities |
| | `list_models` | Installed models on each live provider |
| | `list_loaded` | Models resident in memory, with VRAM use and context length |
| | `model_info` | Family, size, quantization, context length and layer architecture |
| Lifecycle | `pull_model` | **Heavy.** Downloads to one provider, streaming progress notifications |
| | `remove_model` | **Destructive.** `provider` is required; asks you directly through MCP elicitation when the client supports it, otherwise needs `confirm: true` |
| | `load_model` / `unload_model` | One provider, with optional `keepAlive` and `contextLength` |
| | `ensure_model` | Pull (if allowed), fit check, evict others (`lru` / `all`), load and verify. `dryRun` returns the plan only |
| Ops | `health_check` | Reachability, version, runtime metrics |
| | `system_resources` | RAM and GPUs (NVIDIA, AMD, Intel, Apple Silicon), each tagged with its data source |
| | `fit_check` | Returns `gpu` / `partial` / `cpu` / `none` for a model at a given context length and KV-cache precision |
| | `benchmark` | **Heavy.** Warmup, then N runs: time-to-first-token, generation and prompt tokens/sec. `models: [...]` to compare |
| Registry | `search_available` | Built-in offline catalog |
| | `suggest_model` | Best models for a task on *this* machine: largest that fits on the GPU first, flags installed ones |
| | `search_models` | Live Hugging Face GGUF search with per-quantization fit and pull references (`hf.co/<repo>:<quant>`) |
| Delegation | `complete` | Run a completion on a model you choose: system prompt, JSON / JSON-schema output (validated), seed, sampling, images, `contextLength` |
| | `embed` | Embeddings, always one vector per input |
| | `delegate` | **One call:** picks the best local model for a task (loaded, then installed and fitting, then optionally pulled), runs it, and explains the choice |

**Resources:** `local-ai://system`, `local-ai://loaded` (subscribable; updates when models load or unload), and `local-ai://models/{provider}`.
**Prompts:** `setup`, `free-vram`, `benchmark-my-models`, `pick-model`.

## Configuration

Every setting is an environment variable, and blank means the default. See [`.env.example`](.env.example) for the full annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST`, `LMSTUDIO_HOST`, `LLAMACPP_HOST`, `DOCKER_MODEL_RUNNER_HOST` | standard local ports | Always-on runtimes |
| `MLX_HOST`, `VLLM_HOST` (+`VLLM_API_KEY`), `FOUNDRY_LOCAL_HOST`, `OPENAI_COMPAT_HOST` (+`OPENAI_COMPAT_API_KEY`) | unset | Opt-in runtimes |
| `LOCAL_AI_PROVIDERS` | unset | JSON array of extra instances `{type, host, name?, apiKey?, kind?}` |
| `LOCAL_AI_DISABLE` | unset | Comma-separated types or names to skip |
| `MOONSHOT_API_KEY`, `MOONSHOT_HOST` | unset, `https://api.moonshot.ai/v1` | Hosted Moonshot provider |
| `LOCAL_AI_ALLOW_HOSTED_FALLBACK` | off | Let calls without a `provider` use hosted providers |
| `LOCAL_AI_DISABLE_NETWORK_SEARCH` | off | Forbid Hugging Face search |
| `LOCAL_AI_REQUEST_TIMEOUT_MS` | `120000` | Non-streamed requests |
| `LOCAL_AI_DETECT_TIMEOUT_MS` | `1500` | Detection probes |
| `LOCAL_AI_PULL_TIMEOUT_MS` | `3600000` | Downloads (`0` = no limit) |
| `LOCAL_AI_STREAM_IDLE_TIMEOUT_MS` | `60000` | Abort a stream only if no token arrives for this long |
| `LOCAL_AI_STREAM_MAX_MS` | `1800000` | Hard cap on a streamed completion (`0` = none) |
| `LOCAL_AI_CACHE_TTL_MS` | `10000` | Detection and model-list cache |

## Troubleshooting

- **A provider isn't detected.** Run `health_check`. Check the host and port. From WSL, use the Windows host IP. From a container, use `host.docker.internal`. For Docker Model Runner, enable host-side TCP support.
- **LM Studio pull/load fails with "requires the lms CLI".** Install the `lms` CLI as described in the [LM Studio CLI docs](https://lmstudio.ai/docs/cli) so it is on `PATH`, then restart your MCP client.
- **llama.cpp `embed` fails.** Start `llama-server` with `--embeddings` and an embedding-capable model.
- **Answers about long inputs look truncated (Ollama).** Pass `contextLength` (it sets `num_ctx`). The result includes a warning when truncation is likely.
- **"was not found on any live local provider".** The model is either not installed (check `list_models`) or only available on a hosted provider. Name that provider explicitly to use it.
- **macOS memory numbers look low.** `system_resources` reports *available* memory (free, inactive and purgeable pages) and the Metal working-set limit, not total RAM.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # vitest, fully offline (mocked HTTP, stubbed hardware)
npm run lint        # Biome
npm run typecheck   # src and tests
npm run gen:tools   # regenerate mcp-tools.json after changing tools
npm run smoke       # boot the built server over stdio
```

CI runs on Linux, Windows and macOS with Node 22 and 24, plus a Node 20 runtime check. A nightly workflow tests the adapters against real Ollama and llama.cpp. See [CONTRIBUTING.md](CONTRIBUTING.md), including **Adding a runtime adapter**.

## Support

Questions and ideas go in [Discussions](https://github.com/TMHSDigital/local-ai-mcp/discussions). Report bugs with the issue templates, and security problems through [private reporting](https://github.com/TMHSDigital/local-ai-mcp/security/advisories/new). If this saves you time, consider [sponsoring](https://github.com/sponsors/TMHSDigital).

## License

CC-BY-NC-ND-4.0. See [LICENSE](LICENSE). Contributions are accepted under the DCO and the inbound grant described in [CONTRIBUTING.md](CONTRIBUTING.md).

---

**Built by TMHSDigital**
<!-- standards-version: 1.10.0 -->
