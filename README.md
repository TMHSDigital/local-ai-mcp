# Local AI MCP

**Unified MCP server for managing local model runtimes (Ollama, LM Studio, and more): provider-agnostic discovery, lifecycle, hardware-fit, and delegated inference.**

![License: CC-BY-NC-ND-4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)
![Version](https://img.shields.io/badge/version-0.1.1-blue)
![Type](https://img.shields.io/badge/type-mcp--server-7c3aed)

---

Local AI MCP is an [MCP](https://modelcontextprotocol.io) server that turns your local model runtimes into an agent-callable control plane. It is **operations-first**: its primary job is to discover, inspect, fit, and manage the models running on your own machine. It speaks to runtimes over their local HTTP APIs and exposes one consistent tool surface across them, so an agent does not need to know whether a model lives in Ollama or LM Studio.

The server communicates over **stdio only**. It is a *client* to your local runtimes and never opens a network listener of its own.

## Why an ops-first local-model server

- **Discovery and lifecycle, not just chat.** List what is installed, what is loaded, pull and remove models, load and unload them, and check their fit against your hardware before you commit VRAM to them.
- **Hardware-aware.** `system_resources` and `fit_check` read your real RAM and GPU/VRAM so an agent can pick a model that will actually run, and `suggest_model` ranks candidates by task *and* by what fits.
- **Provider-agnostic.** Every tool takes an optional `provider` argument. Omit it and the tool operates across all detected runtimes, aggregating results per provider.

## Inference is delegation, not chat

The `complete` and `embed` tools exist to **delegate (offload) inference to a local model** for cost control and privacy: keep tokens and data on your own hardware instead of sending them to a hosted API. They are deliberately framed as delegated/offloaded inference primitives, not as a conversational chat surface.

## The provider-adapter model

Each runtime is implemented as an adapter behind a single `Provider` interface (`src/providers/types.ts`) with a uniform method set: `detect`, `health`, `listModels`, `listLoaded`, `modelInfo`, `pull`, `remove`, `load`, `unload`, `complete`, `embed`, and `capabilities`. Adding a runtime means adding one adapter; the tool layer is unchanged.

| Adapter | Default host | Transport | Notes |
|---------|--------------|-----------|-------|
| **Ollama** (`src/providers/ollama.ts`) | `http://localhost:11434` | Native REST + OpenAI-compatible | `load`/`unload` map to Ollama `keep_alive` semantics (`keep_alive` to load, `keep_alive: 0` to unload). `complete`/`embed` use the OpenAI-compatible `/v1` routes. |
| **LM Studio** (`src/providers/lmstudio.ts`) | `http://localhost:1234` | REST (`/api/v0`) + OpenAI-compatible | Uses the `lms` CLI for `load`/`unload`/`pull`/`remove` when present; falls back to REST for `listModels`/`listLoaded`/`complete`/`embed`. |

**Auto-detection:** on each call the server probes the configured local endpoints to determine which runtimes are live. Hardware probing is isolated in `src/hardware/` and branches by platform (Windows / Linux); it exposes total/free RAM and, where detectable, GPU name and VRAM.

## Tool surface (16 tools)

### Discovery
| Tool | Description |
|------|-------------|
| `list_providers` | Configured runtimes, their host, live/detected status, and capabilities. |
| `list_models` | Installed models across detected providers (or one provider). |
| `list_loaded` | Models currently resident in memory. |
| `model_info` | Detailed metadata for a model. |

### Lifecycle
| Tool | Description |
|------|-------------|
| `pull_model` | Download a model. **Heavy: may transfer multiple GB.** |
| `remove_model` | Delete a model from disk. **Destructive: requires `confirm: true` and a `provider` (no fan-out); refuses without `confirm: true`.** |
| `load_model` | Load a model into memory (Ollama `keep_alive`; LM Studio `lms load`). |
| `unload_model` | Evict a model from memory. |

### Ops
| Tool | Description |
|------|-------------|
| `health_check` | Liveness and version per provider. |
| `system_resources` | Total/free RAM, CPU count, and GPU/VRAM. |
| `fit_check` | Whether a model fits in free VRAM (GPU) or RAM (CPU), with the numbers. |
| `benchmark` | Measure latency and tokens/sec with one small completion. **Heavy: runs real inference.** |

### Registry
| Tool | Description |
|------|-------------|
| `search_available` | Search a curated catalog of well-known models (Ollama library oriented). |
| `suggest_model` | Recommend a model for a task, ranked by what fits your detected hardware. |

### Delegation (offloaded inference)
| Tool | Description |
|------|-------------|
| `complete` | Delegate a completion to a local model (cost/privacy offload, not chat). |
| `embed` | Delegate embedding generation to a local model. |

Every tool except `system_resources` accepts an optional `provider` (`ollama` \| `lmstudio`). Omit it to operate across all detected runtimes.

## Install and run

```bash
npx @tmhs/local-ai-mcp
```

### Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "local-ai": {
      "command": "npx",
      "args": ["-y", "@tmhs/local-ai-mcp"],
      "env": {
        "OLLAMA_HOST": "http://localhost:11434",
        "LMSTUDIO_HOST": "http://localhost:1234"
      }
    }
  }
}
```

## Configuration

All configuration is via environment variables with sane defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama base URL (scheme optional; added if missing). |
| `LMSTUDIO_HOST` | `http://localhost:1234` | LM Studio base URL. |
| `LOCAL_AI_REQUEST_TIMEOUT_MS` | `120000` | Timeout for normal requests (inference, pull progress, etc.). |
| `LOCAL_AI_DETECT_TIMEOUT_MS` | `1500` | Timeout for provider auto-detection probes. |
| `LOCAL_AI_PULL_TIMEOUT_MS` | `3600000` | Timeout for model pulls (multi-GB downloads); set `0` to disable. |

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest; runs fully offline (mocked HTTP, stubbed hardware)
```

The test suite requires **no running runtime and no downloaded model**: every HTTP call is mocked and hardware probing is stubbed.

## License

CC-BY-NC-ND-4.0 -- see [LICENSE](LICENSE).

---

**Built by TMHSDigital**
