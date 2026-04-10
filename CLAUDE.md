# ContextOS — System Instructions for AI Agents

> **Read this entire file before writing any code.** These instructions are non-negotiable. They apply to every AI agent (Claude Code, Cursor, Copilot) working on this codebase. Violations will produce broken builds, data corruption, or security holes.

---

## Project Overview

ContextOS is an MCP (Model Context Protocol) server platform that provides **Feature Packs**, **Context Packs**, and **policy enforcement** for AI coding agents. It is the coordination layer between human architects and AI agents — ensuring agents receive project context before coding, follow policies during coding, and produce traceable records after coding.

The system has five layers:

```
Layer 0: Agent Entry Points     → Claude Code, Cursor, VS Code + Copilot
Layer 1: Integration Protocol   → MCP Server (universal), Hooks Bridge (Claude Code + Cursor), Context Files (fallback)
Layer 2: Core Services          → Pack Service, Context Pack Service, Policy Engine, NL Assembly, Run Recorder, Semantic Diff
Layer 3: Storage                → Local SQLite Primary Store (sqlite-vec), PostgreSQL + pgvector (cloud sync), Redis
Layer 4: Clients                → VS Code Extension, Web App, CLI (future)
```

**Detailed specs for each module live in `docs/feature-packs/01-07/`.** Read the `spec.md` and `implementation.md` for the module you are working on before writing any code.

---

## Repository Structure

```
apps/
  mcp-server/         # MCP Server — TypeScript, @modelcontextprotocol/sdk, Streamable HTTP
  hooks-bridge/       # Claude Code + Cursor HTTP Hooks Bridge — TypeScript, Hono
  web/                # Web App — Next.js 15, React 19
  vscode/             # VS Code Extension
packages/
  db/                 # Database schema + migrations — Drizzle ORM, PostgreSQL + pgvector
  shared/             # Shared types, Zod schemas, utilities
services/
  nl-assembly/        # NL Assembly — Python, FastAPI, sentence-transformers, pgvector
  semantic-diff/      # Semantic Diff — Python, FastAPI, tree-sitter (sync AST), Anthropic Claude (async enrichment)
docs/
  feature-packs/      # Feature Pack specs (spec.md, implementation.md, techstack.md per module)
  context-packs/      # Context Pack records from completed work
```

---

## Development Rules

### 1. No Shallow Implementations

Every function must be **complete and working**. This means:

- **No `// TODO` stubs** in committed code. If you are implementing a function, implement it fully.
- **No `throw new Error("Not implemented")`** — if a function exists, it works.
- **No mock data in production code** — mocks belong in test files only.
- **No `console.log` for logging** — use the pino logger with structured context.
- If a file requires 500 lines to be correct, write 500 lines. Never truncate.

### 2. No Output Token Shortcuts

This rule exists because AI agents frequently produce incomplete code to save tokens. **Do not do this.**

- Never write `// ... rest of implementation similar to above`. Write every line.
- Never write `// Add remaining endpoints here`. Add them.
- Never produce a partial file and say "I'll continue in the next message". Produce the complete file.
- Every code block you generate must compile and run without modification.
- If a test file needs 20 test cases, write 20 test cases. Not 3 with a comment saying "add more".

### 3. Type Safety Everywhere

- **Zod schemas at all service boundaries.** Every HTTP request body, every MCP tool input, every queue message payload has a Zod schema.
- **Infer TypeScript types from Zod:** `type MyType = z.infer<typeof MySchema>`. Never define a separate TypeScript interface that duplicates a Zod schema.
- **Never use `any`.** If you find yourself reaching for `any`, redesign the interface.
- **Never use `as` type assertions** unless absolutely necessary. If you must, add a comment explaining why the assertion is safe.
- **Python: strict type hints everywhere.** Every function parameter, every return type. Use Pydantic models for all data structures.

### 4. Error Handling is Not Optional

- Every function that performs I/O must handle errors explicitly.
- Use specific error types, not generic `Error`. Define error types in `packages/shared/src/errors/`.
- HTTP handlers return proper status codes: 400 for validation errors, 401/403 for auth, 404 for not found, 409 for conflicts, 500 for unexpected errors.
- Database errors: catch constraint violations explicitly (unique, FK). Return meaningful error messages.
- Never swallow errors silently. `catch (e) {}` is forbidden. At minimum, log the error.
- MCP tools return error content with `isError: true` — never throw from a tool handler.

### 5. Logging at Every Decision Point

Use **pino** for all TypeScript logging. Use Python's **structlog** or **logging** with JSON for Python services.

