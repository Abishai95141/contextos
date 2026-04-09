# Feature Pack 01: Foundation — Implementation Guide

## Prerequisites

Before starting, ensure you have installed:
- Node.js 22.x (`node --version` → `v22.x.x`)
- pnpm 9.x (`pnpm --version` → `9.x.x`)
- Docker Desktop (or Docker Engine + Compose)
- Git 2.40+
- `uv` for Python (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

---

## Step 1: Initialize the Repository

```bash
mkdir contextos && cd contextos
git init
git branch -M main
```

Create `.gitignore`:

```bash
cat > .gitignore << 'EOF'
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
dist/
.next/
.turbo/
*.tsbuildinfo
out/

# Python
__pycache__/
*.pyc
*.pyo
.venv/
.uv/

# Environment
.env
.env.local
.env.*.local

# VS Code
.vscode/settings.json
!.vscode/extensions.json
!.vscode/launch.json

# OS
.DS_Store
Thumbs.db

# Test artifacts
coverage/
*.lcov
.nyc_output/

# Docker
*.tar

# Logs
*.log
pino-*.log
EOF
```

---

## Step 2: Initialize pnpm Workspace

```bash
# Create root package.json
cat > package.json << 'EOF'
{
  "name": "contextos",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test:unit",
    "test:integration": "turbo run test:integration",
    "test:e2e": "turbo run test:e2e",
    "format": "biome format --write .",
    "db:generate": "pnpm --filter @contextos/db run generate",
    "db:migrate": "pnpm --filter @contextos/db run migrate",
    "db:studio": "pnpm --filter @contextos/db run studio"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "turbo": "^2.3.3",
    "typescript": "^5.7.3"
  }
}
EOF

# Create pnpm workspace file
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
  - 'services/*'
EOF

pnpm install
```

---

## Step 3: Install Turborepo and Biome

```bash
# turbo.json is at root
cat > turbo.json << 'EOF'
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
EOF

# biome.json is at root
cat > biome.json << 'EOF'
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "style": { "useConst": "error", "noVar": "error" }
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
    "ignore": ["**/dist/**", "**/.next/**", "**/node_modules/**"]
  }
}
EOF

pnpm install
```

---

## Step 4: Create the Shared Package

The `packages/shared` package contains Zod schemas and TypeScript types used across all services.

```bash
mkdir -p packages/shared/src
```

Create `packages/shared/package.json`:

```json
{
  "name": "@contextos/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "dev": "tsup src/index.ts --format esm,cjs --dts --watch",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@contextos/tsconfig": "*",
    "tsup": "^8.3.5",
    "typescript": "^5.7.3"
  }
}
```

Create `packages/shared/src/env.ts`:

```typescript
import { z } from 'zod';

export const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NL_ASSEMBLY_URL: z.string().url().default('http://localhost:8001'),
  SEMANTIC_DIFF_URL: z.string().url().default('http://localhost:8002'),
  ANTHROPIC_API_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MCP_SERVER_PORT: z.coerce.number().int().positive().default(3000),
  HOOKS_BRIDGE_PORT: z.coerce.number().int().positive().default(3001),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(JSON.stringify(result.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }
  return result.data;
}
```

Create `packages/shared/src/schemas.ts` (all shared Zod schemas):

```typescript
import { z } from 'zod';

// UUIDs
export const UuidSchema = z.string().uuid();

// Project schemas
export const ProjectSchema = z.object({
  id: UuidSchema,
  clerkOrgId: z.string().min(1),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  repoUrl: z.string().url().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Project = z.infer<typeof ProjectSchema>;

// Feature Pack content schema
export const FeaturePackContentSchema = z.object({
  description: z.string().min(1),
  tools: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  blockedPaths: z.array(z.string()).default([]),
  conventions: z.array(z.string()).default([]),
  dependencies: z.record(z.string()).default({}),
  customInstructions: z.string().optional(),
});
export type FeaturePackContent = z.infer<typeof FeaturePackContentSchema>;

export const FeaturePackSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100),
  version: z.number().int().positive(),
  content: FeaturePackContentSchema,
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type FeaturePack = z.infer<typeof FeaturePackSchema>;

// Context Pack schemas
export const ContextPackSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  featurePackId: UuidSchema.nullable(),
  runId: UuidSchema,
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

// Run schemas
export const RunStatusSchema = z.enum(['active', 'completed', 'aborted', 'error']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  featurePackId: UuidSchema.nullable(),
  sessionId: z.string().min(1),
  issueRef: z.string().nullable(),
  status: RunStatusSchema,
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
  cwd: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});
export type Run = z.infer<typeof RunSchema>;

// Hook event schemas (Claude Code format)
export const HookEventTypeSchema = z.enum(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
export type HookEventType = z.infer<typeof HookEventTypeSchema>;

export const HookPayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: HookEventTypeSchema,
  tool_name: z.string().optional(),
  tool_input: z.record(z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  tool_response: z.record(z.unknown()).optional(),
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;

// Policy schemas
export const PolicyDecisionSchema = z.enum(['allow', 'deny', 'warn']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PolicyRuleSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  featurePackId: UuidSchema.nullable(),
  name: z.string().min(1),
  eventType: z.enum(['PreToolUse', 'PostToolUse', 'PermissionRequest', '*']),
  toolPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  decision: PolicyDecisionSchema,
  priority: z.number().int().nonnegative(),
  reason: z.string().min(1),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyEvaluationResultSchema = z.object({
  decision: PolicyDecisionSchema,
  matchedRuleId: UuidSchema.nullable(),
  reason: z.string(),
});
export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;
```

Create `packages/shared/src/index.ts`:

```typescript
export * from './env.js';
export * from './schemas.js';
```

---

## Step 5: Create the Database Package

```bash
mkdir -p packages/db/src/migrations
mkdir -p packages/db/src/schema
```

Create `packages/db/package.json`:

```json
{
  "name": "@contextos/db",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "dev": "tsup src/index.ts --format esm,cjs --dts --watch",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate",
    "studio": "drizzle-kit studio",
    "test:unit": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  },
  "dependencies": {
    "@contextos/shared": "*",
    "drizzle-orm": "^0.38.3",
    "postgres": "^3.4.5",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@contextos/tsconfig": "*",
    "@testcontainers/postgresql": "^10.18.0",
    "@vitest/coverage-v8": "^2.1.8",
    "drizzle-kit": "^0.30.3",
    "testcontainers": "^10.18.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

Create `packages/db/src/schema/index.ts`:

```typescript
import { relations } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkOrgId: text('clerk_org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    repoUrl: text('repo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clerkOrgIdIdx: index('projects_clerk_org_id_idx').on(table.clerkOrgId),
  }),
);

