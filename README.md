# ContextOS

Context management platform for AI coding agents. MCP server, Feature Packs, Context Packs, and policy enforcement.

## What Is This

ContextOS sits between human architects and AI coding agents (Claude Code, Cursor, Copilot). It ensures agents:

1. **Receive project context before coding** — Feature Packs deliver architecture decisions, constraints, and prior work via MCP
2. **Follow policies during coding** — The Policy Engine blocks or warns on disallowed tool use via Claude Code HTTP hooks
3. **Produce traceable records after coding** — Context Packs capture what was built, what decisions were made, and what changed

One MCP server, all agents. MCP is the universal protocol; hooks provide deterministic enforcement where MCP alone cannot.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Entry Points: Claude Code | Cursor | VS Code + Copilot        │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────────────┐
│ Integration Protocol                                                 │
│  MCP Server (all agents)  │  Hooks Bridge (Claude Code)  │  Fallback│
└──────────────────────┬───────────────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────────────┐
│ Core Services                                                        │
│  Pack Service │ Context Pack │ Policy Engine │ NL Assembly │ Sem Diff│
└──────────────────────┬───────────────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────────────┐
│ Storage: PostgreSQL + pgvector │ Redis │ Local SQLite (VS Code ext)  │
└──────────────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
apps/
  mcp-server/         # MCP Server — TypeScript, @modelcontextprotocol/sdk, Streamable HTTP
  hooks-bridge/       # Claude Code HTTP Hooks Bridge — TypeScript, Hono
  web/                # Web App — Next.js 15, React 19
  vscode/             # VS Code Extension
packages/
  db/                 # Database schema + migrations — Drizzle ORM, PostgreSQL 16 + pgvector
  shared/             # Shared types, Zod schemas, utilities
services/
  nl-assembly/        # NL Assembly — Python 3.12, FastAPI, sentence-transformers, pgvector
  semantic-diff/      # Semantic Diff — Python 3.12, FastAPI, tree-sitter, Anthropic Claude
docs/
  feature-packs/      # Module specs: spec.md, implementation.md, techstack.md (01–07)
  context-packs/      # Context Pack records from completed work
  DEVELOPMENT.md      # Development guide
```

## Quick Start

```bash
# Prerequisites: Node.js 22+, pnpm 9+, Docker, uv (Python)

# Clone and install
git clone git@github.com:Abishai95141/contextos.git
cd contextos
pnpm install
cp .env.example .env

# Start infrastructure
docker compose up -d

# Run migrations
pnpm db:migrate

# Build
pnpm build

# Verify
pnpm typecheck
pnpm lint
pnpm test:unit
```

## Development

```bash
pnpm dev               # Start all TypeScript services in dev mode
pnpm build             # Build all packages
pnpm typecheck         # Type check all packages
pnpm lint              # Biome lint + format check
pnpm test:unit         # Unit tests (Vitest)
pnpm test:integration  # Integration tests (testcontainers + real DB)
pnpm test:e2e          # E2E tests (full lifecycle)
pnpm db:migrate        # Run database migrations
pnpm db:generate       # Generate migration from schema changes
```

Python services:

```bash
cd services/nl-assembly && uv run uvicorn src.main:app --reload --port 3200
cd services/semantic-diff && uv run uvicorn src.main:app --reload --port 3201
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Monorepo | Turborepo + pnpm | Fast builds with remote caching, workspace protocol |
| MCP Server | TypeScript + @modelcontextprotocol/sdk | Tier 1 SDK, Streamable HTTP, receives protocol updates first |
| Hooks Bridge | TypeScript + Hono | TypeScript-native, <200ms latency, app.request() testing |
| Web App | Next.js 15 + React 19 | App Router, Server Components, streaming |
| Database | PostgreSQL 16 + pgvector | Relational + vector search in one engine |
| ORM | Drizzle | Native pgvector support, SQL-like API, 5KB bundle |
| NL Assembly | Python + FastAPI + sentence-transformers | No TypeScript equivalent for embedding quality |
| Semantic Diff | Python + FastAPI + tree-sitter | Mature AST parsing ecosystem |
| Validation | Zod (TS) + Pydantic (Python) | Runtime type safety at all service boundaries |
| Job Queue | BullMQ | Rate limiting for LLM APIs, job flows, retries |
| Cache | Redis + ioredis | Session state, idempotency keys, rate limiting |
| Logging | pino | 5-10x faster than winston, structured JSON |
| Testing | Vitest (TS) + pytest (Python) | 5.6x faster than Jest, native ESM |
| Linting | Biome | Replaces ESLint + Prettier, 100x faster |
| CI/CD | GitHub Actions + Turborepo remote cache | Parallel jobs, Docker image builds, E2E gates |
| Python Packages | uv | 10-100x faster than pip, lockfile, Docker-friendly |

## Feature Pack Documentation

Each module has detailed specs in `docs/feature-packs/`:

| Module | Spec | Status |
|--------|------|--------|
| [01 — Foundation](docs/feature-packs/01-foundation/) | Monorepo, DB schema, auth, CI/CD | Skeleton complete |
| [02 — MCP Server](docs/feature-packs/02-mcp-server/) | 6 tools, 3 resources, Streamable HTTP | Spec ready |
| [03 — Hooks Bridge](docs/feature-packs/03-hooks-bridge/) | 4 hooks, Policy Engine, Run Recorder | Spec ready |
| [04 — Web App](docs/feature-packs/04-web-app/) | Pack editor, archive, run history, dashboard | Spec ready |
| [05 — NL Assembly](docs/feature-packs/05-nl-assembly/) | Embeddings, semantic search, pgvector | Spec ready |
| [06 — Semantic Diff](docs/feature-packs/06-semantic-diff/) | AST parsing, LLM summarization | Spec ready |
| [07 — VS Code Extension](docs/feature-packs/07-vscode-extension/) | Commands, SQLite cache, offline support | Spec ready |

## AI Agent Instructions

**Read [CLAUDE.md](CLAUDE.md) before working on this codebase.** It contains development rules, implementation order, testing requirements, and code patterns that all AI agents must follow.

## License

Private — not yet open source.
