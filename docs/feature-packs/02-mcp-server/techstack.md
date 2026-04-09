# Feature Pack 02: MCP Server — Technology Choices and Rationale

## 1. @modelcontextprotocol/sdk v1.29+ — TypeScript SDK

### Why the TypeScript SDK

The MCP SDK is available in TypeScript, Python, C#, and Go. ContextOS uses TypeScript for the MCP Server for three reasons:

**Monorepo coherence**: ContextOS is a TypeScript/Node.js monorepo managed by Turborepo. The MCP Server consumes `@contextos/db` and `@contextos/shared`, which are TypeScript packages. Using the TypeScript MCP SDK means the entire call path — from schema definition to database query — is type-safe without any language boundary. A Python MCP server would require JSON Schema or Protobuf contracts to share types with the TypeScript database layer, adding friction and desync risk at the most important service.

**First-class protocol support**: The TypeScript SDK receives MCP protocol updates first. The Streamable HTTP transport (`StreamableHTTPServerTransport`) was added in v1.10.0 (April 2025) in the TypeScript SDK. This transport is critical for hosted, internet-facing deployments — it allows stateless operation behind load balancers, which the older SSE transport does not support cleanly.

**Zod integration**: The TypeScript SDK uses Zod for tool input schema definition and validation. `@contextos/shared` already uses Zod schemas extensively. Tool registration in the TypeScript SDK accepts Zod schemas directly: `server.tool('name', description, zodSchema.shape, handler)`. This means the same Zod schema used for validation in the tool handler is also used to generate the MCP tool's JSON Schema for client introspection. No duplication.

### Streamable HTTP Transport

`StreamableHTTPServerTransport` is the correct transport choice for ContextOS because:

- **Stateless**: Each request is independent. The server can scale horizontally — any instance handles any request. The old SSE transport required clients to maintain a persistent connection to a specific server instance, breaking horizontal scaling.
- **Standard HTTP**: The MCP endpoint is a standard `POST /mcp` endpoint. It works with any HTTP load balancer, API gateway, auth proxy, or WAF. Nothing special is required at the infrastructure layer.
- **SSE streaming support**: For tools that produce long-running output (semantic search over large archives), the transport can stream the response as SSE while keeping the HTTP semantics correct.
- **Health check compatibility**: The `/health` endpoint coexists on the same Express server. A standard load balancer health check hits `GET /health`; tool calls hit `POST /mcp`.

The SSE-only transport (legacy) is kept for backward compatibility with older clients like Claude Desktop running MCP servers locally. ContextOS does not use it for the hosted server.

### SDK Version Pinning

Pin to `@modelcontextprotocol/sdk@^1.29.0` (not `^2.x`). v2 is pre-alpha as of early 2026 and has breaking API changes. The `^` semver range allows automatic minor updates (1.29.0 → 1.30.x) but not major version changes. Review the SDK changelog before upgrading minor versions in production.

---

## 2. Zod for Tool Input Validation

### Why Zod at the MCP Layer

Every tool handler receives input from an AI agent. AI agents are non-deterministic — they may pass additional fields, omit optional fields, or pass the wrong types for a field under some circumstances. Zod `safeParse()` at the entry point of every tool handler catches these issues before they propagate to database queries.

The validation pattern is consistent across all tools:

