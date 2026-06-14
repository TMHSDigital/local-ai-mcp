<!-- standards-version: 1.10.0 -->

# CLAUDE.md

This file provides guidance for Claude Code when working in this repository.

## Project

Local AI MCP -- Unified MCP server for managing local model runtimes (Ollama, LM Studio, and more): provider-agnostic discovery, lifecycle, hardware-fit, and delegated inference.

**Version:** 0.1.0
**License:** CC-BY-NC-ND-4.0
**Author:** TMHSDigital

## Key paths

- Source: `src/`
- Package manifest: `package.json`
- Docs site: `docs/`
- CI workflows: `.github/workflows/`

## Conventions

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Never manually edit the version in package.json -- CI handles it
- All skills need YAML frontmatter with title, description, globs
- All rules need frontmatter with description, globs, alwaysApply

## Testing

```bash
# Run validation
python3 -c "import json; json.load(open('.cursor-plugin/plugin.json'))"
```
