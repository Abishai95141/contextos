# Feature Pack 01: Foundation

## Overview

The Foundation module establishes the entire ContextOS platform infrastructure. Nothing else can be built before this module is complete. It covers monorepo setup, database schema, authentication scaffolding, environment configuration, local development infrastructure, and CI/CD pipeline foundation.

---

## 1. Monorepo Setup (Turborepo + pnpm)

### Repository Layout

```
contextos/
├── apps/
│   ├── mcp-server/          # TypeScript, @modelcontextprotocol/sdk, Streamable HTTP
│   ├── hooks-bridge/        # TypeScript, Hono framework
│   ├── web/                 # Next.js 15, React 19, App Router
│   └── vscode/              # VS Code Extension
├── packages/
│   ├── db/                  # Drizzle ORM, schema, migrations
│   └── shared/              # Shared TypeScript types + Zod schemas
├── services/
│   ├── nl-assembly/         # Python 3.12, FastAPI, sentence-transformers
│   └── semantic-diff/       # Python 3.12, FastAPI, tree-sitter, Anthropic SDK
├── .github/
│   └── workflows/
│       ├── ci.yml           # PR + push CI pipeline
│       └── deploy.yml       # Staging/production deploy
├── turbo.json               # Turborepo pipeline configuration
├── pnpm-workspace.yaml      # pnpm workspace configuration
├── biome.json               # Biome linter/formatter config
├── docker-compose.yml       # Local dev services (Postgres, Redis)
├── docker-compose.test.yml  # Test infrastructure
└── .env.example             # Environment variable documentation
```

### pnpm-workspace.yaml

Defines three workspace roots so `pnpm` understands the monorepo structure:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'services/*'
```

### turbo.json Pipeline

The Turborepo pipeline defines task dependencies and caching rules:

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", ".turbo/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "test:unit": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    },
    "test:integration": {
      "dependsOn": ["build"],
      "cache": false
    },
    "test:e2e": {
      "dependsOn": ["build"],
      "cache": false
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

---

## 2. Database Schema — All 8 Tables

The database uses PostgreSQL 16 with the pgvector extension. All tables are managed through Drizzle ORM with `drizzle-kit` migrations. The vector extension must be enabled before any other migration runs.

### Table 1: `projects`

Represents a user's coding project that ContextOS manages.

```sql
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  repo_url    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_clerk_org_id_idx ON projects (clerk_org_id);
```

### Table 2: `feature_packs`

Feature Packs describe how an AI agent should behave when working on a project or module. They support inheritance via `parent_id`.

```sql
CREATE TABLE feature_packs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES feature_packs(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  content      JSONB NOT NULL,       -- Structured pack definition
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug, version)
);
CREATE INDEX feature_packs_project_id_idx ON feature_packs (project_id);
CREATE INDEX feature_packs_parent_id_idx ON feature_packs (parent_id);
```

### Table 3: `context_packs`

Context Packs record what an AI agent did during a run — files changed, decisions made, tests written. They are append-only and immutable after creation.

```sql
CREATE TABLE context_packs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_pack_id UUID REFERENCES feature_packs(id) ON DELETE SET NULL,
  run_id          UUID NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,     -- Markdown-formatted context
  embedding       VECTOR(384),       -- all-MiniLM-L6-v2 dimensions
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX context_packs_project_id_idx ON context_packs (project_id);
CREATE INDEX context_packs_run_id_idx ON context_packs (run_id);
CREATE INDEX context_packs_embedding_idx ON context_packs
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### Table 4: `runs`

A run represents one Claude Code session. It tracks lifecycle state and links to all events that occurred.

