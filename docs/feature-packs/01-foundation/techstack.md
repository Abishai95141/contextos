# Feature Pack 01: Foundation — Technology Choices and Rationale

## 1. Turborepo — Why Not Nx, Lerna, or Yarn Workspaces Alone?

### What Turborepo Does

Turborepo is a high-performance build system for JavaScript/TypeScript monorepos. It adds:
- **Task graph execution**: understands which packages depend on which, runs tasks in correct order
- **Intelligent caching**: caches task outputs (build artifacts, test results) locally and remotely; skips re-running unchanged work
- **Parallel execution**: runs independent tasks in parallel across CPU cores
- **Remote caching**: shares cache with CI and team members via Vercel or a self-hosted backend

### Why Turborepo Over Alternatives

**vs. Nx**: Nx has similar capabilities but adds opinionated code generation, plugins, and a "smart monorepo" concept that couples you to its ecosystem. For ContextOS — a platform with clear service boundaries — Turborepo's simpler model is preferable. Turborepo's `turbo.json` is minimal, readable, and doesn't require Nx generators or executors. Nx is better for teams that want more scaffolding; Turborepo is better for teams that want control.

**vs. Lerna**: Lerna is primarily a package publishing tool, not a build orchestrator. It adds version management for npm packages. ContextOS doesn't publish packages to npm — all packages are internal. Lerna provides no build caching. Turborepo supersedes Lerna for build orchestration.

**vs. raw pnpm workspaces**: pnpm workspaces handle dependency resolution and linking. They do NOT handle task ordering, caching, or parallelism beyond simple scripts. You would have to build your own CI orchestration logic. Turborepo builds on top of pnpm workspaces and adds all the orchestration — these are complementary, not competing.

**vs. Bazel/Buck**: Bazel provides hermetic builds, which are more reproducible. But the learning curve is steep, and Bazel's JavaScript ecosystem support lags behind dedicated JS monorepo tools. Turborepo uses JavaScript's own build tools (tsc, vite, etc.) so the ecosystem works naturally. Turborepo is the right choice until the team exceeds ~50 packages.

### Turborepo Remote Caching for ContextOS

The `TURBO_TOKEN` and `TURBO_TEAM` environment variables connect to Vercel Remote Cache. The `turbo prune` command is used in Dockerfiles to create minimal dependency graphs per service (see Module 01 spec for the 4-stage Dockerfile pattern). This reduces Docker image sizes by 40-60%.

---

## 2. pnpm — Why Not npm or Yarn?

### The Case for pnpm

pnpm (Performant npm) addresses two fundamental problems with npm and Yarn:

1. **Disk efficiency via content-addressable storage**: pnpm stores all packages in a single global store (`~/.pnpm-store`). Workspace projects symlink into this store rather than copying files. A project with 10 packages that all use `zod@3.24.1` has ONE copy of zod on disk, not 10. In a monorepo like ContextOS with 8+ apps/packages, this is significant.

2. **Strict dependency resolution**: pnpm does not allow packages to access dependencies they haven't declared. npm and Yarn hoist all packages to `node_modules/`, which means package A can accidentally `require('package-b')` even if it's not in A's `package.json`. pnpm's symlink structure prevents this phantom dependency problem — if a package isn't in your `package.json`, you get an import error at build time, not a silent runtime bug.

**vs. npm**: npm workspaces work but lack pnpm's disk efficiency and strict resolution. In a 10-package monorepo, npm duplicates dependencies. npm is slower than pnpm for installs.

**vs. Yarn Berry (v4)**: Yarn Berry with PnP (Plug'n'Play) has the best disk efficiency but breaks many tools that assume `node_modules/` exists (ESLint plugins, some bundlers, VS Code extensions). Yarn Berry requires extensive configuration to be compatible with the JavaScript ecosystem. pnpm's `node_modules/` layout is compatible with all tools while still being efficient.

### pnpm Workspaces

The `pnpm-workspace.yaml` file tells pnpm where packages live. Scripts run with `pnpm --filter <package>` target specific packages. The `workspace:*` version specifier in `package.json` creates a workspace link — `"@contextos/shared": "workspace:*"` means "use the local package, not the npm registry version".

---

## 3. PostgreSQL 16 + pgvector — Why Not MongoDB or Pinecone?

### Why PostgreSQL is the Right Database for ContextOS

ContextOS has two distinct data needs:
1. **Relational data**: Projects, Feature Packs (with inheritance), Runs, Policy Rules, Events — all have foreign key relationships that are enforced and queried relationally.
2. **Vector similarity search**: Context Pack embeddings for semantic search.

