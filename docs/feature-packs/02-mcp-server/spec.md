# Feature Pack 02: MCP Server

## Overview

The MCP Server is the core protocol layer of ContextOS. It speaks the Model Context Protocol over Streamable HTTP, exposing Feature Packs, Context Packs, run history, and policy state to AI coding agents (Claude Code, Cursor, Copilot). The server is stateless between requests — all state is in PostgreSQL.

---

## 1. Architecture

```
Claude Code / Cursor / Copilot
         │
         │  HTTP POST /mcp
         │  Authorization: Bearer <clerk-m2m-token>
         ▼
┌─────────────────────────────────────────┐
│           MCP Server (Node.js 22)        │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │    StreamableHTTPServerTransport│    │
│  │    @modelcontextprotocol/sdk    │    │
│  └──────────────┬──────────────────┘    │
│                 │                       │
│  ┌──────────────▼──────────────────┐    │
│  │         McpServer               │    │
│  │  - tool registry                │    │
│  │  - resource registry            │    │
│  │  - Zod validation               │    │
│  └──────────────┬──────────────────┘    │
│                 │                       │
│  ┌──────────────▼──────────────────┐    │
│  │      Tool Handlers              │    │
│  │  get_feature_pack               │    │
│  │  save_context_pack              │    │
│  │  check_policy                   │    │
│  │  query_run_history              │    │
│  │  search_packs_nl                │    │
│  │  record_decision                │    │
│  └──────────────┬──────────────────┘    │
│                 │                       │
│  ┌──────────────▼──────────────────┐    │
│  │     Database Layer              │    │
│  │     @contextos/db (Drizzle)     │    │
│  └─────────────────────────────────┘    │
│                                         │
│  HTTP GET /health  (unauthenticated)     │
└─────────────────────────────────────────┘
         │
         │  PostgreSQL (pgvector)
         ▼
┌─────────────────────────────────────────┐
│     PostgreSQL 16 + pgvector            │
│     (all 8 tables)                      │
└─────────────────────────────────────────┘
```

### Transport: Streamable HTTP

