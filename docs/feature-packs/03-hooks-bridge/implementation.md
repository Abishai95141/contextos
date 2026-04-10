# Feature Pack 03: Hooks Bridge — Implementation Guide

## Prerequisites

Module 01 (Foundation) must be complete. Module 02 (MCP Server) must be running (the Stop hook calls `save_context_pack` via the MCP server).

---

## Step 1: Initialize the Hono Server

```bash
mkdir -p apps/hooks-bridge/src/{handlers,middleware,engine,recorder,workers,lib}

cat > apps/hooks-bridge/package.json << 'EOF'
{
  "name": "@contextos/hooks-bridge",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --no-splitting",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test:unit": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  },
  "dependencies": {
    "@clerk/backend": "^1.20.0",
    "@contextos/db": "workspace:*",
    "@contextos/shared": "workspace:*",
    "bullmq": "^5.34.5",
    "hono": "^4.6.20",
    "ioredis": "^5.4.2",
    "micromatch": "^4.0.8",
    "pino": "^9.6.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@contextos/tsconfig": "workspace:*",
    "@testcontainers/postgresql": "^10.18.0",
    "@testcontainers/redis": "^10.18.0",
    "@types/micromatch": "^4.0.9",
    "@types/node": "^22.10.7",
    "@vitest/coverage-v8": "^2.1.8",
    "testcontainers": "^10.18.0",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
EOF

pnpm install
```

---

## Step 2: Create the Server Entry Point

Create `apps/hooks-bridge/src/index.ts`:

```typescript
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { timing } from 'hono/timing';
import pino from 'pino';
import { parseEnv } from '@contextos/shared';
import { createDb } from '@contextos/db';
import { createRedisClient } from './lib/redis.js';
import { authMiddleware } from './middleware/auth.js';
import { sessionStartHandler } from './handlers/session-start.js';
import { preToolUseHandler } from './handlers/pre-tool-use.js';
import { postToolUseHandler } from './handlers/post-tool-use.js';
import { stopHandler } from './handlers/stop.js';
import { startWorkers } from './workers/index.js';

const env = parseEnv();
const logger = pino({ level: env.LOG_LEVEL });

const db = createDb(env.DATABASE_URL);
const redis = createRedisClient(env.REDIS_URL);

// Start BullMQ workers
startWorkers({ db, redis, logger, env });

const app = new Hono();

app.use('*', honoLogger());
app.use('*', timing());

// Health check
app.get('/health', (c) => c.json({ status: 'healthy', timestamp: new Date().toISOString() }));

// Hook endpoints with auth
const hooks = app.use('/hooks/*', authMiddleware({ clerkSecretKey: env.CLERK_SECRET_KEY }));

app.post('/hooks/session-start', sessionStartHandler({ db, redis, logger }));
app.post('/hooks/pre-tool-use', preToolUseHandler({ db, redis, logger }));
app.post('/hooks/post-tool-use', postToolUseHandler({ db, redis, logger }));
app.post('/hooks/stop', stopHandler({ db, redis, logger, env }));

const server = serve(
  { fetch: app.fetch, port: env.HOOKS_BRIDGE_PORT },
  (info) => {
    logger.info({ port: info.port }, 'Hooks Bridge started');
  },
);

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info('Shutdown signal received');
  server.close(async () => {
    await redis.quit();
    logger.info('Hooks Bridge shut down');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app }; // Exported for testing with app.request()
```

---

## Step 3: Auth Middleware

Create `apps/hooks-bridge/src/middleware/auth.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { verifyToken } from '@clerk/backend';

interface AuthMiddlewareOptions {
  clerkSecretKey: string;
}

export function authMiddleware({ clerkSecretKey }: AuthMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const claims = await verifyToken(token, { secretKey: clerkSecretKey });
      c.set('orgId', claims.org_id);
      c.set('userId', claims.sub);
      await next();
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
  };
}
```

---

## Step 4: Session Start Handler

Create `apps/hooks-bridge/src/handlers/session-start.ts`:

