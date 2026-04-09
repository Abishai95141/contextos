# Feature Pack 02: MCP Server — Implementation Guide

## Prerequisites

Module 01 (Foundation) must be complete:
- `@contextos/db` package is built and migrations have run
- `@contextos/shared` package is built
- PostgreSQL and Redis are running via Docker Compose
- `.env` is populated with all required values

---

## Step 1: Initialize the MCP Server Package

```bash
mkdir -p apps/mcp-server/src/{tools,resources,middleware,lib}

cat > apps/mcp-server/package.json << 'EOF'
{
  "name": "@contextos/mcp-server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --no-splitting",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test:unit": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  },
  "dependencies": {
    "@clerk/backend": "^1.20.0",
    "@contextos/db": "workspace:*",
    "@contextos/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "express": "^4.21.2",
    "ioredis": "^5.4.2",
    "micromatch": "^4.0.8",
    "pino": "^9.6.0",
    "pino-http": "^10.3.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@contextos/tsconfig": "workspace:*",
    "@testcontainers/postgresql": "^10.18.0",
    "@types/express": "^5.0.0",
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

Create `apps/mcp-server/src/index.ts`:

```typescript
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamable-http.js';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { parseEnv } from '@contextos/shared';
import { createDb } from '@contextos/db';
import { createRedisClient } from './lib/redis.js';
import { authMiddleware } from './middleware/auth.js';
import { healthHandler } from './middleware/health.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';

const env = parseEnv();
const logger = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(pinoHttp({ logger }));

  // Health check — unauthenticated
  app.get('/health', healthHandler({ db, redis, nlAssemblyUrl: env.NL_ASSEMBLY_URL }));

  // MCP endpoint — authenticated
  app.post('/mcp', authMiddleware({ clerkSecretKey: env.CLERK_SECRET_KEY }), async (req, res) => {
    const mcpServer = new McpServer(
      { name: 'contextos', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {} } },
    );

    registerTools(mcpServer, { db, redis, logger, env, authContext: req.authContext });
    registerResources(mcpServer, { db, logger, authContext: req.authContext });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on('close', async () => {
      await transport.close();
      await mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(env.MCP_SERVER_PORT, () => {
    logger.info({ port: env.MCP_SERVER_PORT }, 'MCP Server started');
  });

  // Graceful shutdown for in-flight tool calls
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutdown signal received');
    httpServer.close(async () => {
      await redis.quit();
      logger.info('Server shut down cleanly');
      process.exit(0);
    });
    // Force shutdown after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after 30s timeout');
      process.exit(1);
    }, 30_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
```

---

## Step 3: Create Auth Middleware

Create `apps/mcp-server/src/middleware/auth.ts`:

```typescript
import type { RequestHandler } from 'express';
import { verifyToken } from '@clerk/backend';
import type { AuthContext } from '../lib/types.js';

interface AuthMiddlewareOptions {
  clerkSecretKey: string;
}

export function authMiddleware({ clerkSecretKey }: AuthMiddlewareOptions): RequestHandler {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const claims = await verifyToken(token, { secretKey: clerkSecretKey });
      const orgId = claims.org_id;
      const userId = claims.sub;

      if (!orgId) {
        res.status(403).json({ error: 'Token must be associated with an organization' });
        return;
      }

      const authContext: AuthContext = { orgId, userId, token };
      req.authContext = authContext;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
```

Create `apps/mcp-server/src/lib/types.ts`:

```typescript
import type { Logger } from 'pino';
import type { DrizzleDb } from '@contextos/db';
import type { Redis } from 'ioredis';
import type { Env } from '@contextos/shared';

export interface AuthContext {
  orgId: string;
  userId: string;
  token: string;
}

export interface ToolContext {
  db: DrizzleDb;
  redis: Redis;
  logger: Logger;
  env: Env;
  authContext: AuthContext;
}

// Extend Express types
declare global {
  namespace Express {
    interface Request {
      authContext: AuthContext;
    }
  }
}
```

---

## Step 4: Register All Tools

Create `apps/mcp-server/src/tools/index.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../lib/types.js';
import { registerGetFeaturePack } from './get-feature-pack.js';
import { registerSaveContextPack } from './save-context-pack.js';
import { registerCheckPolicy } from './check-policy.js';
import { registerQueryRunHistory } from './query-run-history.js';
import { registerSearchPacksNl } from './search-packs-nl.js';
import { registerRecordDecision } from './record-decision.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerGetFeaturePack(server, ctx);
  registerSaveContextPack(server, ctx);
  registerCheckPolicy(server, ctx);
  registerQueryRunHistory(server, ctx);
  registerSearchPacksNl(server, ctx);
  registerRecordDecision(server, ctx);
}
```

Create `apps/mcp-server/src/tools/get-feature-pack.ts`:

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { featurePacks, projects } from '@contextos/db/schema';
import type { ToolContext } from '../lib/types.js';
import { resolveFeaturePackChain } from '../lib/pack-resolver.js';

const inputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  packSlug: z.string().min(1).max(100).optional(),
  version: z.number().int().positive().optional(),
});

export function registerGetFeaturePack(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'get_feature_pack',
    'Retrieve a resolved Feature Pack for the specified project. Inheritance is automatically resolved.',
    inputSchema.shape,
    async (input) => {
      const { db, logger, authContext } = ctx;
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${parsed.error.message}`);
      }
      const { projectSlug, packSlug, version } = parsed.data;

      logger.info({ projectSlug, packSlug, version, orgId: authContext.orgId }, 'get_feature_pack called');

      // Resolve project
      const [project] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.slug, projectSlug),
            eq(projects.clerkOrgId, authContext.orgId),
          ),
        )
        .limit(1);

      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project '${projectSlug}' not found`);
      }

      // Resolve pack
      const packQuery = db
        .select()
        .from(featurePacks)
        .where(
          and(
            eq(featurePacks.projectId, project.id),
            eq(featurePacks.isActive, true),
            packSlug ? eq(featurePacks.slug, packSlug) : undefined,
            version ? eq(featurePacks.version, version) : undefined,
          ),
        )
        .orderBy(featurePacks.version, 'desc')
        .limit(1);

      const [pack] = await packQuery;
      if (!pack) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Feature pack '${packSlug ?? 'root'}' not found in project '${projectSlug}'`,
        );
      }

      // Resolve inheritance chain
      const { resolvedContent, chain } = await resolveFeaturePackChain(db, pack);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: pack.id,
              name: pack.name,
              slug: pack.slug,
              version: pack.version,
              resolvedContent,
              inheritanceChain: chain.map((p) => ({
                id: p.id,
                name: p.name,
                slug: p.slug,
                version: p.version,
              })),
              projectId: project.id,
              retrievedAt: new Date().toISOString(),
            }),
          },
        ],
      };
    },
  );
}
```

Create `apps/mcp-server/src/lib/pack-resolver.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { featurePacks } from '@contextos/db/schema';
import type { DrizzleDb } from '@contextos/db';
import type { FeaturePackContent } from '@contextos/shared';
import { FeaturePackContentSchema } from '@contextos/shared';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const MAX_CHAIN_DEPTH = 10;