```sql
CREATE TABLE runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_pack_id UUID REFERENCES feature_packs(id) ON DELETE SET NULL,
  session_id      TEXT NOT NULL UNIQUE,  -- Claude Code session_id
  issue_ref       TEXT,                  -- Optional: GitHub issue number or URL
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'completed', 'aborted', 'error')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  cwd             TEXT NOT NULL,         -- Working directory at session start
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX runs_project_id_idx ON runs (project_id);
CREATE INDEX runs_session_id_idx ON runs (session_id);
CREATE INDEX runs_issue_ref_idx ON runs (issue_ref) WHERE issue_ref IS NOT NULL;
```

### Table 5: `run_events`

Immutable append-only event log for every hook fired during a run. Used for auditing, replay, and Context Pack generation.

```sql
CREATE TABLE run_events (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence_num    INTEGER NOT NULL,
  event_type      TEXT NOT NULL
                  CHECK (event_type IN ('SessionStart', 'PreToolUse', 'PostToolUse', 'Stop')),
  tool_name       TEXT,
  tool_input      JSONB,
  tool_output     JSONB,
  policy_decision TEXT CHECK (policy_decision IN ('allow', 'deny', 'warn', NULL)),
  policy_reason   TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,  -- Prevents duplicate events
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX run_events_run_id_idx ON run_events (run_id);
CREATE INDEX run_events_run_id_seq_idx ON run_events (run_id, sequence_num);
```

### Table 6: `policy_rules`

Policy rules define what an AI agent is and is not allowed to do within a project.

```sql
CREATE TABLE policy_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_pack_id UUID REFERENCES feature_packs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  event_type      TEXT NOT NULL
                  CHECK (event_type IN ('PreToolUse', 'PostToolUse', 'PermissionRequest', '*')),
  tool_pattern    TEXT,              -- Glob or regex pattern matching tool_name
  path_pattern    TEXT,              -- Glob pattern for file paths
  decision        TEXT NOT NULL
                  CHECK (decision IN ('allow', 'deny', 'warn')),
  priority        INTEGER NOT NULL DEFAULT 100,  -- Lower number = higher priority
  reason          TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX policy_rules_project_id_idx ON policy_rules (project_id);
CREATE INDEX policy_rules_feature_pack_id_idx ON policy_rules (feature_pack_id);
CREATE INDEX policy_rules_priority_idx ON policy_rules (project_id, priority ASC)
  WHERE is_active = true;
```

### Table 7: `semantic_diffs`

Stores the output of the Semantic Diff service — structured analysis of what changed in a run.

```sql
CREATE TABLE semantic_diffs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  raw_diff        TEXT NOT NULL,           -- The raw git diff
  apis_added      JSONB NOT NULL DEFAULT '[]',
  apis_removed    JSONB NOT NULL DEFAULT '[]',
  tests_added     JSONB NOT NULL DEFAULT '[]',
  tests_broken    JSONB NOT NULL DEFAULT '[]',
  new_modules     JSONB NOT NULL DEFAULT '[]',
  summary         TEXT NOT NULL,           -- LLM-generated natural language summary
  model_used      TEXT NOT NULL,           -- e.g. 'claude-3-5-haiku-20241022'
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX semantic_diffs_run_id_idx ON semantic_diffs (run_id);
```

### Table 8: ~~`pack_embeddings_queue`~~ — REMOVED

> **Architecture note:** Embedding generation jobs are queued via **BullMQ + Redis** (ADR-006), not a database table. The NL Assembly service consumes jobs from the `embed-context-pack` BullMQ queue. No database table is required for this.

---

## 3. Auth Scaffolding (Clerk)

