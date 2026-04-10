# ContextOS Canonical Schema

> **This is the authoritative data model.** When writing Drizzle schema, migrations, or types, this document takes precedence over any spec. The Drizzle source of truth is `packages/db/src/schema.ts`.

---

## Tables (8)

### 1. `projects`

Org-scoped container for all ContextOS resources.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `clerk_org_id` | text | NOT NULL | Clerk organization ID — all queries must scope to this |
| `name` | text | NOT NULL | Display name |
| `slug` | text | NOT NULL, UNIQUE | URL-safe identifier |
| `repo_url` | text | nullable | Optional VCS link |
| `created_at` | timestamptz | NOT NULL, defaultNow | |
| `updated_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:** `projects_clerk_org_idx` on `(clerk_org_id)`

---

### 2. `feature_packs`

Versioned pack of project context, conventions, and policies for guiding an AI agent.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `project_id` | uuid | NOT NULL, FK → projects | |
| `name` | text | NOT NULL | Human-readable display name |
| `slug` | text | NOT NULL | URL-safe identifier for MCP `packSlug` lookup |
| `version` | integer | NOT NULL, DEFAULT 1 | Increments on each update |
| `parent_pack_id` | uuid | nullable | Self-referential for inheritance (no FK constraint) |
| `content` | jsonb | NOT NULL | Structured pack content (`FeaturePackContent`) |
| `source_files` | jsonb | nullable | `string[]` — file paths tracked for freshness |
| `is_active` | boolean | NOT NULL, DEFAULT true | Only active packs returned by `get_feature_pack` |
| `is_stale` | boolean | DEFAULT false | Set true when source files change |
| `created_by` | text | nullable | Clerk user ID string |
| `created_at` | timestamptz | NOT NULL, defaultNow | |
| `updated_at` | timestamptz | NOT NULL, defaultNow | |
| `version_lock` | integer | NOT NULL, DEFAULT 0 | Optimistic locking |

**Indexes:**
- `feature_packs_project_idx` on `(project_id)`
- `feature_packs_parent_idx` on `(parent_pack_id)`
- `feature_packs_project_slug_version_idx` UNIQUE on `(project_id, slug, version)`

---

### 3. `runs`

One run per Claude Code session. Tracks lifecycle from session start to stop hook.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `project_id` | uuid | NOT NULL, FK → projects | |
| `session_id` | text | NOT NULL | Claude Code `session_id` from hook payload |
| `idempotency_key` | text | NOT NULL, UNIQUE | `run:{projectId}:{sessionId}` — deterministic |
| `feature_pack_id` | uuid | nullable, FK → feature_packs | Pack active at session start |
| `issue_ref` | text | nullable | e.g. `"GH-142"` |
| `agent_name` | text | nullable | `claude-code` \| `cursor` \| `copilot` |
| `status` | text | NOT NULL, DEFAULT `'in_progress'` | `in_progress` \| `completed` \| `interrupted` |
| `started_at` | timestamptz | NOT NULL, defaultNow | |
| `completed_at` | timestamptz | nullable | Set on Stop hook |

**Indexes:**
- `runs_project_idx` on `(project_id)`
- `runs_session_idx` on `(session_id)`
- `runs_idempotency_idx` UNIQUE on `(idempotency_key)`

---

### 4. `context_packs` — append-only

Immutable record of what an AI agent built during a run. Never updated or deleted.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `project_id` | uuid | NOT NULL, FK → projects | |
| `run_id` | uuid | NOT NULL, FK → runs | One context pack per run |
| `issue_ref` | text | nullable | |
| `feature_pack_id` | uuid | nullable, FK → feature_packs | |
| `feature_pack_version` | integer | nullable | Snapshot of version at creation |
| `content` | jsonb | NOT NULL | `ContextPackContent` (tool traces, decisions, files) |
| `semantic_diff` | jsonb | nullable | `SemanticDiff` — written by semantic-diff service |
| `summary` | text | nullable | Human-readable summary |
| `summary_embedding` | vector(384) | nullable | all-MiniLM-L6-v2 embedding. **384 dims, not 1536.** |
| `status` | text | NOT NULL, DEFAULT `'committed'` | `committed` \| `partial` \| `quarantined` |
| `agent_name` | text | nullable | |
| `created_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:**
- `context_packs_project_idx` on `(project_id)`
- `context_packs_run_idx` on `(run_id)`
- `context_packs_issue_idx` on `(issue_ref)`
- `context_packs_status_idx` on `(status)`
- `context_packs_embedding_hnsw_idx` HNSW on `summary_embedding` using `vector_cosine_ops` — required for NL Assembly ANN search

---

### 5. `run_events` — append-only

Individual tool traces within a run. Never updated or deleted.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `run_id` | uuid | NOT NULL, FK → runs | |
| `event_type` | text | NOT NULL | `tool_use` \| `policy_check` \| `decision` |
| `tool_name` | text | nullable | Claude Code tool name (e.g. `"Bash"`) |
| `inputs` | jsonb | nullable | Tool input object |
| `outputs` | jsonb | nullable | Tool output object |
| `duration_ms` | integer | nullable | |
| `idempotency_key` | text | NOT NULL, UNIQUE | `{runId}:{eventType}:{toolName}` — deterministic |
| `created_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:** `run_events_run_idx` on `(run_id)`

---

### 6. `policies`

Container for a set of policy rules scoped to a project.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `project_id` | uuid | NOT NULL, FK → projects | |
| `name` | text | NOT NULL | |
| `description` | text | nullable | |
| `is_active` | boolean | NOT NULL, DEFAULT true | |
| `created_by` | text | nullable | Clerk user ID string |
| `created_at` | timestamptz | NOT NULL, defaultNow | |
| `updated_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:** `policies_project_idx` on `(project_id)`