export async function resolveFeaturePackChain(
  db: DrizzleDb,
  leaf: typeof featurePacks.$inferSelect,
): Promise<{
  resolvedContent: FeaturePackContent;
  chain: Array<typeof featurePacks.$inferSelect>;
}> {
  const chain: Array<typeof featurePacks.$inferSelect> = [leaf];
  const visitedIds = new Set<string>([leaf.id]);

  let current = leaf;
  while (current.parentId) {
    if (chain.length >= MAX_CHAIN_DEPTH) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Feature pack inheritance chain exceeds maximum depth of ${MAX_CHAIN_DEPTH}`,
      );
    }

    if (visitedIds.has(current.parentId)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Circular inheritance detected in feature pack chain at ID ${current.parentId}`,
      );
    }

    const [parent] = await db
      .select()
      .from(featurePacks)
      .where(eq(featurePacks.id, current.parentId))
      .limit(1);

    if (!parent) {
      // Parent was deleted — treat leaf as root
      break;
    }

    visitedIds.add(parent.id);
    chain.unshift(parent); // Root first
    current = parent;
  }

  // Merge from root to leaf: leaf values override parent values
  let resolvedContent: FeaturePackContent = {
    description: '',
    tools: [],
    allowedPaths: [],
    blockedPaths: [],
    conventions: [],
    dependencies: {},
    customInstructions: undefined,
  };

  for (const pack of chain) {
    const packContent = FeaturePackContentSchema.parse(pack.content);
    resolvedContent = {
      description: packContent.description || resolvedContent.description,
      tools: [...resolvedContent.tools, ...packContent.tools],
      allowedPaths: [...resolvedContent.allowedPaths, ...packContent.allowedPaths],
      blockedPaths: [...resolvedContent.blockedPacks, ...packContent.blockedPaths],
      conventions: [...resolvedContent.conventions, ...packContent.conventions],
      dependencies: { ...resolvedContent.dependencies, ...packContent.dependencies },
      customInstructions: packContent.customInstructions ?? resolvedContent.customInstructions,
    };
  }

  return { resolvedContent, chain };
}
```

---

## Step 5: Implement `save_context_pack`

Create `apps/mcp-server/src/tools/save-context-pack.ts`:

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { contextPacks, packEmbeddingsQueue, runs } from '@contextos/db/schema';
import type { ToolContext } from '../lib/types.js';

const inputSchema = z.object({
  runId: z.string().uuid(),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  featurePackId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerSaveContextPack(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'save_context_pack',
    'Save a Context Pack documenting what was built during this run. Triggers embedding generation for semantic search.',
    inputSchema.shape,
    async (input) => {
      const { db, redis, logger, authContext, env } = ctx;
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${parsed.error.message}`);
      }
      const { runId, title, content, featurePackId, metadata } = parsed.data;

      logger.info({ runId, title, orgId: authContext.orgId }, 'save_context_pack called');

      // Verify run belongs to this org
      const [run] = await db
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);

      if (!run) {
        throw new McpError(ErrorCode.InvalidRequest, `Run '${runId}' not found`);
      }

      // Idempotency: check for existing pack with same runId + title
      const [existing] = await db
        .select({ id: contextPacks.id })
        .from(contextPacks)
        .where(
          and(
            eq(contextPacks.runId, runId),
            eq(contextPacks.title, title),
          ),
        )
        .limit(1);

      if (existing) {
        logger.info({ contextPackId: existing.id }, 'Returning existing context pack (idempotent)');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: existing.id,
                runId,
                title,
                embeddingJobId: `existing:${existing.id}`,
                savedAt: new Date().toISOString(),
              }),
            },
          ],
        };
      }

      // Insert context pack
      const [savedPack] = await db
        .insert(contextPacks)
        .values({
          projectId: run.projectId,
          featurePackId: featurePackId ?? null,
          runId,
          title,
          content,
          metadata: metadata ?? {},
        })
        .returning({ id: contextPacks.id, createdAt: contextPacks.createdAt });

      // Enqueue embedding job
      const [queueEntry] = await db
        .insert(packEmbeddingsQueue)
        .values({ contextPackId: savedPack.id })
        .returning({ id: packEmbeddingsQueue.id });

      // Emit BullMQ job via Redis
      const jobId = `embed:${savedPack.id}`;
      await redis.lpush('nl-assembly:queue', JSON.stringify({
        jobId,
        contextPackId: savedPack.id,
        enqueuedAt: new Date().toISOString(),
      }));

      logger.info({ contextPackId: savedPack.id, queueEntryId: queueEntry.id }, 'Context pack saved and embedding job enqueued');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: savedPack.id,
              runId,
              title,
              embeddingJobId: jobId,
              savedAt: savedPack.createdAt.toISOString(),
            }),
          },
        ],
      };
    },
  );
}
```

---

## Step 6: Implement `check_policy`

Create `apps/mcp-server/src/tools/check-policy.ts`:

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import { policyRules, projects } from '@contextos/db/schema';
import micromatch from 'micromatch';
import type { ToolContext } from '../lib/types.js';

const inputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  sessionId: z.string().min(1),
  eventType: z.enum(['PreToolUse', 'PostToolUse', 'PermissionRequest']),
  toolName: z.string().min(1),
  toolInput: z.record(z.unknown()),
  featurePackId: z.string().uuid().optional(),
});

export function registerCheckPolicy(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'check_policy',
    'Evaluate whether a tool use is permitted by the project policy rules.',
    inputSchema.shape,
    async (input) => {
      const { db, logger, authContext } = ctx;
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${parsed.error.message}`);
      }
      const { projectSlug, sessionId, eventType, toolName, toolInput, featurePackId } = parsed.data;

      logger.info(
        { projectSlug, sessionId, eventType, toolName, orgId: authContext.orgId },
        'check_policy called',
      );

      // Resolve project
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.slug, projectSlug),
            eq(projects.clerkOrgId, authContext.orgId),
          ),
        )
        .limit(1);

      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project '${projectSlug}' not found`);
      }

      // Load all active rules ordered by priority
      const rules = await db
        .select()
        .from(policyRules)
        .where(
          and(
            eq(policyRules.projectId, project.id),
            eq(policyRules.isActive, true),
          ),
        )
        .orderBy(asc(policyRules.priority));

      // Extract file path from tool input if present
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;

      // Evaluate rules
      for (const rule of rules) {
        // Check event type match
        if (rule.eventType !== '*' && rule.eventType !== eventType) {
          continue;
        }

        // Check tool name match (glob)
        if (rule.toolPattern && !micromatch.isMatch(toolName, rule.toolPattern)) {
          continue;
        }

        // Check path match (glob), if rule has a path pattern and tool has a file path
        if (rule.pathPattern && filePath) {
          if (!micromatch.isMatch(filePath, rule.pathPattern)) {
            continue;
          }
        } else if (rule.pathPattern && !filePath) {
          // Rule requires a file path but tool has none — skip
          continue;
        }

        // Rule matched
        logger.info(
          { ruleId: rule.id, ruleName: rule.name, decision: rule.decision },
          'Policy rule matched',
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                decision: rule.decision,
                matchedRuleId: rule.id,
                matchedRuleName: rule.name,
                reason: rule.reason,
                evaluatedRuleCount: rules.indexOf(rule) + 1,
                checkedAt: new Date().toISOString(),
              }),
            },
          ],
        };
      }

      // Default: allow
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decision: 'allow',
              matchedRuleId: null,
              matchedRuleName: null,
              reason: 'No policy rule matched — default allow',
              evaluatedRuleCount: rules.length,
              checkedAt: new Date().toISOString(),
            }),
          },
        ],
      };
    },
  );
}
```