```typescript
const parsed = inputSchema.safeParse(input);
if (!parsed.success) {
  throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${parsed.error.message}`);
}
```

Throwing `McpError` with `ErrorCode.InvalidParams` causes the MCP SDK to return a properly formatted MCP error response to the client. The client (Claude Code) sees this as a tool invocation error and can retry with corrected input.

### Type Inference from Schemas

`z.infer<typeof Schema>` derives the TypeScript type for the schema's output. This means:
- The tool handler is typed against the parsed output, not the raw `unknown` input
- TypeScript compiler catches type mismatches at build time, not runtime
- No `as` type assertions needed inside tool handlers — the parsed data is already narrowed to the correct type

### Schema Reuse for Documentation

The MCP SDK uses the Zod schema (via `.shape`) to generate the JSON Schema that clients see when calling `ListTools`. This means the schema definition IS the documentation — field descriptions (`z.string().describe('...')`) appear in the tool's JSON Schema returned to clients. No duplication between code and docs.

---

## 3. Drizzle for Database Queries

### Query Pattern in Tool Handlers

Tool handlers use Drizzle's type-safe query builder for all database operations. The pattern:

```typescript
const [project] = await db
  .select()
  .from(projects)
  .where(
    and(
      eq(projects.slug, projectSlug),
      eq(projects.clerkOrgId, authContext.orgId),  // always scope to org
    ),
  )
  .limit(1);
```

Every query is scoped to `authContext.orgId`. This is a multi-tenant platform — a bug that leaks one org's data to another would be catastrophic. The `orgId` filter on every query is the single most important security invariant in the codebase.

### Complex Queries in Tool Handlers

The `query_run_history` tool uses a JOIN + GROUP BY to count events per run:

```typescript
const runsWithCounts = await db
  .select({
    run: runs,
    eventCount: count(runEvents.id),
    contextPackCount: count(contextPacks.id),
  })
  .from(runs)
  .leftJoin(runEvents, eq(runEvents.runId, runs.id))
  .leftJoin(contextPacks, eq(contextPacks.runId, runs.id))
  .where(eq(runs.projectId, project.id))
  .groupBy(runs.id)
  .orderBy(desc(runs.startedAt))
  .limit(input.limit);
```

This query is readable, typed, and composable. With Prisma, the equivalent requires multiple queries + manual JOIN in JavaScript. With raw SQL, the result type is `unknown`. Drizzle hits the sweet spot.

### Idempotency Pattern

Write operations use `ON CONFLICT DO NOTHING` for idempotency key enforcement:

```typescript
await db
  .insert(runEvents)
  .values({ idempotencyKey, ...eventData })
  .onConflictDoNothing({ target: runEvents.idempotencyKey });
```

This ensures that if the same hook event is delivered twice (network retry), only one row is inserted. The idempotency key format is `{sessionId}:{eventType}:{toolUseId}`.

---

## 4. pino for Structured Logging

### Why Structured Logging Matters in the MCP Layer

The MCP server handles requests from AI agents — the control plane for potentially hundreds of concurrent Claude Code sessions. Debugging a policy evaluation gone wrong, or a context pack that wasn't saved, requires logs that can be queried by `sessionId`, `runId`, `orgId`, and `toolName`.

With pino:

```typescript
logger.info(
  { sessionId, runId, toolName, orgId, decision },
  'Policy check completed',
);
```

This produces a single-line JSON log:
```json
{"level":30,"time":1705312200000,"sessionId":"abc123","runId":"uuid","toolName":"Edit","orgId":"org_xxx","decision":"allow","msg":"Policy check completed"}
```

This log is trivially queryable in any log aggregator (Datadog, CloudWatch, Loki) using structured field filters. Unstructured logs (`console.log('Policy check: ' + decision)`) are much harder to query at scale.

### Correlation IDs in Every Log Line

Every log entry in a tool handler includes:
- `orgId`: Which organization this request belongs to
- `sessionId`: Which Claude Code session (from hook payload or MCP token)
- `runId`: Which run (if applicable)
- `toolName`: Which MCP tool is executing

This lets you reconstruct the full timeline of a session from logs alone, without querying the database.

### Performance

pino is 5-10x faster than winston for JSON serialization. In a tight request loop where Claude Code calls `check_policy` before every tool use, logging overhead matters. pino serializes asynchronously and its footprint is minimal.

### pino-http for Request Logging

`pino-http` adds request/response logging to Express middleware. Every HTTP request to the MCP server gets an automatic log entry with method, URL, status code, and response time. This is the outer wrapper; pino logger instances are used inside tool handlers for operation-specific logging.
