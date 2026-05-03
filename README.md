# Seniorify Plugins

Plugins that bring Seniorify's Socratic plan-audit into your AI coding tool.

> **Status**: v0.2.0 in development on the `feat/claude-code-surface` branch.
> The published v0.1.0 plugin (a simpler `/audit`-skill-only release) lives
> in [`mbrian23/seniorify-dev`](https://github.com/mbrian23/seniorify-dev)
> for hackathon use; this repo evolves the next iteration.

## What this is

When you ship AI-assisted code, the *thinking* is the part that's easy to
skip. Seniorify is a plan-auditor — a senior engineer that asks the one
pertinent question a senior would ask, before any code is written. You
defend, override, or amend the plan. The dialog is the durable record;
managers and instructors see judgment-growth signals across their teams.

## Plugins in this repo

| Plugin | Status | Path |
|---|---|---|
| `seniorify` (Claude Code) | v0.2.0-dev | [`plugins/seniorify/`](./plugins/seniorify) |

Cursor, Codex, Gemini CLI, Kiro, and Vercel AI SDK Skills support is on
the roadmap — see [seniorify.dev](https://seniorify.dev).

## Install

```bash
# Add this repo as a Claude Code marketplace
/plugin marketplace add mbrian23/seniorify-dev-plugins
/plugin install seniorify
```

You'll need a Seniorify account. The plugin is free to install + use; the
audit service (backend question-generation, manager dashboard, retention)
is the metered SaaS. Set your API key per the in-tool prompt or:

```bash
export SENIORIFY_API_KEY="sk_…"
```

## Development

```bash
pnpm install
pnpm run validate                  # check manifests + marketplace integrity
pnpm run build:hooks               # YAML hook source → JSON
cd plugins/seniorify && npm test   # unit + contract tests
```

The test suite has three workspaces:

- `unit` — pure functions
- `contract` — surface contracts (MCP tools, hook decision protocol)
- `integration` — end-to-end against a Docker-compose'd Seniorify backend
  (Constitution §II — no mocking the backend in integration tests)

## Repo shape

```
.claude-plugin/marketplace.json   # this marketplace's registry
plugins/
  seniorify/
    .claude-plugin/plugin.json    # plugin manifest
    hooks/claude.yaml             # hook source (built to hooks.json by build:hooks)
    src/                          # PreToolUse hook + MCP server + clients
    tests/
schemas/                          # JSON schemas for plugin + marketplace manifests
src/                              # build/validate/scaffold scripts
templates/                        # plugin template for `pnpm scaffold`
```

## License

[Elastic License 2.0](./LICENSE) — source-available, free to install and
use (commercial or personal). You may not offer this plugin as a managed
service to third parties, and you may not strip Seniorify branding or
license keys.

This repo is built on the [AI Plugin Marketplace
Template](https://github.com/mike-north/ai-plugin-marketplace-template)
by Mike North (MIT). See [`NOTICE`](./NOTICE) for attribution.

## Drift policy

Plan-audit drift records for breaking changes live in the private core
repo. User-facing CHANGELOGs follow in each plugin directory.