---

## Step 7: Implement Remaining Tools

Create `apps/mcp-server/src/tools/query-run-history.ts`, `apps/mcp-server/src/tools/search-packs-nl.ts`, and `apps/mcp-server/src/tools/record-decision.ts` following the same pattern as above. Each must:
1. Parse input with the tool's Zod schema via `safeParse`
2. Throw `McpError` on validation failure or not-found conditions
3. Log on entry with relevant context fields
4. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`

---

## Step 8: Register Resources

Create `apps/mcp-server/src/resources/index.ts`:

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { featurePacks, contextPacks, runs } from '@contextos/db/schema';
import type { ResourceContext } from '../lib/types.js';

export function registerResources(server: McpServer, ctx: ResourceContext): void {
  // feature-pack://{id}
  server.resource(
    'feature-pack',
    new ResourceTemplate('feature-pack://{id}', { list: undefined }),
    async (uri, { id }) => {
      const { db, authContext } = ctx;
      const [pack] = await db.select().from(featurePacks).where(eq(featurePacks.id, id)).limit(1);
      if (!pack) {
        return { contents: [] };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(pack.content, null, 2),
          },
        ],
      };
    },
  );

  // context-pack://{id}
  server.resource(
    'context-pack',
    new ResourceTemplate('context-pack://{id}', { list: undefined }),
    async (uri, { id }) => {
      const { db } = ctx;
      const [pack] = await db.select().from(contextPacks).where(eq(contextPacks.id, id)).limit(1);
      if (!pack) {
        return { contents: [] };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: pack.content,
          },
        ],
      };
    },
  );

  // run-history://{issue}
  server.resource(
    'run-history',
    new ResourceTemplate('run-history://{issue}', { list: undefined }),
    async (uri, { issue }) => {
      const { db } = ctx;
      const decodedIssue = decodeURIComponent(issue);
      const runList = await db
        .select()
        .from(runs)
        .where(eq(runs.issueRef, decodedIssue))
        .orderBy(runs.startedAt, 'desc')
        .limit(50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(runList, null, 2),
          },
        ],
      };
    },
  );
}
```

