<!-- standards-version: 1.10.0 -->

# CLAUDE.md

This file provides guidance for Claude Code when working in this repository.

## Project

Local AI MCP: one MCP server for local model runtimes (Ollama, LM Studio, llama.cpp, Docker Model Runner, MLX, vLLM, Foundry Local, any OpenAI-compatible server, and opt-in hosted Moonshot). It covers discovery, lifecycle, hardware fit, and delegated inference, and is local-first by default.

**Version:** see `package.json` (source of truth; do not hardcode it here)
**License:** CC-BY-NC-ND-4.0
**Author:** TMHSDigital

This repository is **public**: never commit secrets, tokens, private hostnames, or filled-in `.env` files.

## Key paths

- Entry point: `src/index.ts` (stdio); server wiring: `src/server.ts` (`createServer`)
- Provider adapters: `src/providers/`. Each implements `Provider` (`types.ts`), usually by extending `BaseProvider` / `OpenAICompatibleProvider` (`base.ts`), and is created in `createProvider` (`manager.ts`)
- Routing and caching: `ProviderManager` (`src/providers/manager.ts`). `select()` is the only way to pick a provider implicitly, and it never picks hosted providers unless `LOCAL_AI_ALLOW_HOSTED_FALLBACK` is set
- Tools: `src/tools/` (registered with `registerTool`, annotations, and output schemas); resources and prompts: `src/tools/resources.ts`
- Fit math: `src/fit.ts`; hardware probes: `src/hardware/`
- Generated tool list: `mcp-tools.json` (`npm run gen:tools`)
- Release metadata: `server.json` (MCP Registry), `mcpb/manifest.json` (Claude Desktop bundle), kept in sync by `npm version`
- Docs site: `docs/`; CI workflows: `.github/workflows/`

## Conventions

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Bump the version with `npm version <bump> --no-git-tag-version` (syncs the lockfile, `server.json`, and `mcpb/manifest.json`); `release.yml` tags and publishes on merge
- After changing tools, run `npm run gen:tools` and commit `mcp-tools.json`
- New env vars must be listed in `.env.example` (a test enforces this)
- New adapters must be added to the conformance suite (`src/__tests__/conformance.test.ts`)

## Testing

```bash
npm run build
npm test            # offline; mocked HTTP and stubbed hardware
npm run lint
npm run typecheck   # src and tests
npm run smoke       # boots dist/index.js over stdio
```
