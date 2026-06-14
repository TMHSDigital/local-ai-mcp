<!-- standards-version: 1.10.0 -->

# CLAUDE.md

This file provides guidance for Claude Code when working in this repository.

## Project

Local AI MCP -- Unified MCP server for managing local model runtimes (Ollama, LM Studio, and more): provider-agnostic discovery, lifecycle, hardware-fit, and delegated inference.

**Version:** 0.1.0
**License:** CC-BY-NC-ND-4.0
**Author:** TMHSDigital

## Key paths

- Source: `src/` (TypeScript)
- Provider adapters: `src/providers/` (implement the `Provider` interface, wired into `ProviderManager`)
- Tools: `src/tools/`
- Package manifest: `package.json` (version source of truth)
- Tool list: `mcp-tools.json` (enumerates the MCP tools)
- Docs site: `docs/`
- CI workflows: `.github/workflows/`

## Conventions

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Never manually edit the version in `package.json` -- CI auto-bumps it
- Provider adapters live in `src/providers/` and implement the `Provider` interface, wired into `ProviderManager`; tools live in `src/tools/`
- Keep `mcp-tools.json` in sync with the registered tools

## Testing

```bash
npm run build
npm test
npm run typecheck
```