ContextOS uses [Clerk](https://clerk.com) for authentication and organization management. All projects are scoped to a Clerk organization (`clerk_org_id`). Individual users belong to organizations.

### Auth model:
- **Organizations** → Projects. Each project belongs to one Clerk org.
- **Users** → Org members. Roles: `admin` (can manage packs and policies), `member` (can view and trigger runs).
- **API Keys** → Machine-to-machine auth for MCP server calls from Claude Code. Generated via Clerk's Machine-to-Machine tokens.

### Clerk middleware in Next.js (`apps/web`):
- `clerkMiddleware()` wraps all routes
- Public routes: `/`, `/sign-in`, `/sign-up`, `/api/health`
- Protected routes: everything under `/dashboard`, `/api/projects`, `/api/packs`

### MCP Server auth:
- Claude Code connects with a Bearer token (Clerk M2M token)
- MCP server validates token on every request using `@clerk/backend`'s `verifyToken()`
- Session context (org ID, user ID) propagated to all DB queries

---

## 4. Environment Configuration

All environment variables are documented in `.env.example` and validated at startup using Zod.

### Required variables:

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextos
DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/contextos_test

# Redis
REDIS_URL=redis://localhost:6379

# Clerk (Auth)
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_WEBHOOK_SECRET=whsec_...

# NL Assembly Service
NL_ASSEMBLY_URL=http://localhost:3200
NL_ASSEMBLY_EMBEDDING_MODEL=all-MiniLM-L6-v2

# Semantic Diff Service
SEMANTIC_DIFF_URL=http://localhost:3201
ANTHROPIC_API_KEY=sk-ant-...
SEMANTIC_DIFF_MODEL=claude-3-5-haiku-20241022

# MCP Server
MCP_SERVER_PORT=3100
MCP_SERVER_BASE_URL=http://localhost:3100

# Hooks Bridge
HOOKS_BRIDGE_PORT=3101
HOOKS_BRIDGE_BASE_URL=http://localhost:3101

# Web App
NEXT_PUBLIC_APP_URL=http://localhost:3002

# Logging
LOG_LEVEL=info

# Turborepo Remote Cache (optional)
TURBO_TOKEN=
TURBO_TEAM=
```

### Zod env validation schema (in `packages/shared/src/env.ts`):

```typescript
import { z } from 'zod';

export const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NL_ASSEMBLY_URL: z.string().url(),
  SEMANTIC_DIFF_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MCP_SERVER_PORT: z.coerce.number().int().positive().default(3100),
  HOOKS_BRIDGE_PORT: z.coerce.number().int().positive().default(3101),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten());
    process.exit(1);
  }
  return result.data;
}
```

---

## 5. Docker Compose for Local Development

`docker-compose.yml` starts PostgreSQL 16 with pgvector and Redis. It does NOT start the application services (those run via `pnpm turbo run dev`).

```yaml
version: '3.9'

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: contextos-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: contextos
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/01-init.sql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: contextos-redis
    ports:
      - '6379:6379'
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

### `scripts/init-db.sql`:

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create test database
CREATE DATABASE contextos_test;
-- Grant permissions for test DB
GRANT ALL PRIVILEGES ON DATABASE contextos_test TO postgres;
```

---

## 6. CI/CD Pipeline Foundation

The GitHub Actions CI pipeline runs in stages. Each stage builds on the previous. See `.github/workflows/ci.yml`.

### Pipeline stages:

1. **lint + typecheck** — Runs on every push and PR. Uses Biome for formatting/linting. Runs Turborepo's typecheck task. Fast, parallel.
2. **test:unit** — Runs Vitest unit tests for all TypeScript packages + pytest for Python services. Turborepo cached.
3. **test:integration** — Runs integration tests with real PostgreSQL (testcontainers). Not cached. Runs on PR and push.
4. **test:e2e** — Full lifecycle tests using MCP SDK client. Runs on push to `main` only.
5. **docker:build** — Builds Docker images using `turbo prune`. Runs on push to `main`.
6. **deploy:staging** — Auto-deploys to staging. Runs on push to `main` after docker:build.
7. **deploy:production** — Manual gate. Triggered by workflow_dispatch after staging validation.

### Biome configuration (`biome.json`):

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error"
      },
      "style": {
        "useConst": "error",
        "noVar": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "always"
    }
  },
  "files": {
    "ignore": ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/*.generated.ts"]
  }
}
```