```typescript
import type { Handler } from 'hono';
import type { Logger } from 'pino';
import { HookPayloadSchema } from '@contextos/shared';
import { eq, and } from 'drizzle-orm';
import { projects, runs } from '@contextos/db/schema';
import type { DrizzleDb } from '@contextos/db';
import type { Redis } from 'ioredis';
import { SESSION_KEY_TTL_SECONDS, buildSessionKey } from '../lib/session-keys.js';

interface HandlerDeps {
  db: DrizzleDb;
  redis: Redis;
  logger: Logger;
}

export function sessionStartHandler({ db, redis, logger }: HandlerDeps): Handler {
  return async (c) => {
    const body = await c.req.json();
    const parsed = HookPayloadSchema.safeParse(body);

    if (!parsed.success) {
      logger.warn({ error: parsed.error.message }, 'Invalid SessionStart payload');
      return c.json({ continue: true }); // Non-blocking — always let session proceed
    }

    const { session_id: sessionId, cwd } = parsed.data;
    const orgId = c.get('orgId') as string;

    logger.info({ sessionId, cwd, orgId }, 'SessionStart received');

    try {
      // Find project matching this cwd and orgId
      const allProjects = await db
        .select({ id: projects.id, slug: projects.slug, repoUrl: projects.repoUrl })
        .from(projects)
        .where(eq(projects.clerkOrgId, orgId));

      // Match project by cwd prefix
      const matchedProject = cwd
        ? allProjects.find(
            (p) =>
              p.repoUrl &&
              (cwd.startsWith(p.repoUrl) || p.slug === cwd.split('/').pop()),
          )
        : null;

      if (!matchedProject) {
        logger.warn({ sessionId, cwd }, 'No project matched for session, continuing without tracking');
        return c.json({ continue: true });
      }

      // Create run record
      const [run] = await db
        .insert(runs)
        .values({
          projectId: matchedProject.id,
          sessionId,
          status: 'active',
          cwd: cwd ?? '',
          metadata: {},
        })
        .onConflictDoUpdate({
          target: runs.sessionId,
          set: { status: 'active' },
        })
        .returning({ id: runs.id });

      // Cache runId in Redis
      await redis.set(
        buildSessionKey(sessionId),
        run.id,
        'EX',
        SESSION_KEY_TTL_SECONDS,
      );

      logger.info({ sessionId, runId: run.id, projectId: matchedProject.id }, 'Run created for session');
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to create run record — continuing non-blocking');
    }

    return c.json({ continue: true });
  };
}
```

---

## Step 5: Pre-Tool Use Handler

Create `apps/hooks-bridge/src/handlers/pre-tool-use.ts`:

```typescript
import type { Handler } from 'hono';
import type { Logger } from 'pino';
import { Queue } from 'bullmq';
import { HookPayloadSchema } from '@contextos/shared';
import type { DrizzleDb } from '@contextos/db';
import type { Redis } from 'ioredis';
import { evaluatePolicy } from '../engine/policy.js';
import { buildSessionKey, buildIdempotencyKey } from '../lib/session-keys.js';

interface HandlerDeps {
  db: DrizzleDb;
  redis: Redis;
  logger: Logger;
}

export function preToolUseHandler({ db, redis, logger }: HandlerDeps): Handler {
  const eventQueue = new Queue('run-events', { connection: redis });

  return async (c) => {
    const body = await c.req.json();
    const parsed = HookPayloadSchema.safeParse(body);

    if (!parsed.success) {
      logger.warn({ error: parsed.error.message }, 'Invalid PreToolUse payload');
      return c.json({ hookSpecificOutput: { permissionDecision: 'allow' } });
    }

    const { session_id: sessionId, tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId } = parsed.data;

    logger.info({ sessionId, toolName, toolUseId }, 'PreToolUse received');

    // Get runId from Redis
    const runId = await redis.get(buildSessionKey(sessionId));

    let policyDecision: 'allow' | 'deny' | 'warn' = 'allow';
    let policyReason = 'No run context — default allow';

    if (runId) {
      try {
        const result = await evaluatePolicy({
          db,
          redis,
          runId,
          eventType: 'PreToolUse',
          toolName: toolName ?? '',
          toolInput: toolInput ?? {},
        });
        policyDecision = result.decision === 'warn' ? 'allow' : result.decision;
        policyReason = result.reason;

        // Enqueue event recording (async — after response is sent)
        const idempotencyKey = buildIdempotencyKey(sessionId, 'PreToolUse', toolUseId ?? 'no-id');
        await eventQueue.add(
          'record-event',
          {
            runId,
            eventType: 'PreToolUse',
            toolName,
            toolInput,
            policyDecision: result.decision,
            policyReason: result.reason,
            idempotencyKey,
          },
          {
            jobId: idempotencyKey, // BullMQ deduplication by jobId
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          },
        );
      } catch (err) {
        logger.error({ err, sessionId, toolName }, 'Policy evaluation failed — defaulting to allow');
      }
    }

    if (policyDecision === 'deny') {
      logger.info({ sessionId, toolName, policyReason }, 'Tool use DENIED by policy');
      return c.json({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: policyReason,
        },
      });
    }

    return c.json({ hookSpecificOutput: { permissionDecision: 'allow' } });
  };
}
```

---

## Step 6: Policy Engine

Create `apps/hooks-bridge/src/engine/policy.ts`:

