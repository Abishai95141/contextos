# ContextOS

Context management platform for AI coding agents. MCP server, Feature Packs, Context Packs, and policy enforcement.

## Architecture

ContextOS is an MCP server. MCP is the universal protocol for all major agentic IDEs as of early 2026. Feature Packs are delivered as MCP Resources. Context Packs are captured via MCP Tools and Claude Code HTTP hooks. Policies are enforced at the MCP tool call layer.

## Structure

```
packages/
  mcp-server/     # ContextOS MCP Server (HTTP transport)
  hooks-bridge/   # Claude Code HTTP Hooks Bridge
  db/             # Database schema + migrations (Drizzle ORM)
  shared/         # Shared types and utilities
apps/
  web/            # Next.js web app (coordination surface)
  vscode/         # VS Code extension
```

## Quick Start

```bash
# Prerequisites: Node.js 22+, pnpm 9+, Docker

# Clone and install
pnpm install

# Start local services (Postgres + Redis)
docker compose up -d

# Run database migrations
pnpm db:migrate

# Build all packages
pnpm build

# Start development
pnpm dev
```

## Development

```bash
pnpm build        # Build all packages
pnpm dev          # Start all dev servers
pnpm typecheck    # Type check all packages
pnpm test         # Run all tests
pnpm db:migrate   # Run database migrations
pnpm db:generate  # Generate new migration from schema changes
```

## Tech Stack

- **Runtime:** Node.js 22, TypeScript 5.7
- **Monorepo:** Turborepo + pnpm workspaces
- **Database:** PostgreSQL 16 + pgvector
- **Cache:** Redis 7
- **Web:** Next.js 15, React 19
- **ORM:** Drizzle ORM
- **Auth:** Clerk (planned)

## License

Private — not yet open source.
