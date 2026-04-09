# Feature Pack 03: Hooks Bridge — Technology Choices and Rationale

## 1. Hono — Why Not Express or Fastify?

### The Hooks Bridge Use Case

The Hooks Bridge handles a specific, well-defined workload: receive a JSON POST from Claude Code, do minimal synchronous work (policy lookup), and return a JSON response in under 500ms. It is not a general-purpose API server. The framework must be:

1. **Fast to respond**: Policy evaluation must be synchronous and sub-500ms. Framework overhead must be minimal.
2. **Easy to test without a running server**: `app.request()` testing is critical for verifying hook handler behavior in unit tests.
3. **TypeScript-native**: No `@types/` packages needed. Middleware types flow through correctly.
4. **Deployable anywhere**: The Hooks Bridge might run as a serverless function for teams on serverless infrastructure.

Hono satisfies all four. Express does not satisfy #2 or #3. Fastify satisfies #1 and #3 but not #2 (Fastify's test utilities use `inject()` which requires a started server instance, though the syntax is similar).

### `app.request()` Testing

Hono's `app.request()` method accepts a `Request` object and returns a `Response` object — all standard Web APIs, no Node.js HTTP layer involved. This means unit tests for hook handlers are pure function calls:

```typescript
const res = await app.request('/hooks/pre-tool-use', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
  body: JSON.stringify({ hook_event_name: 'PreToolUse', ... }),
});
const body = await res.json();
expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
```

No `supertest`, no `httpMocks`, no server setup, no `beforeAll(startServer)`. The Hono app is instantiated fresh in each test file. This is a significant testing ergonomics advantage.

### Web Standards API

Hono uses `Request`, `Response`, `Headers`, and `URL` — the same Web APIs used in Cloudflare Workers, Deno, and browser service workers. If ContextOS ever needs to deploy the Hooks Bridge as an edge function (for lower latency near Claude Code users), the code requires minimal changes. With Express, a full rewrite would be necessary.

### Bundle Size

Hono's core is ~14KB minified. This matters if the Hooks Bridge is deployed as a Lambda function or Cloudflare Worker, where cold start time correlates with bundle size. Express is ~57KB with dependencies. Fastify is ~150KB+ with all plugins.

### Why Not Fastify?

Fastify is excellent and would be a valid alternative. The performance difference between Hono and Fastify is negligible for the Hooks Bridge workload (both are far faster than the policy evaluation + Redis lookup that dominates request time). The deciding factor is `app.request()` testing — Hono's test API is more ergonomic for the hook handler testing pattern ContextOS uses extensively.

---

## 2. BullMQ for Async Event Processing

### Why Event Recording Must Be Async

The `PreToolUse` hook has a hard deadline: Claude Code times out if the hook doesn't respond within 10 seconds. Policy evaluation takes ~10-50ms (Redis cache hit) to ~100ms (DB query cache miss). Event recording (INSERT into run_events) takes ~5-20ms additional.

However, the event recording is not needed for the policy decision — the decision is made before recording. By deferring event recording to BullMQ:

- The hook handler does policy evaluation → sends response → enqueues a BullMQ job
- The BullMQ worker picks up the job and does the DB INSERT asynchronously
- Hook response latency: ~50-100ms (policy evaluation only)
- Without BullMQ: ~70-120ms (policy + DB write)

The 20-30ms saved matters when Claude Code calls this hook on every tool use, potentially dozens of times per session.

### BullMQ Deduplication via jobId

BullMQ's `jobId` option deduplicates jobs at the queue level. When the Hooks Bridge enqueues a `record-event` job:

```typescript
await eventQueue.add('record-event', jobData, {
  jobId: idempotencyKey, // e.g., 'session123:PreToolUse:tool-uuid-001'
});
```

If Claude Code retries the hook (network failure, timeout), the same idempotencyKey is used. BullMQ ignores duplicate job IDs — the second enqueue is a no-op. Combined with the `ON CONFLICT DO NOTHING` in the DB INSERT, event recording is fully idempotent.

### BullMQ for Context Pack Assembly

The Stop hook triggers a multi-step operation: load run events → call Semantic Diff service (LLM call) → format markdown → call MCP server to save. This can take 5-30 seconds. BullMQ workers handle this entirely outside the HTTP request path. The Stop hook returns `{ continue: true }` immediately.

BullMQ's `concurrency: 3` setting on the context pack assembly worker limits parallel LLM calls, which is important for rate limiting and cost control.

### Why Not pg-boss?

pg-boss uses PostgreSQL's `SKIP LOCKED` pattern for job queuing — no Redis required. For ContextOS, Redis is already required (session state, policy cache), so there's no infrastructure savings from pg-boss. BullMQ has a more mature ecosystem, better TypeScript support, and Bull Board (a web UI for monitoring queues). pg-boss is the right choice only when avoiding Redis is a hard constraint.

---

## 3. ioredis for Idempotency Keys and Session State

### ioredis is Mandatory for BullMQ

BullMQ's `connection` option takes an `IORedis` instance directly. BullMQ does not support `node-redis`. This makes ioredis a required dependency the moment BullMQ is adopted.

### Session State in Redis

The Hooks Bridge stores `runId` in Redis keyed by session:

```
Key: session:{session_id}:run_id
Value: "uuid-of-run"
TTL: 86400 seconds (24 hours)
```

This avoids a DB query on every hook call. The SessionStart handler writes the key; the Stop handler deletes it. All other handlers (`PreToolUse`, `PostToolUse`) read it.

The 24-hour TTL acts as a safety valve: if the Stop hook never fires (Claude Code crash), the session key eventually expires and is cleaned up automatically.

### Policy Rule Cache

Policy rules are cached in Redis with a 60-second TTL:

```
Key: policy:project:{projectId}:rules
Value: JSON-serialized array of policy rules sorted by priority
TTL: 60 seconds
```

This reduces DB queries dramatically. A project with many Claude Code sessions would otherwise query policy rules on every `PreToolUse` hook (potentially dozens of times per minute). With caching, the rules are loaded once from DB and served from Redis for 60 seconds.

Cache invalidation: when a policy rule is updated via the web app, a webhook hits the Hooks Bridge's internal `/internal/invalidate-policy-cache` endpoint, which deletes the Redis key immediately.

### ioredis vs. node-redis

Both work for ContextOS's Redis use cases. The decisive factor: BullMQ requires ioredis. Given this constraint, using ioredis everywhere (session keys, policy cache) eliminates the need for two Redis client libraries.

ioredis also has a 30% lower CPU usage at load compared to node-redis (based on Ably production data), better cluster support, and built-in Sentinel support for Redis HA configurations. The TypeScript API is ergonomic and well-documented.