```typescript
import { logger } from '@contextos/shared';

// Log on function entry with context
logger.info({ projectId, packId, version }, 'Fetching feature pack');

// Log on error with full context
logger.error({ err, projectId, packId }, 'Feature pack fetch failed');

// Log on significant state changes
logger.info({ runId, status: 'completed', durationMs }, 'Run completed');
```

Every log line MUST include:
- **Correlation ID:** `sessionId` or `runId` if available
- **Operation name:** what function/handler is executing
- **Relevant entity IDs:** projectId, packId, policyId, etc.

### 6. Idempotency is Mandatory

Every write operation must be idempotent. If a request is retried (network timeout, agent retry), it must produce the same result, not duplicate data.

- **Run Events:** keyed by `{runId}:{eventType}:{toolName}:{timestamp}` — use `generateIdempotencyKey()` from `@contextos/shared`.
- **Runs:** keyed by `run:{projectId}:{sessionId}:{uuid}` — use `generateRunKey()`.
- **Context Packs:** one per run. If a Context Pack already exists for a run ID, return the existing one.
- **Policy Decisions:** logged with their own idempotency key to prevent duplicate audit entries.
- Database: use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` — never blind `INSERT`.

### 7. Database Migrations are the Source of Truth

- **Never modify the database manually.** No `psql` commands, no Supabase SQL editor.
- All schema changes go through Drizzle: modify `packages/db/src/schema.ts`, then run `pnpm db:generate` to create a migration.
- Migrations are numbered sequentially: `0000_initial.sql`, `0001_add_embeddings_index.sql`, etc.
- Every migration must be reversible in principle. Document what a rollback would require.
- Test migrations against a clean database AND against a database with existing data.

### 8. Testing Requirements

**Every function gets a test. No exceptions.**

| Test Type | Framework | Runs On | What It Tests |
|-----------|-----------|---------|---------------|
| Unit | Vitest (TS), pytest (Python) | Every push | Individual functions in isolation |
| Integration | Vitest + testcontainers | Every PR | Service + real database/Redis |
| E2E | Vitest + MCP SDK client | Main branch | Full lifecycle: session → tools → context pack |

**Unit tests:**
- Cover all public functions. Private functions tested through public API.
- Test success paths AND error paths. A function with 3 error cases needs 3 error tests.
- Use factory functions for test data, not inline objects.
- No `sleep()` calls. Use `vi.useFakeTimers()` or proper async patterns.

**Integration tests:**
- Use `testcontainers` for PostgreSQL (image: `pgvector/pgvector:pg16`).
- Use Hono's `app.request()` for HTTP handler tests — no running server needed.
- Use `@modelcontextprotocol/sdk` Client for MCP server tests — connect in-process.
- Test with real Drizzle queries against a real (containerized) database.

**E2E tests:**
- Full lifecycle: SessionStart hook → Feature Pack injection → tool use → PreToolUse policy check → PostToolUse trace → Stop → Context Pack generation.
- Run against real services (containerized), not mocks.
- Assert on database state, not just HTTP responses.

**Minimum coverage: 80% line coverage.** Check with `pnpm test:unit -- --coverage`.

---

## Implementation Order

Modules MUST be implemented in order. Each module depends on the previous ones.

| Module | Name | Depends On | Feature Pack Spec |
|--------|------|-----------|-------------------|
| 01 | Foundation | — | `docs/feature-packs/01-foundation/` |
| 02 | MCP Server | 01 | `docs/feature-packs/02-mcp-server/` |
| 03 | Hooks Bridge | 01, 02 | `docs/feature-packs/03-hooks-bridge/` |
| 04 | Web App | 01, 02 | `docs/feature-packs/04-web-app/` |
| 05 | NL Assembly | 01, 02 | `docs/feature-packs/05-nl-assembly/` |
| 06 | Semantic Diff | 01, 03 | `docs/feature-packs/06-semantic-diff/` |
| 07 | VS Code Extension | 02, 03, 04 | `docs/feature-packs/07-vscode-extension/` |

**Before starting a module:**
1. Read `spec.md` — understand what you are building and why
2. Read `implementation.md` — follow the step-by-step plan
3. Read `techstack.md` — understand the technology choices

**"Complete" means:**
- All code written and compiling (`pnpm typecheck` passes)
- All tests written and passing (`pnpm test:unit` and `pnpm test:integration`)
- Linting passes (`pnpm lint`)
- Integration with previous modules verified manually
- Context Pack saved to `docs/context-packs/`

---

## Context Pack Protocol

After completing any module or significant feature, you MUST save a Context Pack. This is how knowledge transfers between AI agent sessions.

**Save Context Packs to:** `docs/context-packs/YYYY-MM-DD-module-name.md`

**Template:** `docs/context-packs/template.md`

**What to include:**
- What was built (specific files, functions, endpoints)
- Decisions made (why X instead of Y, with rationale)
- Files created or modified (complete list)
- Tests written (what they cover)
- How integration was verified
- Known issues or limitations
- What should be built next

**This is not optional.** Context Packs are the memory of the project. Without them, the next agent session starts from zero.

---

## Code Style

### TypeScript
- **Formatter/Linter:** Biome (`biome.json` at root). Run `pnpm lint` before committing.
- **Indent:** 2 spaces
- **Quotes:** Single quotes
- **Trailing commas:** Always
- **Line width:** 120 characters
- **Semicolons:** Always
- **Imports:** Organized by Biome (builtin → external → internal)

### Python
- **Formatter:** Ruff (configured in `pyproject.toml`)
- **Type hints:** Mandatory on all functions
- **Docstrings:** Google style
- **Line width:** 120 characters

### Git
- **Commit messages:** Conventional commits
  - `feat: add get_feature_pack MCP tool`
  - `fix: handle null parent_pack_id in inheritance resolution`
  - `test: add integration tests for policy engine`
  - `docs: update MCP server spec with error codes`
  - `chore: update drizzle-orm to 0.38.1`
- **Branch strategy:** Feature branches off `main`. Name: `feat/02-mcp-server-tools`, `fix/policy-engine-null-check`
- **Merge strategy:** Squash merge to `main`. Clean, linear history.

---

## Environment Variables

All env vars are documented in `.env.example`. Copy to `.env` for local development.

```bash
cp .env.example .env
```

**Validation:** Every service validates its required env vars at startup using Zod. If a required variable is missing, the service fails fast with a clear error message. Never use a fallback for secrets.

```typescript
// Example: apps/mcp-server/src/config.ts
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  MCP_SERVER_PORT: z.coerce.number().default(3100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CLERK_SECRET_KEY: z.string().min(1),
});

