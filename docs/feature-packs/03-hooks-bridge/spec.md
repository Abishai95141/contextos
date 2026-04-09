# Feature Pack 03: Hooks Bridge

## Overview

The Hooks Bridge is an HTTP server that receives lifecycle events from Claude Code (via its hooks system), enforces policies synchronously, records events asynchronously, and assembles Context Packs at session end. It is the runtime enforcement layer of ContextOS — every tool use by Claude Code passes through it before being executed.

---

## 1. Architecture

```
Claude Code (running locally)
         │
         │  HTTP POST to each hook URL
         │  (configured in .claude/settings.json)
         ▼
┌─────────────────────────────────────────────────────┐
│                  Hooks Bridge (Hono)                 │
│                                                      │
│  POST /hooks/session-start                           │
│  POST /hooks/pre-tool-use                            │
│  POST /hooks/post-tool-use                           │
│  POST /hooks/stop                                    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │              Hook Handlers                   │    │
│  │  ┌────────────────────────────────────────┐  │    │
│  │  │ SessionStart → create Run record       │  │    │
│  │  │ PreToolUse  → evaluate policy          │  │    │
│  │  │              → record event (async)    │  │    │
│  │  │              → return allow/deny       │  │    │
│  │  │ PostToolUse → record outcome (async)   │  │    │
│  │  │              → update event record     │  │    │
│  │  │ Stop        → finalize run             │  │    │
│  │  │              → trigger context pack    │  │    │
│  │  └────────────────────────────────────────┘  │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Policy Engine                      │    │
│  │  - Rule matching (glob patterns)             │    │
│  │  - Priority ordering                         │    │
│  │  - Default allow                             │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Run Recorder                       │    │
│  │  - Idempotency key: sessionId+eventType+id   │    │
│  │  - Append-only event log                     │    │
│  │  - BullMQ async processing                   │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │                        │
    PostgreSQL                  Redis
  (run_events table)        (idempotency keys,
                              BullMQ queues)
```

---

## 2. The Four Hooks — Complete Specification

Claude Code calls hooks as HTTP POST requests. The Hooks Bridge must respond with `2xx` within 10 seconds. Non-2xx responses cause Claude Code to log an error and continue (non-blocking). Returning a JSON body with `decision: 'deny'` (on PreToolUse) blocks the tool use.

### Hook 1: `SessionStart`

**URL**: `POST /hooks/session-start`

**Claude Code sends**:
```json
{
  "session_id": "abc123-session-uuid",
  "transcript_path": "/home/user/.claude/projects/myapp/transcript.jsonl",
  "cwd": "/home/user/projects/myapp",
  "hook_event_name": "SessionStart"
}
```

**Hooks Bridge response** (200 OK):
```json
{
  "continue": true
}
```

**Actions**:
1. Parse payload with `HookPayloadSchema`
2. Look up project by `cwd` (match against known project `cwd` patterns stored in project metadata)
3. Create a new `runs` record with `session_id`, `project_id`, `cwd`, `status: 'active'`
4. Store `runId` in Redis keyed by `session:{session_id}:run_id` (expires in 24h)
5. Log: `{ sessionId, runId, cwd, projectSlug }` — "Session started"

**Error handling**:
- If no project matches `cwd`: respond with `200 { "continue": true }` (non-blocking, log warning)
- If DB insert fails: respond with `200 { "continue": true }` (non-blocking, log error)

---

### Hook 2: `PreToolUse`

**URL**: `POST /hooks/pre-tool-use`

**Claude Code sends**:
```json
{
  "session_id": "abc123-session-uuid",
  "transcript_path": "/home/user/.claude/projects/myapp/transcript.jsonl",
  "cwd": "/home/user/projects/myapp",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/home/user/projects/myapp/src/auth/index.ts",
    "old_string": "// TODO",
    "new_string": "// Implemented"
  },
  "tool_use_id": "tool-use-uuid-123"
}
```

**Hooks Bridge response — ALLOW** (200 OK):
```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow"
  }
}
```