The MCP server uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`. This means:
- The client sends HTTP POST requests to `/mcp`
- Responses can be standard JSON (for tool results) or SSE streams (for long-running operations)
- The server is stateless — no persistent connection required
- Works behind load balancers, API gateways, and TLS termination proxies

### Authentication Flow

1. Claude Code sends `Authorization: Bearer <token>` header on every request
2. Express middleware calls `verifyToken(token, { secretKey: CLERK_SECRET_KEY })`
3. If invalid: return `401 Unauthorized` before MCP processing
4. If valid: extract `orgId` and `userId` from token claims, attach to request context
5. All tool handlers receive the authenticated context and scope all DB queries to `orgId`

---

## 2. Tools — Complete Specification

### Tool 1: `get_feature_pack`

Returns a resolved Feature Pack for a project. "Resolved" means the pack's content is merged with its parent chain (up to 10 levels deep) using field-level inheritance — child values override parent values.

**Input Schema:**
```typescript
const GetFeaturePackInputSchema = z.object({
  projectSlug: z.string().min(1).max(100).describe(
    'The slug identifier for the project (e.g., "my-app")'
  ),
  packSlug: z.string().min(1).max(100).optional().describe(
    'Specific pack slug to retrieve. If omitted, returns the active root pack for the project.'
  ),
  version: z.number().int().positive().optional().describe(
    'Specific version number. If omitted, returns the latest active version.'
  ),
});
```

**Output Schema:**
```typescript
const GetFeaturePackOutputSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  version: z.number().int(),
  resolvedContent: z.object({
    description: z.string(),
    tools: z.array(z.string()),
    allowedPaths: z.array(z.string()),
    blockedPaths: z.array(z.string()),
    conventions: z.array(z.string()),
    dependencies: z.record(z.string()),
    customInstructions: z.string().optional(),
  }),
  inheritanceChain: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    version: z.number().int(),
  })),
  projectId: z.string().uuid(),
  retrievedAt: z.string().datetime(),
});
```

**Resolution algorithm**: Start at the requested pack. Collect the full parent chain by following `parent_id` recursively (max 10 levels, cycle detection required). Merge content from root → leaf: each level overrides parent fields. Arrays (tools, conventions) are concatenated, not replaced, unless the child specifies `"replace": true` in metadata.

**Error cases**:
- `PACK_NOT_FOUND`: packSlug or version not found for this project
- `PROJECT_NOT_FOUND`: projectSlug not found in this org
- `INHERITANCE_CYCLE`: circular parent reference detected (max 10 levels exceeded)

---

### Tool 2: `save_context_pack`

Saves a Context Pack documenting what the AI agent built during a session. Immediately enqueues an embedding generation job for semantic search.

**Input Schema:**
```typescript
const SaveContextPackInputSchema = z.object({
  runId: z.string().uuid().describe(
    'The UUID of the current run, established during SessionStart hook'
  ),
  title: z.string().min(1).max(500).describe(
    'A descriptive title for this context pack (e.g., "Added OAuth flow to auth module")'
  ),
  content: z.string().min(1).describe(
    'Full markdown-formatted content describing what was built, decided, and changed'
  ),
  featurePackId: z.string().uuid().optional().describe(
    'The feature pack that guided this work, if applicable'
  ),
  metadata: z.record(z.unknown()).optional().describe(
    'Additional structured metadata (file counts, test counts, etc.)'
  ),
});
```

**Output Schema:**
```typescript
const SaveContextPackOutputSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  title: z.string(),
  embeddingJobId: z.string().describe('Queue job ID for embedding generation'),
  savedAt: z.string().datetime(),
});
```

**Idempotency**: The tool is idempotent on `(runId, title)` — calling it twice with the same runId and title returns the existing record without creating a duplicate.

**Side effects**:
1. INSERT into `context_packs`
2. INSERT into `pack_embeddings_queue` with `status = 'pending'`
3. Emit BullMQ job to `nl-assembly` queue

---

### Tool 3: `check_policy`

Evaluates whether a specific tool use is permitted by the project's policy rules. Returns allow/deny/warn with the matched rule and reason.

**Input Schema:**
```typescript
const CheckPolicyInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  sessionId: z.string().min(1).describe('Claude Code session_id'),
  eventType: z.enum(['PreToolUse', 'PostToolUse', 'PermissionRequest']),
  toolName: z.string().min(1).describe('The Claude Code tool name (e.g., "Edit", "Bash", "Write")'),
  toolInput: z.record(z.unknown()).describe('The full tool input object from Claude Code'),
  featurePackId: z.string().uuid().optional().describe(
    'If provided, also evaluate pack-specific rules in addition to project-level rules'
  ),
});
```

**Output Schema:**
```typescript
const CheckPolicyOutputSchema = z.object({
  decision: z.enum(['allow', 'deny', 'warn']),
  matchedRuleId: z.string().uuid().nullable(),
  matchedRuleName: z.string().nullable(),
  reason: z.string(),
  evaluatedRuleCount: z.number().int(),
  checkedAt: z.string().datetime(),
});
```

**Evaluation algorithm**:
1. Load all active policy rules for the project (ordered by `priority ASC`)
2. If `featurePackId` provided, also load pack-specific rules
3. For each rule (in priority order), check if `rule.event_type` matches `eventType` (or is `*`)
4. Check if `rule.tool_pattern` matches `toolName` (glob matching with `micromatch`)
5. Check if `rule.path_pattern` matches `tool_input.file_path` (glob matching, if applicable)
6. First matching rule wins — return its decision
7. Default decision if no rule matches: `allow`

---

### Tool 4: `query_run_history`

Returns run history for a project or issue, with event summaries and context pack references.

**Input Schema:**
```typescript
const QueryRunHistoryInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  issueRef: z.string().optional().describe(
    'Filter to runs associated with a specific issue (e.g., "GH-142" or a GitHub issue URL)'
  ),
  status: z.enum(['active', 'completed', 'aborted', 'error']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional().describe(
    'Pagination cursor — the ID of the last run from the previous page'
  ),
});
```

**Output Schema:**
```typescript
const QueryRunHistoryOutputSchema = z.object({
  runs: z.array(z.object({
    id: z.string().uuid(),
    sessionId: z.string(),
    issueRef: z.string().nullable(),
    status: z.enum(['active', 'completed', 'aborted', 'error']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    cwd: z.string(),
    featurePackName: z.string().nullable(),
    eventCount: z.number().int(),
    contextPackCount: z.number().int(),
    summary: z.string().nullable(),
  })),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().uuid().nullable(),
});
```

---

### Tool 5: `search_packs_nl`

Performs semantic search over the Context Pack archive using natural language queries. Calls the NL Assembly service for embedding generation and pgvector similarity search.

**Input Schema:**
```typescript
const SearchPacksNlInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  query: z.string().min(1).max(1000).describe(
    'Natural language search query (e.g., "how did we implement the OAuth flow?")'
  ),
  limit: z.number().int().min(1).max(20).default(5),
  minSimilarity: z.number().min(0).max(1).default(0.7).describe(
    'Minimum cosine similarity score (0-1). Results below this threshold are excluded.'
  ),
  featurePackId: z.string().uuid().optional().describe(
    'Filter results to context packs from runs that used a specific feature pack'
  ),
});
```

**Output Schema:**
```typescript
const SearchPacksNlOutputSchema = z.object({
  results: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    similarity: z.number().min(0).max(1),
    runId: z.string().uuid(),
    featurePackName: z.string().nullable(),
    createdAt: z.string().datetime(),
    excerpt: z.string().describe('First 300 chars of content for preview'),
  })),
  query: z.string(),
  searchedAt: z.string().datetime(),
  embeddingModel: z.string(),
});
```

**Implementation**: Calls `NL_ASSEMBLY_URL/search` with the query. NL Assembly embeds the query and runs a pgvector cosine similarity search with the project filter. Results are returned sorted by similarity descending.

---

### Tool 6: `record_decision`

Records a significant architectural or implementation decision made during a run for audit purposes and Context Pack inclusion.

**Input Schema:**
```typescript
const RecordDecisionInputSchema = z.object({
  runId: z.string().uuid(),
  title: z.string().min(1).max(500).describe(
    'Short title for the decision (e.g., "Use Drizzle instead of Prisma")'
  ),
  context: z.string().min(1).describe(
    'What was the situation that required a decision?'
  ),
  decision: z.string().min(1).describe(
    'What was decided?'
  ),
  rationale: z.string().min(1).describe(
    'Why was this decision made? What alternatives were considered?'
  ),
  alternatives: z.array(z.object({
    option: z.string(),
    rejectionReason: z.string(),
  })).default([]),
  impact: z.enum(['low', 'medium', 'high']).default('medium'),
});
```

**Output Schema:**
```typescript
const RecordDecisionOutputSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  title: z.string(),
  recordedAt: z.string().datetime(),
});
```

**Implementation**: Appended to the run's metadata JSONB field as a `decisions` array. Also written to a `run_events` record with `event_type = 'decision'` and the full decision in `tool_input`. Idempotent on `(runId, title)`.

---

## 3. Resources — Complete Specification

Resources are read-only MCP resources that clients can fetch by URI.

### Resource 1: `feature-pack://{id}`