The instinct to use a dedicated vector database (Pinecone, Qdrant, Weaviate) overlooks the cost: you now have two databases to operate, two connection pools, two backup strategies, and cross-database join complexity. If you want to filter by `project_id` while doing a vector search — which ContextOS does on every query — you either duplicate the relational data into the vector DB or do a two-phase query (vector DB → IDs → PostgreSQL → data). Both are worse than a single database that handles both.

**pgvector turns PostgreSQL into a vector database**. It adds:
- `VECTOR(n)` column type for storing embeddings
- HNSW (Hierarchical Navigable Small World) and IVFFlat indexes for ANN (approximate nearest neighbor) search
- Distance operators: `<->` (L2), `<=>` (cosine), `<#>` (inner product)
- Native Drizzle ORM support (first-class, not a workaround)

For ContextOS's scale (thousands to tens-of-thousands of context packs per project), pgvector's HNSW index delivers millisecond-range similarity searches with full relational filtering. Dedicated vector databases (Pinecone, etc.) become necessary at hundreds of millions of vectors — orders of magnitude beyond ContextOS's requirements.

### Why Not MongoDB?

MongoDB is a document database optimized for flexible schemas and horizontal write scaling. ContextOS's data has a well-defined schema (enforced by Drizzle and Zod schemas) and has important relational queries:

- "Give me all policy rules for this project, sorted by priority, filtered by event type" — trivial SQL, complex in MongoDB aggregations
- "Give me all runs with their event counts for this project in the last 30 days" — a simple JOIN + GROUP BY, requires a $lookup pipeline in MongoDB
- "Inherit feature packs: resolve the full pack chain for pack X by following parent_id links" — a recursive CTE in PostgreSQL, deeply awkward in MongoDB

PostgreSQL's query planner optimizes these patterns that MongoDB struggles with. Additionally, MongoDB has no native vector search (Atlas Vector Search exists but is cloud-only and adds cost). PostgreSQL + pgvector handles both use cases.

### Why Not Pinecone or Other Dedicated Vector DBs?

Pinecone, Qdrant, Weaviate, and Milvus are purpose-built for vector search at large scale. For ContextOS:

- **Operational overhead**: A separate vector DB means separate infrastructure, credentials, and monitoring. For a startup/early-stage project, this is unnecessary overhead.
- **Filtering complexity**: All dedicated vector DBs require denormalizing your relational metadata into the vector DB to enable filtered searches. When a context pack's project changes, you update PostgreSQL AND re-index in Pinecone.
- **Scale**: ContextOS will not have 100M+ vectors until it becomes a major enterprise product. pgvector handles millions of vectors with sub-50ms queries on modest hardware.
- **Cost**: Pinecone's pricing starts at $70/month for their smallest paid tier. pgvector is free (open source extension).

**The migration path exists**: If ContextOS outgrows pgvector, the embedding data is already in PostgreSQL. Migrating to a dedicated vector DB is a data export + reindex operation. Starting with pgvector avoids premature infrastructure complexity.

### PostgreSQL as Cloud Sync Layer (ADR-008)

PostgreSQL is the **cloud sync layer**, not the only database. The VS Code extension (Feature Pack 07) uses local SQLite (`better-sqlite3` + `sqlite-vec`) as the **primary data store** on each developer's machine. Runs, run events, and context packs are written locally first — PostgreSQL receives them via background sync when connected.

This means Foundation's PostgreSQL schema defines the **canonical cloud schema** that the VS Code extension syncs to/from. Feature Packs and Policy Rules flow cloud → local (read-only locally). Runs, Run Events, and Context Packs flow local → cloud (written locally first). See the VS Code Extension spec (Feature Pack 07) for the local SQLite schema and sync protocol.

---

## 4. Drizzle ORM — Why Not Prisma or Kysely?

### Drizzle's Decisive Advantages for ContextOS

**pgvector support is native in Drizzle.** Drizzle has a `vector()` column type in `drizzle-orm/pg-core` and generates correct migration SQL for HNSW indexes with `using('hnsw', col.op('vector_cosine_ops'))`. Prisma has no native vector column type — it requires raw SQL for both column definition and queries, losing type safety at the most critical data path in ContextOS. Kysely also requires raw SQL interpolation for pgvector.

**SQL-like API scales to complex queries.** ContextOS's queries include:
- CTEs for recursive feature pack inheritance resolution
- Window functions for run event sequencing
- `<=>` cosine distance operator for semantic search with metadata filters
- `INSERT ... ON CONFLICT DO NOTHING` for idempotency key enforcement

