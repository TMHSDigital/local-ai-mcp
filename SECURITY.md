# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.** This repository is public.

Report privately through GitHub's private vulnerability reporting:
**https://github.com/TMHSDigital/local-ai-mcp/security/advisories/new**

Please include:

1. A description of the vulnerability and its impact
2. Steps to reproduce (tool calls, configuration, runtime versions)
3. Any suggested fix

We aim to acknowledge reports within 48 hours and to agree a timeline for a fix and coordinated disclosure.

## Scope

Local AI MCP is a stdio MCP server. It opens no network listener of its own. In scope:

- Anything that sends prompts, embeddings, or other data to a provider the user did not choose (for example, a hosted API used without being named explicitly).
- Command or argument injection through the runtime CLIs it invokes (`lms`, `nvidia-smi`, `powershell`, `sysctl`, …).
- Leaking API keys (`MOONSHOT_API_KEY`, `OPENAI_COMPAT_API_KEY`, `VLLM_API_KEY`, …) into tool results, logs, or errors.
- Destructive actions (such as `remove_model`) running without the confirmation the server is meant to require.

Out of scope: vulnerabilities in the model runtimes themselves (report those upstream), and behaviour of the models you run.

## Supported versions

Only the latest release receives security fixes.