**Hooks Bridge response — DENY** (200 OK):
```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Policy violation: editing /etc/ is not allowed"
  }
}
```

**Actions**:
1. Parse payload
2. Retrieve `runId` from Redis: `GET session:{session_id}:run_id`
3. Evaluate policy rules for the run's project (via Policy Engine)
4. Record the event asynchronously (BullMQ job → run_events INSERT)
5. Return allow/deny based on policy evaluation

**Idempotency**: Event recording is keyed by `{session_id}:{tool_use_id}:pre`. If Claude Code retries the hook call, the second DB insert hits `ON CONFLICT DO NOTHING`.

---

### Hook 3: `PostToolUse`

**URL**: `POST /hooks/post-tool-use`

**Claude Code sends**:
```json
{
  "session_id": "abc123-session-uuid",
  "hook_event_name": "PostToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "src/auth/index.ts", "..." },
  "tool_response": {
    "success": true,
    "output": "File edited successfully"
  },
  "tool_use_id": "tool-use-uuid-123"
}
```

**Hooks Bridge response** (200 OK):
```json
{
  "continue": true
}
```

**Actions**:
1. Parse payload
2. Retrieve `runId` from Redis
3. Record the PostToolUse event (BullMQ job → run_events INSERT)
4. Update the corresponding PreToolUse event record with `tool_output`
5. Log tool outcome: `{ toolName, success, sessionId, runId }` — "Tool use completed"

---

### Hook 4: `Stop`

**URL**: `POST /hooks/stop`

**Claude Code sends**:
```json
{
  "session_id": "abc123-session-uuid",
  "hook_event_name": "Stop",
  "cwd": "/home/user/projects/myapp"
}
```

**Hooks Bridge response** (200 OK):
```json
{
  "continue": true
}
```

**Actions**:
1. Parse payload
2. Retrieve `runId` from Redis
3. Update `runs` record: `status = 'completed'`, `completed_at = now()`
4. Enqueue a Context Pack assembly job to BullMQ
5. Delete the Redis key `session:{session_id}:run_id`
6. Log: `{ sessionId, runId, durationMs }` — "Session ended, context pack assembly enqueued"

---

## 3. Request/Response Contracts

### Claude Code Hook Format

Claude Code expects:
- HTTP `2xx` response within 10 seconds (else timeout error, non-blocking)
- `Content-Type: application/json`
- For `PreToolUse` blocking: `{ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: string } }`
- For all others (non-blocking): `{ continue: true }` or any 2xx

The Hooks Bridge must never block Claude Code's main thread. Policy evaluation must complete in under 500ms. If policy evaluation times out, default to `allow` and log the timeout.

### Internal Response Type

```typescript
type HookResponse =
  | { continue: true }
  | {
      hookSpecificOutput: {
        permissionDecision: 'allow' | 'deny';
        permissionDecisionReason?: string;
      };
    };
```

---

## 4. Policy Engine

The Policy Engine evaluates policy rules for a project when a `PreToolUse` hook fires.

### Rule Evaluation Algorithm

```
Input: eventType, toolName, toolInput, projectId

1. Load all active policy rules for projectId
   - ORDER BY priority ASC (lower number = evaluated first)
   - Cached in Redis for 60 seconds to avoid DB query on every hook

2. For each rule in order:
   a. If rule.event_type != eventType AND rule.event_type != '*': SKIP
   b. If rule.tool_pattern AND NOT globMatch(toolName, rule.tool_pattern): SKIP
   c. If rule.path_pattern:
      - Extract file_path from toolInput (tool-specific logic)
      - If no file_path in toolInput: SKIP this path check
      - If NOT globMatch(file_path, rule.path_pattern): SKIP
   d. MATCH: return rule.decision + rule.reason

3. No rule matched: return { decision: 'allow', reason: 'default allow' }
```

### Policy Rule Cache

Rules are cached in Redis per project:
- Key: `policy:project:{projectId}:rules`
- TTL: 60 seconds
- Cache is invalidated when a policy rule is created/updated/deleted (via webhook from the web app)
- If Redis is unavailable: fall back to direct DB query (no caching degradation)