```typescript
import { eq, and, asc } from 'drizzle-orm';
import micromatch from 'micromatch';
import { policyRules, runs } from '@contextos/db/schema';
import type { DrizzleDb } from '@contextos/db';
import type { Redis } from 'ioredis';
import type { PolicyDecision } from '@contextos/shared';

interface PolicyEvalInput {
  db: DrizzleDb;
  redis: Redis;
  runId: string;
  eventType: 'PreToolUse' | 'PostToolUse' | 'PermissionRequest';
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface PolicyEvalResult {
  decision: PolicyDecision;
  reason: string;
  matchedRuleId: string | null;
}

const CACHE_TTL_SECONDS = 60;

export async function evaluatePolicy(input: PolicyEvalInput): Promise<PolicyEvalResult> {
  const { db, redis, runId, eventType, toolName, toolInput } = input;

  // Get project from run
  const [run] = await db
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!run) {
    return { decision: 'allow', reason: 'Run not found — default allow', matchedRuleId: null };
  }

  const projectId = run.projectId;

  // Try cache first
  const cacheKey = `policy:project:${projectId}:rules`;
  const cached = await redis.get(cacheKey);

  let rules: Array<typeof policyRules.$inferSelect>;
  if (cached) {
    rules = JSON.parse(cached) as typeof rules;
  } else {
    rules = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.projectId, projectId), eq(policyRules.isActive, true)))
      .orderBy(asc(policyRules.priority));

    // Cache for 60 seconds
    await redis.set(cacheKey, JSON.stringify(rules), 'EX', CACHE_TTL_SECONDS);
  }

  // Extract file path from tool input (tool-specific)
  const filePath = extractFilePath(toolName, toolInput);

  // Determine agent type from request context (Cursor adapter sets this; Claude Code defaults)
  const agentType = (toolInput as Record<string, unknown>).agent_type ?? 'claude_code';

  for (const rule of rules) {
    // Agent type filter
    if (rule.agentType && rule.agentType !== '*' && rule.agentType !== agentType) continue;

    // Event type filter
    if (rule.eventType !== '*' && rule.eventType !== eventType) continue;

    // Tool name filter
    if (rule.toolPattern && !micromatch.isMatch(toolName, rule.toolPattern)) continue;

    // Path filter
    if (rule.pathPattern) {
      if (!filePath) continue; // Rule requires a path but tool has none
      if (!micromatch.isMatch(filePath, rule.pathPattern)) continue;
    }

    // Matched
    return {
      decision: rule.decision as PolicyDecision,
      reason: rule.reason,
      matchedRuleId: rule.id,
    };
  }

  return { decision: 'allow', reason: 'No matching policy rule — default allow', matchedRuleId: null };
}

function extractFilePath(toolName: string, toolInput: Record<string, unknown>): string | null {
  // Both Claude Code and Cursor use the same tool names for file operations.
  // Cursor's preToolUse fires with tool_name values: Shell, Read, Write, Grep, Delete, Task
  // Cursor's beforeMCPExecution uses MCP:<tool_name> format
  // Claude Code uses: Edit, Write, Read, MultiEdit, Bash
  const pathFields: Record<string, string> = {
    Edit: 'file_path',
    Write: 'file_path',
    Read: 'file_path',
    MultiEdit: 'file_path',
  };

  const field = pathFields[toolName];
  if (!field) {
    // Fallback: check common path fields for unknown tool names
    for (const candidate of ['file_path', 'path', 'filePath']) {
      const value = toolInput[candidate];
      if (typeof value === 'string') return value;
    }
    return null;
  }

  const value = toolInput[field];
  return typeof value === 'string' ? value : null;
}
```

---

## Step 7: BullMQ Workers

Create `apps/hooks-bridge/src/workers/index.ts`:

```typescript
import { Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { DrizzleDb } from '@contextos/db';
import type { Redis } from 'ioredis';
import type { Env } from '@contextos/shared';
import { recordEventWorker } from './record-event.js';
import { assembleContextPackWorker } from './assemble-context-pack.js';

interface WorkerDeps {
  db: DrizzleDb;
  redis: Redis;
  logger: Logger;
  env: Env;
}

export function startWorkers({ db, redis, logger, env }: WorkerDeps): void {
  // Event recording worker
  const eventWorker = new Worker(
    'run-events',
    recordEventWorker({ db, logger }),
    {
      connection: redis,
      concurrency: 10,
    },
  );

  eventWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Event recording job failed');
  });

  // Context pack assembly worker
  const packWorker = new Worker(
    'context-pack-assembly',
    assembleContextPackWorker({ db, redis, logger, env }),
    {
      connection: redis,
      concurrency: 3, // Calls LLM — rate limited
    },
  );

  packWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Context pack assembly job failed');
  });

  logger.info('BullMQ workers started: run-events, context-pack-assembly');
}
```

