<!-- standards-version: 1.10.0 -->

# AGENTS.md

This file tells AI coding agents how the Local AI MCP repo works and how to contribute correctly.

## Repository overview

This is an MCP server. It contains:

- **`src/`** -- TypeScript source code
- **`package.json`** -- npm package manifest (version source of truth)

## Branching and commit model

- **Single branch**: `main` only. No develop/release branches.
- **Conventional commits** are required. The release workflow parses them:
  - `feat:` or `feat(scope):` -- triggers a **minor** version bump
  - `feat!:` or `BREAKING CHANGE` -- triggers a **major** version bump
  - Everything else (`fix:`, `chore:`, `docs:`, etc.) -- triggers a **patch** bump
- Commit messages should be concise and describe the "why", not the "what".

## CI/CD workflows

### `validate.yml` (runs on PR and push to main)

Checks:
- TypeScript compilation
- Lint checks
- Test suite

### `release.yml` (runs on push to main, ignores docs/md changes)

Automatic flow:
1. Reads current version from `package.json`
2. Determines bump type from conventional commit messages since last tag
3. Computes new semver version
4. Updates version files and README badge
5. Commits with `[skip ci]`, creates git tag and GitHub Release

### `pages.yml` (deploys docs/ to GitHub Pages)

Builds and deploys the documentation site on push to main.

### `stale.yml`

Marks issues/PRs as stale after 30 days of inactivity.

## Version management

- The **source of truth** for the current version is `package.json`.
- The release workflow auto-bumps it and the README badge on every qualifying push to main.
- Never manually change the version.

## Code conventions

- No hardcoded credentials -- CI scans for password/token/api_key patterns.
- Skills must have YAML frontmatter starting with `---`.
- Rules use `.mdc` extension with frontmatter.

## Adding content


## License

CC-BY-NC-ND-4.0. All contributions fall under this license.