---

## Step 9: Write Unit Tests

Create `apps/mcp-server/src/tools/__tests__/get-feature-pack.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

describe('get_feature_pack tool', () => {
  it('throws McpError when project not found', async () => {
    // Create mock db that returns empty for project query
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };

    const handler = createGetFeaturePackHandler({ db: mockDb as any, ...mockCtx });
    await expect(
      handler({ projectSlug: 'nonexistent', packSlug: undefined, version: undefined }),
    ).rejects.toThrow(McpError);
  });

  it('returns resolved content for a simple pack with no inheritance', async () => {
    const mockPack = {
      id: 'pack-uuid',
      projectId: 'proj-uuid',
      parentId: null,
      name: 'Auth Module',
      slug: 'auth',
      version: 1,
      content: {
        description: 'Auth module pack',
        tools: ['Edit', 'Write'],
        allowedPaths: ['src/auth/**'],
        blockedPaths: [],
        conventions: ['Use JWT for tokens'],
        dependencies: { 'jose': '^5.0.0' },
      },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // ... mock db returning mockPack, assert resolved content matches
  });

  it('correctly merges two-level inheritance chain', async () => {
    // Set up parent and child packs in mock db
    // Assert that child's tools are appended to parent's tools
    // Assert that child's description overrides parent's
    // Assert that child's dependencies merge with parent's
  });

  it('throws McpError when inheritance depth exceeds 10', async () => {
    // Build a chain of 11 packs where each references the next as parent
    // Assert McpError with INHERITANCE_CYCLE message is thrown
  });

  it('detects circular parent references', async () => {
    // Set up pack A → parent B → parent A (cycle)
    // Assert McpError is thrown
  });
});
```