---

### 7. `policy_rules`

Individual rules within a policy. Evaluated in priority order (ascending). First match wins.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `policy_id` | uuid | NOT NULL, FK → policies | |
| `name` | text | NOT NULL | Human-readable rule name |
| `event_type` | text | NOT NULL | `PreToolUse` \| `PostToolUse` \| `PermissionRequest` \| `*` |
| `tool_pattern` | text | NOT NULL | Glob, e.g. `"Bash"`, `"Write*"`, `"*"` |
| `path_pattern` | text | nullable | Glob on `toolInput.file_path`, e.g. `"**/node_modules/**"` |
| `decision` | text | NOT NULL | `allow` \| `deny` \| `warn` |
| `priority` | integer | NOT NULL, DEFAULT 100 | Lower number = evaluated first |
| `is_active` | boolean | NOT NULL, DEFAULT true | |
| `metadata` | jsonb | nullable | Extra conditions or annotations |
| `created_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:** `policy_rules_policy_priority_idx` on `(policy_id, priority)`

---

### 8. `policy_decisions` — append-only audit log

Immutable record of every policy evaluation. Never updated or deleted.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, defaultRandom | |
| `policy_id` | uuid | NOT NULL, FK → policies | |
| `rule_id` | uuid | nullable, FK → policy_rules | Which rule matched. null = default allow (no rule matched) |
| `run_id` | uuid | nullable, FK → runs | Present if evaluation happens within a run |
| `session_id` | text | nullable | Present for hook evaluations before a run is created |
| `tool_name` | text | NOT NULL | |
| `decision` | text | NOT NULL | `allow` \| `deny` \| `warn` |
| `reason` | text | nullable | Rule name or "default allow" |
| `idempotency_key` | text | NOT NULL, UNIQUE | `pd:{sessionId}:{toolName}:{eventType}` — prevents duplicates on retry |
| `evaluated_at` | timestamptz | NOT NULL, defaultNow | |

**Indexes:**
- `policy_decisions_policy_idx` on `(policy_id)`
- `policy_decisions_run_idx` on `(run_id)`

---

## Removed Tables (vs. earlier spec drafts)

| Table | Reason |
|-------|--------|
| `users` | Clerk manages users. No local sync needed. `created_by` columns store Clerk user ID strings directly. |
| `project_members` | Clerk manages org membership. Role checks use Clerk's `orgMembership.role`. |
| `semantic_diffs` | SemanticDiff is always 1:1 with a context pack. Stored as `context_packs.semantic_diff` JSONB — no separate table needed. |
| `pack_embeddings_queue` | ADR-006 chose BullMQ + Redis for all async job queuing. A DB table queue contradicts that decision. |

---

## Module Ownership Map

Each module number corresponds to `docs/feature-packs/NN-name/`.

| Module | Schema Role |
|--------|-------------|
| **01 Foundation** | Creates all 8 tables in `0000_initial.sql`. Includes HNSW index on `context_packs.summary_embedding`. |
| **02 MCP Server** | Reads all tables. Enqueues BullMQ embedding jobs to Redis — **no new DB tables**. |
| **03 Hooks Bridge** | Reads `policies`, `policy_rules`. Writes to `policy_decisions`, `run_events`. **No new DB tables.** |
| **04 Web App** | Read-only queries across all tables. **No new DB tables.** |
| **05 NL Assembly** | Reads `context_packs.summary`. Writes `context_packs.summary_embedding`. HNSW index already in `0000_initial.sql`. **No new DB tables.** |
| **06 Semantic Diff** | Writes `context_packs.semantic_diff`. **No new DB tables.** |
| **07 VS Code Extension** | MCP client only. No direct DB access. **No new DB tables.** |

---

## Idempotency Key Formats

All keys are deterministic — same inputs always produce the same key.

| Entity | Key Format | Generator |
|--------|-----------|-----------|
| Run | `run:{projectId}:{sessionId}` | `generateRunKey(projectId, sessionId)` |
| RunEvent | `{runId}:{eventType}:{toolName}` | `generateIdempotencyKey(runId, eventType, toolName)` |
| ContextPack | `ctx:{runId}:{sluggedTitle}` | `generateContextPackKey(runId, title)` |
| PolicyDecision | `pd:{sessionId}:{toolName}:{eventType}` | `generatePolicyDecisionKey(sessionId, toolName, eventType)` |

All generators are in `packages/shared/src/utils/idempotency.ts`.

---

## Vector Embedding Notes

- **Model:** `all-MiniLM-L6-v2` (sentence-transformers)
- **Dimensions:** **384** — this is the only correct value. Any reference to `1536` in older docs is wrong (that is OpenAI Ada-002's dimension count).
- **Column:** `context_packs.summary_embedding vector(384)`
- **Index type:** HNSW with `vector_cosine_ops` — required for approximate nearest-neighbor search in NL Assembly
- **Normalization:** Embeddings are L2-normalized before storage so cosine similarity = dot product