**URI pattern**: `feature-pack://{uuid}`
**Description**: Returns the full Feature Pack content (resolved with inheritance) as a JSON resource.
**Content type**: `application/json`
**Auth**: Verifies the requested pack belongs to the authenticated org.

### Resource 2: `context-pack://{id}`

**URI pattern**: `context-pack://{uuid}`
**Description**: Returns a single Context Pack's full markdown content.
**Content type**: `text/markdown`
**Auth**: Verifies the requested pack belongs to the authenticated org.

### Resource 3: `run-history://{issue}`

**URI pattern**: `run-history://{issue-ref}` (URL-encoded)
**Description**: Returns all runs associated with an issue reference, as a JSON array.
**Content type**: `application/json`
**Example**: `run-history://GH-142` or `run-history://https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fissues%2F142`

---

## 4. Error Handling Strategy

All tool errors follow a consistent pattern using MCP's error codes:

```typescript
// Error types used across all tools
type ToolErrorCode =
  | 'PACK_NOT_FOUND'        // Resource doesn't exist for this org
  | 'PROJECT_NOT_FOUND'     // Project slug not found in org
  | 'RUN_NOT_FOUND'         // Run ID doesn't exist
  | 'UNAUTHORIZED'          // Token is valid but resource belongs to different org
  | 'INVALID_INPUT'         // Zod validation failed
  | 'INHERITANCE_CYCLE'     // Feature pack parent chain has a cycle
  | 'NL_ASSEMBLY_UNAVAILABLE' // Upstream NL service is down
  | 'DATABASE_ERROR'        // Unexpected DB error (logged, generic message returned)
  | 'RATE_LIMITED';         // Too many requests from this session
```

Tool handlers throw `McpError` with a code and human-readable message. The MCP SDK converts these to proper MCP error responses. Sensitive details (SQL errors, stack traces) are logged via pino but never returned to the client.

---

## 5. Health Check Endpoint

`GET /health` — unauthenticated, returns server status and dependency health.

**Response (200 OK)**:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "timestamp": "2026-01-15T10:30:00Z",
  "dependencies": {
    "database": "healthy",
    "redis": "healthy",
    "nlAssembly": "healthy"
  }
}
```

**Response (503 Service Unavailable)** if any critical dependency is down:
```json
{
  "status": "degraded",
  "version": "0.1.0",
  "timestamp": "2026-01-15T10:30:00Z",
  "dependencies": {
    "database": "healthy",
    "redis": "unhealthy",
    "nlAssembly": "healthy"
  }
}
```

The health check runs a `SELECT 1` on the database, a Redis `PING`, and an HTTP `GET` to `NL_ASSEMBLY_URL/health` with a 2-second timeout each.