Create `apps/hooks-bridge/src/workers/record-event.ts`:

```typescript
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { runEvents } from '@contextos/db/schema';
import type { DrizzleDb } from '@contextos/db';
import type { Logger } from 'pino';

interface RecordEventJob {
  runId: string;
  eventType: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  policyDecision?: string;
  policyReason?: string;
  idempotencyKey: string;
}

export function recordEventWorker({ db, logger }: { db: DrizzleDb; logger: Logger }) {
  return async (job: Job<RecordEventJob>) => {
    const { runId, eventType, toolName, toolInput, toolOutput, policyDecision, policyReason, idempotencyKey } =
      job.data;

    // Get next sequence number atomically
    const [seqResult] = await db
      .select({ nextSeq: sql<number>`COALESCE(MAX(sequence_num), 0) + 1` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));

    await db
      .insert(runEvents)
      .values({
        runId,
        sequenceNum: seqResult.nextSeq,
        eventType,
        toolName: toolName ?? null,
        toolInput: toolInput ?? null,
        toolOutput: toolOutput ?? null,
        policyDecision: policyDecision ?? null,
        policyReason: policyReason ?? null,
        idempotencyKey,
      })
      .onConflictDoNothing({ target: runEvents.idempotencyKey });

    logger.debug({ runId, eventType, sequenceNum: seqResult.nextSeq }, 'Event recorded');
  };
}
```

---

## Step 8: Unit Tests (Hono app.request())

Create `apps/hooks-bridge/src/__tests__/pre-tool-use.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../index.js';

describe('POST /hooks/pre-tool-use', () => {
  it('returns allow when no session exists in Redis', async () => {
    // Mock redis.get to return null (no session)
    const res = await app.request('/hooks/pre-tool-use', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-token',
      },
      body: JSON.stringify({
        session_id: 'unknown-session',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/index.ts' },
        tool_use_id: 'tool-001',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('returns deny when policy rule blocks the tool', async () => {
    // Set up: known session in Redis, deny rule in mock DB
    const res = await app.request('/hooks/pre-tool-use', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-token',
      },
      body: JSON.stringify({
        session_id: 'known-session-with-deny-rule',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        tool_use_id: 'tool-002',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain('Policy');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/hooks/pre-tool-use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns allow with malformed payload (non-blocking)', async () => {
    const res = await app.request('/hooks/pre-tool-use', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-test-token',
      },
      body: JSON.stringify({ invalid: 'payload' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
```

---

## Step 9: Integration Tests

Create `apps/hooks-bridge/src/__tests__/integration/lifecycle.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

describe('Full session lifecycle integration', () => {
  // Start real PostgreSQL and Redis containers
  // Insert a test project with deny rule for 'Bash' tool
  // Test the full flow:
  
  it('session start → pre-tool-use allow → post-tool-use → stop creates a run', async () => {
    // 1. POST /hooks/session-start with valid session_id and cwd matching test project
    // 2. Assert run record created in DB
    // 3. Assert Redis key set for session
    
    // 4. POST /hooks/pre-tool-use with Edit tool (allowed)
    // 5. Assert 200 response with permissionDecision: 'allow'
    // 6. Wait for BullMQ job to process (poll with timeout)
    // 7. Assert run_events has PreToolUse entry

    // 8. POST /hooks/post-tool-use
    // 9. Assert 200 response

    // 10. POST /hooks/stop
    // 11. Assert run status updated to 'completed' in DB
    // 12. Assert BullMQ context-pack-assembly job is queued
    // 13. Assert Redis key for session is deleted
  });

  it('pre-tool-use deny blocks Bash command', async () => {
    // Set up session with deny rule for Bash
    // POST /hooks/pre-tool-use with tool_name: 'Bash'
    // Assert response has permissionDecision: 'deny'
  });
});
```

---

## Verification Checklist

After completing all steps, verify:

- [ ] `pnpm turbo run build --filter=@contextos/hooks-bridge` succeeds
- [ ] `pnpm turbo run typecheck --filter=@contextos/hooks-bridge` passes with zero errors
- [ ] `GET /health` returns `200 { "status": "healthy" }`
- [ ] `POST /hooks/session-start` without Authorization returns `401`
- [ ] `POST /hooks/pre-tool-use` with valid token returns `200` with `permissionDecision`
- [ ] Unit tests pass: `pnpm turbo run test:unit --filter=@contextos/hooks-bridge`
- [ ] Redis contains session key after SessionStart hook
- [ ] Redis key is deleted after Stop hook
- [ ] BullMQ worker processes event recording jobs (check Bull Board dashboard)
- [ ] Policy engine correctly denies tool use matching a deny rule
- [ ] Integration test lifecycle passes end-to-end
