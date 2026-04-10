# MCP SDK — Research Reference

All findings apply to `@modelcontextprotocol/sdk ^1.29.0` used by `apps/mcp-server`.

---

## Transport: Streamable HTTP

ContextOS uses **Streamable HTTP** transport — the current standard for server-side MCP deployments (replaces the deprecated SSE transport from spec ≤2024-11-05).

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

const server = new McpServer({ name: 'contextos', version: '0.1.0' });

const app = express();
app.use(express.json());

// Single endpoint — GET+POST+DELETE on /mcp
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
app.all('/mcp', (req, res) => transport.handleRequest(req, res));

await server.connect(transport);
app.listen(config.MCP_SERVER_PORT);
```

Key points:
- **Single endpoint `/mcp`** — GET (SSE stream), POST (JSON-RPC), DELETE (session teardown) all hit the same path
- **Session IDs** — generated server-side via `sessionIdGenerator`; client sends `mcp-session-id` header on subsequent requests
- **State**: `McpServer` is **stateful per session** — if you need to handle concurrent clients, you need a transport instance per session or a stateless pattern
- **Stateless mode**: pass `{ stateless: true }` to the transport for single-request contexts (no streaming)

---

## Tool Registration

Use `server.tool()` — this is the higher-level API over the raw `setRequestHandler`:

```typescript
import { z } from 'zod';

server.tool(
  'get_feature_pack',                     // tool name (snake_case by convention)
  'Retrieve a Feature Pack by ID',        // description (shown to agent)
  {                                        // input schema — plain Zod object shape
    packId: z.string().uuid(),
    version: z.number().int().optional(),
  },
  async (args) => {                        // handler receives validated + typed args
    // args is typed as { packId: string; version?: number }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
);
```

**Important schema notes:**
- The third argument is a **Zod object shape** (the record of keys → Zod types), NOT a `z.object({...})` wrapper
- `args` is automatically typed from the shape — no manual casting required
- The SDK converts the Zod shape to JSON Schema for protocol transport automatically

---

## Tool Response Format

All tool handlers must return `{ content: ContentBlock[] }`:

```typescript
// Success
return {
  content: [{ type: 'text', text: 'result string or JSON.stringify(data)' }],
};

// Multiple content blocks (e.g., text + embedded image)
return {
  content: [
    { type: 'text', text: 'Summary' },
    { type: 'image', data: base64str, mimeType: 'image/png' },
  ],
};

// Error — NEVER throw; return isError instead
return {
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
};
```

**Never throw from a tool handler.** Throwing causes the SDK to return an MCP protocol error, which breaks the agent's flow. Catch all errors and return `isError: true`.

---

## Resource Registration

Resources expose read-only data (docs, file contents, structured context) — distinct from tools which perform actions:

```typescript
server.resource(
  'feature-pack://{packId}',             // URI template
  'Feature Pack content',                // description
  async (uri) => {
    const packId = uri.pathname.slice(1);
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(pack), mimeType: 'application/json' }],
    };
  },
);
```

Resources are listed via `resources/list` and read via `resources/read` — both handled by the SDK routing automatically.

---

## Prompt Registration

Prompts are reusable message templates the agent can retrieve and customize:

```typescript
server.prompt(
  'review-context-pack',
  'Prompt for reviewing a completed Context Pack',
  { runId: z.string().uuid() },
  async (args) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `Review context pack for run ${args.runId}...` } },
    ],
  }),
);
```

ContextOS does not use prompts in Phase 1 — included here for completeness.

---

## Session Lifecycle

```
Client                         MCP Server
  │                               │
  │── POST /mcp (initialize) ────▶│  Server sends: serverInfo, capabilities
  │◀─ 200 + mcp-session-id ───────│
  │                               │
  │── POST /mcp (tools/list) ─────▶│  Returns all registered tool definitions
  │◀─ 200 ────────────────────────│
  │                               │
  │── POST /mcp (tools/call) ─────▶│  Invokes tool handler
  │◀─ 200 (tool result) ──────────│
  │                               │
  │── DELETE /mcp ─────────────────▶│  Closes session + cleans up transport
  │◀─ 200 ────────────────────────│
```

The `initialize` handshake negotiates:
- Protocol version (server advertises, client must match)
- Capabilities: `tools`, `resources`, `prompts` — only advertised if registered

---

## MCP Config Formats by Agent

**Claude Code** — `.mcp.json` at project root:
```json
{
  "mcpServers": {
    "contextos": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

**VS Code Copilot** — `.vscode/mcp.json` (different key!):
```json
{
  "servers": {
    "contextos": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "contextos": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```
Cursor also supports `${env:VARIABLE_NAME}` interpolation in values.

**Key difference**: Claude Code and Cursor use `"mcpServers"`, VS Code Copilot uses `"servers"`. All three support `"type": "http"` with Streamable HTTP.

---

## Error Handling Patterns

```typescript
// Pattern 1: Tool-level try/catch (always do this)
server.tool('my_tool', 'desc', { id: z.string() }, async (args) => {
  try {
    const result = await db.query...;
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    logger.error({ err, toolName: 'my_tool' }, 'Tool failed');
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
      isError: true,
    };
  }
});

// Pattern 2: Validation errors — the SDK validates input against the Zod shape
// before calling the handler, so invalid input never reaches your handler.
// The SDK returns a protocol-level validation error automatically.
```

---

## Testing MCP Tools In-Process

The SDK supports in-process testing without starting an HTTP server:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);
const client = new Client({ name: 'test-client', version: '1.0.0' });
await client.connect(clientTransport);

const result = await client.callTool({ name: 'get_feature_pack', arguments: { packId: '...' } });
expect(result.isError).toBeUndefined();
```

Use `InMemoryTransport` in unit/integration tests — no ports, no HTTP overhead.

---

## ContextOS Tool List

| Tool name | Input schema (in `packages/shared/src/schemas/`) | Purpose |
|-----------|---------------------------------------------------|---------|
| `get_feature_pack` | `GetFeaturePackSchema` | Fetch Feature Pack by project + version |
| `check_policy` | `CheckPolicySchema` | Evaluate a tool-use against policy rules |
| `save_context_pack` | `SaveContextPackSchema` | Persist a completed Context Pack for a run |
| `query_run_history` | `QueryRunHistorySchema` | Retrieve past run summaries |
| `search_packs_nl` | `SearchPacksNlSchema` | Semantic search over Feature Packs |
| `record_decision` | `RecordDecisionSchema` | Log a policy decision for audit |

All schemas live in `packages/shared/src/schemas/` and are re-exported from `packages/shared/src/index.ts`. Tool implementations live in `apps/mcp-server/src/tools/`.

---

## Key Imports Reference

```typescript
// Server
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Testing
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Types
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
```

---

## References

- MCP Spec: https://spec.modelcontextprotocol.io/
- SDK source: https://github.com/modelcontextprotocol/typescript-sdk
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- Hooks docs (Claude Code): https://code.claude.com/docs/en/hooks