### glob Pattern Examples

```
tool_pattern: 'Bash'          → matches only 'Bash'
tool_pattern: 'Edit|Write'    → matches 'Edit' OR 'Write' (micromatch OR syntax)
tool_pattern: '*'             → matches any tool
path_pattern: '/etc/**'       → matches /etc/passwd, /etc/nginx/nginx.conf
path_pattern: '**/node_modules/**'  → matches any node_modules path
path_pattern: 'src/**/*.ts'   → matches any .ts file under src/
```

---

## 5. Run Recorder

The Run Recorder is responsible for writing hook events to `run_events` reliably and asynchronously.

### Architecture

- Hook handlers return the HTTP response IMMEDIATELY (allow/deny)
- Event recording happens in a BullMQ job AFTER the response is sent
- This keeps hook latency at policy evaluation time only (~10-50ms), not DB write time

### Idempotency Key Format

```
{sessionId}:{hook_event_name}:{tool_use_id}
```

For `SessionStart` and `Stop` (no tool_use_id):
```
{sessionId}:SessionStart:start
{sessionId}:Stop:stop
```

### Event Recording Flow

```
1. Hook handler evaluates policy → sends response
2. Hook handler enqueues BullMQ job: { sessionId, eventType, payload, policyDecision }
3. Worker picks up job:
   a. Lookup runId from DB by sessionId
   b. Determine next sequence_num (SELECT MAX(sequence_num) + 1 FROM run_events WHERE run_id = ?)
   c. INSERT INTO run_events with idempotencyKey ON CONFLICT DO NOTHING
4. If job fails: retry with exponential backoff (max 3 attempts)
5. If all retries fail: log error, mark job as dead-lettered
```

---

## 6. Context Pack Assembly on Stop

When the `Stop` hook fires, the Hooks Bridge enqueues a `context-pack-assembly` BullMQ job. The worker:

1. Loads all `run_events` for the run
2. Extracts file paths edited (from `PreToolUse` events with `tool_name = 'Edit'`)
3. Calls the Semantic Diff service at `SEMANTIC_DIFF_URL/analyze` with the raw diff
4. Formats a Context Pack in markdown:
   ```markdown
   # Context Pack: [Run Summary]
   
   ## Session
   - Session ID: {sessionId}
   - Started: {startedAt}
   - Completed: {completedAt}
   
   ## Files Modified
   - src/auth/index.ts (Edit)
   - src/auth/jwt.ts (Write)
   
   ## Semantic Diff Summary
   {semantic diff summary from LLM}
   
   ## Tool Use Log
   {summary of all tool uses}
   ```
5. Calls the MCP Server's `save_context_pack` tool to save it
6. Updates `runs.status = 'completed'`

---

## 7. Auto-Configuration of `.claude/settings.json`

When a user registers a project with ContextOS (via the web app or VS Code extension), the Hooks Bridge URL is auto-written to the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "curl -s -X POST https://hooks.contextos.dev/hooks/session-start -H 'Content-Type: application/json' -H 'Authorization: Bearer $CONTEXTOS_TOKEN' -d @-"
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "curl -s -X POST https://hooks.contextos.dev/hooks/pre-tool-use -H 'Content-Type: application/json' -H 'Authorization: Bearer $CONTEXTOS_TOKEN' -d @-"
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "curl -s -X POST https://hooks.contextos.dev/hooks/post-tool-use -H 'Content-Type: application/json' -H 'Authorization: Bearer $CONTEXTOS_TOKEN' -d @-"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "curl -s -X POST https://hooks.contextos.dev/hooks/stop -H 'Content-Type: application/json' -H 'Authorization: Bearer $CONTEXTOS_TOKEN' -d @-"
      }
    ]
  }
}
```

The `CONTEXTOS_TOKEN` environment variable is a Clerk M2M token scoped to the project's organization. The VS Code extension manages token refresh and settings file updates.