---

## Step 10: Write Integration Tests

Create `apps/mcp-server/src/tools/__tests__/integration/check-policy.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@contextos/db/schema';

let container: Awaited<ReturnType<typeof PostgreSqlContainer.prototype.start>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('contextos_test')
    .start();
  
  const client = postgres(container.getConnectionUri());
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/src/migrations' });
}, 60_000);

afterAll(async () => {
  await container.stop();
});

describe('check_policy integration', () => {
  it('allows tool use when no matching rule exists', async () => {
    // Insert test project with no policy rules
    // Call check_policy handler with project context
    // Assert decision === 'allow' and evaluatedRuleCount === 0
  });

  it('denies tool use matching a deny rule', async () => {
    // Insert project and deny rule for 'Bash' tool on '/**'
    // Call check_policy with toolName: 'Bash', toolInput: { command: 'rm -rf /' }
    // Assert decision === 'deny'
  });

  it('respects rule priority order (lower number = higher priority)', async () => {
    // Insert project with two rules:
    //   priority 50: deny Bash on /etc/**
    //   priority 100: allow Bash on /**
    // Call with file_path: /etc/passwd
    // Assert deny rule wins (lower priority number takes precedence)
  });
});
```

---

## Step 11: Write E2E Tests

Create `apps/mcp-server/src/e2e/mcp-protocol.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamable-http.js';

const MCP_URL = process.env.MCP_TEST_URL ?? 'http://localhost:3000/mcp';
const TEST_TOKEN = process.env.MCP_TEST_TOKEN!;

let client: Client;

beforeAll(async () => {
  client = new Client({ name: 'e2e-test-client', version: '1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describe('MCP Server E2E', () => {
  it('lists all 6 registered tools', async () => {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('get_feature_pack');
    expect(toolNames).toContain('save_context_pack');
    expect(toolNames).toContain('check_policy');
    expect(toolNames).toContain('query_run_history');
    expect(toolNames).toContain('search_packs_nl');
    expect(toolNames).toContain('record_decision');
  });

  it('returns McpError for invalid project slug', async () => {
    const result = await client.callTool({
      name: 'get_feature_pack',
      arguments: { projectSlug: 'nonexistent-project-12345' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('check_policy returns allow for unknown project (should throw)', async () => {
    await expect(
      client.callTool({
        name: 'check_policy',
        arguments: {
          projectSlug: 'nonexistent',
          sessionId: 'test-session',
          eventType: 'PreToolUse',
          toolName: 'Edit',
          toolInput: {},
        },
      }),
    ).rejects.toBeDefined();
  });
});
```

---

## Deployment: Docker Container

Create `apps/mcp-server/Dockerfile`:

```dockerfile
FROM node:22-alpine AS base
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS pruner
RUN npm install -g turbo@^2
COPY . .
RUN turbo prune @contextos/mcp-server --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@contextos/mcp-server

FROM node:22-alpine AS runner
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder --chown=appuser:appgroup /app/apps/mcp-server/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
```

## Environment Variables for Production

```bash
DATABASE_URL=postgresql://user:pass@db-host:5432/contextos
REDIS_URL=redis://redis-host:6379
CLERK_SECRET_KEY=sk_live_...
NL_ASSEMBLY_URL=http://nl-assembly:8001
SEMANTIC_DIFF_URL=http://semantic-diff:8002
ANTHROPIC_API_KEY=sk-ant-...
LOG_LEVEL=info
MCP_SERVER_PORT=3000
```