export const config = envSchema.parse(process.env);
```

---

## CI/CD Pipeline

The pipeline is defined in `.github/workflows/ci.yml`:

```
Every push/PR:
  ├── lint-typecheck     (parallel: biome lint + tsc --noEmit)
  ├── test-unit          (Vitest unit tests, needs lint-typecheck)
  ├── test-integration   (Vitest + real Postgres/Redis, needs lint-typecheck)
  └── test-python        (pytest for nl-assembly + semantic-diff, needs lint-typecheck)

Main branch only (after all above pass):
  ├── test-e2e           (full lifecycle tests)
  └── build-images       (Docker images for mcp-server, hooks-bridge, web)
```

**Before pushing code, always run locally:**
```bash
pnpm lint              # Biome lint + format check
pnpm typecheck         # TypeScript type checking
pnpm test:unit         # Unit tests
```

---

## Key Technical Decisions (ADRs)

### ADR-001: TypeScript MCP SDK over Python
The MCP Server uses the TypeScript SDK (`@modelcontextprotocol/sdk`) with Streamable HTTP transport. TypeScript SDK receives protocol updates first. Monorepo coherence (shared types, shared Zod schemas) outweighs Python's ML advantages at the protocol layer.

### ADR-002: Python for NL Assembly and Semantic Diff Only
Python is used exclusively for services requiring ML inference (sentence-transformers) or AST parsing (tree-sitter). Everything else is TypeScript. This boundary is strict — do not introduce Python in other services.

### ADR-003: Drizzle ORM over Prisma
Drizzle has native pgvector support (vector column types, HNSW indexes, cosine distance functions). Prisma requires raw SQL for pgvector. Since pgvector is central to NL Assembly search, Drizzle is the correct choice.

### ADR-004: Hono over Express/Fastify for Hooks Bridge
Hono is TypeScript-native, has `app.request()` for testing without a running server, and produces minimal bundles. The Hooks Bridge is latency-sensitive (PreToolUse must respond in <200ms) — Hono's low overhead matters.

### ADR-005: Vitest over Jest
Vitest is 5.6x faster cold start in monorepo benchmarks. Native TypeScript/ESM support eliminates Babel/ts-jest config. Jest-compatible API means near-zero learning curve.

### ADR-006: BullMQ for Job Queues
Embedding generation and semantic diff are async, CPU-bound tasks. BullMQ provides rate limiting (critical for LLM API calls), job flows, retries with backoff, and a dashboard. Redis is already in the stack.

### ADR-007: Append-Only Event Store for Context Packs
Context Packs and Run Events are immutable — they are historical records. The append-only constraint prevents accidental data loss and enables event sourcing. Implemented via PostgreSQL with no UPDATE/DELETE permissions on these tables.

### ADR-008: Local-First SQLite as Primary Store
The VS Code extension uses SQLite (`better-sqlite3` + `sqlite-vec`) as the **primary store**, not a cache. Runs, run events, and context packs are written locally first. Cloud PostgreSQL is the team-sync layer — optional for individual developer use. This eliminates the #1 enterprise blocker (data leaving dev machines) and guarantees sub-millisecond reads with zero network dependency.

### ADR-009: Cursor Hook Adapter
Cursor hooks are command-based (stdin/stdout JSON) while Claude Code supports HTTP hooks. ContextOS uses a single adapter script (`.cursor/hooks/contextos.sh`) that reads Cursor's JSON from stdin, normalizes field names (e.g., `conversation_id` → `session_id`), POSTs to the hooks-bridge, and translates the response back to Cursor's stdout format. Same semantics, different transport. See `docs/SYSTEM-DESIGN.md` Section 15 for full adapter specification.

### ADR-010: Graphify Import for Cold-Start
Graphify (`safishamsi/graphify`, MIT license) produces a `graph.json` with tree-sitter AST nodes clustered by Leiden community detection. ContextOS imports this output to seed initial Feature Pack content — each community becomes a Feature Pack section. This solves the cold-start problem (first session runs without context) without requiring manual Feature Pack authoring.

### ADR-011: Policy Engine as Non-Human Identity (NHI) Infrastructure
The policy engine treats AI coding agents as distinct non-human identities. Policy rules include an `agent_type` field (values: `claude_code`, `cursor`, `copilot`, `*`) enabling per-agent permission scoping. Combined with the `policy_decisions` audit table, this positions ContextOS as enterprise access governance for AI agents — not just a context injection tool.

---

## Common Patterns

### Creating a new MCP Tool

```typescript
// apps/mcp-server/src/tools/my-new-tool.ts
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const myNewToolSchema = z.object({
  projectId: z.string().uuid(),
  query: z.string().min(1).max(1000),
});