export const featurePacks = pgTable(
  'feature_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    version: integer('version').notNull().default(1),
    content: jsonb('content').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index('feature_packs_project_id_idx').on(table.projectId),
    parentIdIdx: index('feature_packs_parent_id_idx').on(table.parentId),
    uniqueProjectSlugVersion: uniqueIndex('feature_packs_project_slug_version_idx').on(
      table.projectId,
      table.slug,
      table.version,
    ),
  }),
);

export const contextPacks = pgTable(
  'context_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    featurePackId: uuid('feature_pack_id').references(() => featurePacks.id, {
      onDelete: 'set null',
    }),
    runId: uuid('run_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 384 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index('context_packs_project_id_idx').on(table.projectId),
    runIdIdx: index('context_packs_run_id_idx').on(table.runId),
    embeddingIdx: index('context_packs_embedding_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops'))
      .where(sql`${table.embedding} IS NOT NULL`),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    featurePackId: uuid('feature_pack_id').references(() => featurePacks.id, {
      onDelete: 'set null',
    }),
    sessionId: text('session_id').notNull().unique(),
    issueRef: text('issue_ref'),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cwd: text('cwd').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => ({
    projectIdIdx: index('runs_project_id_idx').on(table.projectId),
    sessionIdIdx: index('runs_session_id_idx').on(table.sessionId),
    issueRefIdx: index('runs_issue_ref_idx').on(table.issueRef),
  }),
);

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequenceNum: integer('sequence_num').notNull(),
    eventType: text('event_type').notNull(),
    toolName: text('tool_name'),
    toolInput: jsonb('tool_input'),
    toolOutput: jsonb('tool_output'),
    policyDecision: text('policy_decision'),
    policyReason: text('policy_reason'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdIdx: index('run_events_run_id_idx').on(table.runId),
    runIdSeqIdx: index('run_events_run_id_seq_idx').on(table.runId, table.sequenceNum),
  }),
);

export const policyRules = pgTable(
  'policy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    featurePackId: uuid('feature_pack_id').references(() => featurePacks.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    eventType: text('event_type').notNull(),
    toolPattern: text('tool_pattern'),
    pathPattern: text('path_pattern'),
    decision: text('decision').notNull(),
    priority: integer('priority').notNull().default(100),
    reason: text('reason').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index('policy_rules_project_id_idx').on(table.projectId),
    featurePackIdIdx: index('policy_rules_feature_pack_id_idx').on(table.featurePackId),
    priorityIdx: index('policy_rules_priority_idx').on(table.projectId, table.priority),
  }),
);

export const semanticDiffs = pgTable(
  'semantic_diffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    rawDiff: text('raw_diff').notNull(),
    apisAdded: jsonb('apis_added').notNull().default([]),
    apisRemoved: jsonb('apis_removed').notNull().default([]),
    testsAdded: jsonb('tests_added').notNull().default([]),
    testsBroken: jsonb('tests_broken').notNull().default([]),
    newModules: jsonb('new_modules').notNull().default([]),
    summary: text('summary').notNull(),
    modelUsed: text('model_used').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdIdx: index('semantic_diffs_run_id_idx').on(table.runId),
  }),
);