Drizzle's API mirrors SQL:

```typescript
// Drizzle: readable, typed
const packs = await db
  .select()
  .from(contextPacks)
  .where(
    and(
      eq(contextPacks.projectId, projectId),
      isNotNull(contextPacks.embedding),
    ),
  )
  .orderBy(sql`embedding <=> ${queryVector}`)
  .limit(10);
```

Prisma would require a `$queryRaw` call for the `<=>` operator, losing all type safety on the result.

**Instant TypeScript inference.** Drizzle infers TypeScript types directly from schema definitions — no code generation step, no `prisma generate` needed. Types are always in sync because they're derived at compile time from the same schema definition that Drizzle uses at runtime.

**~5KB bundle size.** Prisma 7 reduced its size significantly (after removing the Rust query engine), but still brings more overhead than Drizzle. For edge deployments or Lambda-style hosting, Drizzle's minimal footprint matters.

### Why Not Prisma?

Prisma's advantages are excellent DX for simple CRUD applications and a beginner-friendly API. But:

1. **pgvector support requires raw SQL** for column types and all vector operations. ContextOS's most important query path — semantic search — would be untyped.
2. **Code generation coupling**: `prisma generate` must run before TypeScript can compile. In a Turborepo pipeline, this adds a build step dependency. Drizzle has no generation step.
3. **Prisma Client abstraction leaks** at complex query patterns. When you need a CTE, Prisma's `$queryRaw` drops you back to SQL strings. Drizzle lets you compose SQL at any complexity level with full type inference.

Prisma is an excellent tool for the right use case (simple CRUD, rapid prototyping, teams unfamiliar with SQL). ContextOS is not that use case.

### Why Not Kysely?

Kysely is an excellent SQL query builder with strong TypeScript inference. It has no ORM features — no schema definition, no migration tooling (only a plugin ecosystem). You must define types separately from queries and manage migrations manually.

For ContextOS, the combination of Drizzle's schema-to-migration pipeline (`drizzle-kit generate` → `drizzle-kit migrate`) and its query builder is strictly better than Kysely's query-builder-only approach. Drizzle gives you both — schema definition AND type-safe queries — in one package.

---

## 5. Clerk — Why Not Auth.js or Supabase Auth?

### Why Clerk for ContextOS

ContextOS needs:
1. **User authentication** (email/password, OAuth)
2. **Organization management** (each project belongs to an org; users are org members with roles)
3. **Machine-to-Machine tokens** (MCP server needs to authenticate Claude Code agents)
4. **Webhook events** (when a new org is created, ContextOS provisions the database record)

Clerk provides all four as a managed service. The organization management system in Clerk is production-grade — invitations, roles, multi-org membership — and would take weeks to build from scratch.

**vs. Auth.js (formerly NextAuth)**: Auth.js is a session management library, not an auth platform. It handles OAuth flows and sessions but has no organization concept, no M2M tokens, and no webhook system. You would need to build organization management from scratch on top of a regular user table. Auth.js is excellent for simple user authentication but inadequate for ContextOS's org-scoped multi-tenant model.

**vs. Supabase Auth**: Supabase Auth is tightly coupled to the Supabase database and storage ecosystem. ContextOS uses PostgreSQL via Drizzle, not Supabase. Using Supabase Auth without the rest of Supabase is awkward — Supabase Auth's Row Level Security policies assume Supabase's PostgREST API layer. Additionally, Supabase Auth has limited organization support compared to Clerk.

**vs. Building your own**: Session management, token rotation, OAuth providers, MFA, organization management, and webhook infrastructure are each individually complex. The auth space has subtle security requirements (timing attacks, token entropy, cookie security). Clerk handles all of this correctly and maintains it. For a platform that handles AI agent access to user codebases, security is critical — use a dedicated auth provider.

### Clerk's Practical Advantages

- **Clerk M2M tokens**: An API key format designed for machine-to-machine authentication. The MCP server validates these tokens using `@clerk/backend`'s `verifyToken()` — one function call, no database query.
- **Organization roles**: Clerk's built-in `admin` and `member` roles map directly to ContextOS's permission model without additional tables.
- **Next.js integration**: `clerkMiddleware()` in Next.js 15 is a single middleware wrapper that protects all routes. Auth context is available in Server Components via `auth()` from `@clerk/nextjs/server`.
- **Webhooks**: Clerk sends signed webhook events for all user/org lifecycle events. `svix` library verifies signatures in one line.

The $25/month starting cost (for Clerk's Pro plan, required for organizations) is justified by the engineering time saved versus building equivalent infrastructure.