export type MyNewToolInput = z.infer<typeof myNewToolSchema>;

export async function myNewTool(input: MyNewToolInput) {
  const log = logger.child({ tool: 'my_new_tool', projectId: input.projectId });
  log.info('Tool invoked');

  try {
    const result = await db.query.someTable.findMany({
      where: eq(someTable.projectId, input.projectId),
    });

    log.info({ resultCount: result.length }, 'Tool completed');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    log.error({ err }, 'Tool failed');
    return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
  }
}
```

### Creating a new Hook Handler

```typescript
// apps/hooks-bridge/src/handlers/my-hook.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { logger } from '../lib/logger.js';

const inputSchema = z.object({
  session_id: z.string(),
  hook_event_name: z.literal('MyEvent'),
  // ... fields
});

export const myHookRoute = new Hono().post(
  '/',
  zValidator('json', inputSchema),
  async (c) => {
    const input = c.req.valid('json');
    const log = logger.child({ hook: 'MyEvent', sessionId: input.session_id });
    log.info('Hook received');

    // ... handle

    return c.json({ status: 'ok' });
  },
);
```

### Writing a Test

```typescript
// __tests__/unit/tools/my-new-tool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myNewTool } from '../../../src/tools/my-new-tool.js';

// Mock the database
vi.mock('../../../src/lib/db.js', () => ({
  db: {
    query: {
      someTable: {
        findMany: vi.fn(),
      },
    },
  },
}));

describe('myNewTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results for valid project', async () => {
    const { db } = await import('../../../src/lib/db.js');
    vi.mocked(db.query.someTable.findMany).mockResolvedValue([
      { id: '1', name: 'test' },
    ]);

    const result = await myNewTool({ projectId: 'uuid-here', query: 'test' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('test');
  });

  it('returns error for database failure', async () => {
    const { db } = await import('../../../src/lib/db.js');
    vi.mocked(db.query.someTable.findMany).mockRejectedValue(
      new Error('Connection refused'),
    );

    const result = await myNewTool({ projectId: 'uuid-here', query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused');
  });
});
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `pnpm install` fails | Check Node.js version (`node -v` must be ≥22). Delete `node_modules` and `pnpm-lock.yaml`, re-run. |
| `pnpm typecheck` fails | Run `pnpm build` first — typecheck depends on built packages for type resolution. |
| `pnpm test:integration` fails | Ensure Docker is running. Tests use testcontainers which starts Postgres automatically. |
| pgvector extension not found | Use `pgvector/pgvector:pg16` Docker image, not plain `postgres:16`. |
| Python service won't start | Run `uv sync` in the service directory. Check `pyproject.toml` for correct Python version. |
| MCP client can't connect | Check `MCP_SERVER_PORT` in `.env`. Ensure the server is running (`pnpm --filter @contextos/mcp-server dev`). |
| Hooks bridge returns 500 | Check logs with `pino-pretty`: `pnpm --filter @contextos/hooks-bridge dev | npx pino-pretty`. |