export const packEmbeddingsQueue = pgTable(
  'pack_embeddings_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contextPackId: uuid('context_pack_id')
      .notNull()
      .references(() => contextPacks.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index('pack_embeddings_queue_status_idx').on(table.status),
    contextPackIdIdx: index('pack_embeddings_queue_context_pack_id_idx').on(table.contextPackId),
  }),
);

// Relations
export const projectsRelations = relations(projects, ({ many }) => ({
  featurePacks: many(featurePacks),
  runs: many(runs),
}));

export const featurePacksRelations = relations(featurePacks, ({ one, many }) => ({
  project: one(projects, { fields: [featurePacks.projectId], references: [projects.id] }),
  parent: one(featurePacks, { fields: [featurePacks.parentId], references: [featurePacks.id] }),
  children: many(featurePacks),
  policyRules: many(policyRules),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  featurePack: one(featurePacks, { fields: [runs.featurePackId], references: [featurePacks.id] }),
  events: many(runEvents),
  contextPacks: many(contextPacks),
}));
```

---

## Step 6: Create Initial Migration

```bash
# Create drizzle.config.ts at packages/db root
cat > packages/db/drizzle.config.ts << 'EOF'
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
});
EOF

# Generate the first migration
cd packages/db
pnpm run generate
```

The generated migration file will be in `packages/db/src/migrations/`. Review it to confirm the `vector` extension is first:

```sql
-- 0000_initial.sql
CREATE EXTENSION IF NOT EXISTS "vector";

-- Then all table CREATE statements follow...
```

If the extension is not first in the generated file, add it manually before the first CREATE TABLE statement.

---

## Step 7: Start Local Infrastructure

```bash
# From repo root
docker compose up -d

# Verify services are healthy
docker compose ps

# Run migrations
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextos \
  pnpm db:migrate

# Verify migration
psql postgresql://postgres:postgres@localhost:5432/contextos \
  -c "\dt"
```

Expected output — all 8 tables listed:

```
          List of relations
 Schema |         Name          | Type  |  Owner
--------+-----------------------+-------+----------
 public | context_packs         | table | postgres
 public | feature_packs         | table | postgres
 public | pack_embeddings_queue | table | postgres
 public | policy_rules          | table | postgres
 public | projects              | table | postgres
 public | run_events            | table | postgres
 public | runs                  | table | postgres
 public | semantic_diffs        | table | postgres
```

---

## Step 8: Set Up Clerk

1. Create a Clerk account at [clerk.com](https://clerk.com)
2. Create a new application named "ContextOS"
3. Enable **Organizations** in Clerk dashboard → Organizations
4. Copy keys to `.env`:
   - `CLERK_PUBLISHABLE_KEY` → from Clerk dashboard → API Keys
   - `CLERK_SECRET_KEY` → from Clerk dashboard → API Keys
5. Create a Webhook endpoint in Clerk dashboard → Webhooks:
   - URL: `http://localhost:3002/api/webhooks/clerk` (local dev via ngrok tunnel)
   - Events: `organization.created`, `organization.deleted`, `organizationMembership.created`
6. Copy `CLERK_WEBHOOK_SECRET` to `.env`

---

## Step 9: Create `.env` from Template

```bash
cp .env.example .env
# Edit .env and fill in all values
# Never commit .env to git
```

---

## Step 10: Set Up GitHub Actions

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    name: CI Pipeline
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: ${{ vars.TURBO_TEAM }}

    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: contextos_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint and typecheck
        run: pnpm turbo run lint typecheck

      - name: Unit tests
        run: pnpm turbo run test:unit

      - name: Run migrations (test DB)
        run: pnpm db:migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/contextos_test

      - name: Integration tests
        run: pnpm turbo run test:integration
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/contextos_test
          REDIS_URL: redis://localhost:6379
```

---

## Verification Checklist

After completing all steps, verify:

- [ ] `pnpm install` completes without errors
- [ ] `pnpm turbo run lint` passes with zero warnings
- [ ] `pnpm turbo run typecheck` passes with zero errors
- [ ] `docker compose up -d` starts both postgres and redis healthy
- [ ] `pnpm db:migrate` creates all 8 tables in the database
- [ ] `psql` can connect and `\dt` shows all tables
- [ ] `\dx` shows the `vector` extension installed
- [ ] `pnpm db:studio` opens Drizzle Studio in browser
- [ ] Clerk dashboard shows the application created
- [ ] `.env` is populated with all required values
- [ ] `.env` is in `.gitignore` (never committed)
- [ ] GitHub Actions workflow file exists at `.github/workflows/ci.yml`
- [ ] First CI run passes on GitHub (if repo is connected)
