# Feature Pack 07: VS Code Extension

## Overview

The ContextOS VS Code Extension is the local integration point between the developer's editor and the ContextOS platform. It provides commands for signing in, attaching Feature Packs to projects, triggering runs, and viewing run details — all without leaving VS Code. It also handles auto-configuration of Claude Code and Cursor hook settings.

The extension uses **local SQLite as the primary data store** (not a cache). Runs, run events, and context packs are written locally first. Cloud PostgreSQL is the team-sync layer — optional for individual developer use.

---

## 1. Architecture

```
VS Code (Developer's machine)
  │
  ├── Extension Host (Node.js)
  │   │
  │   ├── Authentication (VS Code Authentication API → Clerk PKCE flow)
  │   │
  │   ├── Commands
  │   │   ├── contextos.signIn
  │   │   ├── contextos.signOut
  │   │   ├── contextos.attachPack
  │   │   ├── contextos.triggerRun
  │   │   └── contextos.viewRunDetails
  │   │
  │   ├── Local SQLite Primary Store (better-sqlite3 + sqlite-vec)
  │   │   ├── projects table
  │   │   ├── feature_packs table
  │   │   ├── runs table
  │   │   ├── run_events table
  │   │   ├── context_packs table
  │   │   ├── embeddings (sqlite-vec virtual table)
  │   │   └── sync_state table
  │   │
  │   └── Sync Engine
  │       ├── Sync on reconnect
  │       ├── Sync on window focus
  │       └── Background polling (5 min interval)
  │
  └── VS Code UI (WebView)
      ├── Run Details Panel
      └── Pack Attachment Panel
```

---

## 2. Commands

### `contextos.signIn`

Opens a browser-based Clerk OAuth flow using VS Code's `authentication.createSession()` API. After successful authentication, stores the session token in VS Code's `SecretStorage` (encrypted keychain).

**Flow**:
1. Check if already signed in (`secretStorage.get('contextos.token')`)
2. If not: open browser to `{WEB_APP_URL}/vscode-auth?callback=vscode://`
3. Clerk completes PKCE OAuth, redirects to `vscode://contextos.auth/callback?code=...`
4. Extension handles the URI callback, exchanges code for token
5. Store token in VS Code `SecretStorage`
6. Show success notification: "Signed in to ContextOS"
7. Trigger initial sync

**Error handling**:
- OAuth timeout (user closes browser): notify "Sign in cancelled"
- Invalid token from exchange: notify "Sign in failed — please try again"

### `contextos.signOut`

Clears the stored token and local SQLite data.

**Flow**:
1. Delete token from `SecretStorage`
2. Clear SQLite local data tables
3. Show notification: "Signed out of ContextOS"
4. Update status bar item to show "Sign in" state

### `contextos.attachPack`

Shows a Quick Pick list of available Feature Packs for the current project. Writes the selected pack ID to the project's `.contextos.json` file.

**Flow**:
1. Determine current project from workspace root + `cwd`
2. Load Feature Packs from SQLite primary store (or fetch from API if stale)
3. Show Quick Pick: `Pack Name (v{version})` entries
4. On selection: write `{ "featurePackId": "{id}" }` to `.contextos.json` in workspace root
5. Show notification: "Attached pack: {pack name}"

`.contextos.json` format:
```json
{
  "projectSlug": "my-app",
  "featurePackId": "uuid-of-selected-pack",
  "updatedAt": "2026-01-20T10:00:00Z"
}
```

### `contextos.triggerRun`

Opens an input box for the issue reference, then sends a request to the Hooks Bridge's `POST /hooks/session-start` endpoint to register a new run. Claude Code will automatically pick up the Feature Pack context from the MCP server.

**Flow**:
1. Show InputBox: "Enter issue reference (optional, e.g. GH-142)"
2. Get token from SecretStorage
3. POST to `{HOOKS_BRIDGE_URL}/hooks/session-start` with session metadata
4. Show notification with run ID: "Run started — ID: {runId}"

### `contextos.viewRunDetails`

Opens a WebView panel showing run details — event timeline, policy decisions, linked Context Packs.

**Flow**:
1. Show Quick Pick of recent runs (from SQLite primary store, ordered by `started_at` desc)
2. On selection: open a WebView panel
3. WebView renders run details from local SQLite data
4. Renders: event timeline, tool names, policy decisions, context pack links

### `contextos.configureCursorHooks`

Configures Cursor's hook settings for the current workspace. Writes `.cursor/hooks.json` and copies the `contextos.sh` adapter script.

**Flow**:
1. Get token from SecretStorage and Hooks Bridge URL from settings
2. Generate `.cursor/hooks/contextos.sh` adapter script (see Section 4)
3. Write `.cursor/hooks.json` with pre/post command hooks
4. Show notification: "Cursor hooks configured"

### `contextos.importGraphify`

Imports a Graphify `graph.json` output to seed initial Feature Pack content. Each Leiden community in the graph becomes a Feature Pack section.

**Flow**:
1. Show file picker dialog filtered to `*.json` files
2. Parse the selected `graph.json` — validate it has `nodes` and `communities` arrays
3. Group nodes by community ID
4. For each community: generate a Feature Pack section with the community's files and symbols
5. Write the generated Feature Pack to `.contextos/feature-pack-draft.md`
6. Open the generated file in the editor
7. Show notification: "Imported {N} communities as Feature Pack sections"

---

## 3. Local SQLite Primary Store

The local SQLite database is the **primary data store** — not a cache. All write operations (runs, run events, context packs) are written here first. Cloud sync pushes local data to PostgreSQL for team visibility. This architecture eliminates the #1 enterprise blocker (data leaving dev machines) and guarantees sub-millisecond reads with zero network dependency.

The store is managed by `better-sqlite3` (synchronous Node.js SQLite3 bindings) with `sqlite-vec` for vector similarity search.

### Schema

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repo_url TEXT,
  synced_at INTEGER NOT NULL  -- Unix timestamp
);

CREATE TABLE IF NOT EXISTS feature_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,  -- JSON string
  is_active INTEGER NOT NULL DEFAULT 1,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,  -- Unix timestamp
  completed_at INTEGER,
  cwd TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_type TEXT NOT NULL,  -- 'tool_use' | 'policy_decision' | 'context_injection'
  tool_name TEXT,
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  content TEXT NOT NULL,  -- JSON string of the full context pack
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- sqlite-vec virtual table for local embedding search
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[384],  -- sentence-transformers all-MiniLM-L6-v2 dimension
  source_type TEXT,       -- 'feature_pack' | 'context_pack' | 'run_event'
  source_id TEXT
);
```

### Staleness Policy (for cloud-synced data)

- Feature Packs: stale after 5 minutes
- Projects: stale after 5 minutes
- Runs: stale after 30 seconds (near-realtime)
- On stale: fetch from API and update local store; show current data while fetching (stale-while-revalidate)

### Offline Behavior

When API is unreachable:
- **All read operations work** — data is served from the local primary store
- **Write operations succeed locally** — runs, run events, and context packs are written to SQLite
- **Writes are pushed to cloud on reconnect** — the sync engine tracks unsynced local writes
- Extension status bar shows "ContextOS (offline)" indicator
- No functionality is lost — the extension is fully operational offline

---

## 4. Auto-Configuration of Agent Hook Settings

When `contextos.attachPack` is run or on first sign-in, the extension checks if agent hook settings are configured. It supports both Claude Code and Cursor.

### Claude Code Configuration

Checks if `.claude/settings.json` exists in the workspace root. If not (or if the ContextOS hooks are not configured), it offers to configure them:

**Prompt**: "ContextOS: Claude Code hooks are not configured. Configure now?"
- **Yes**: write/merge hooks into `.claude/settings.json`
- **No**: dismiss; user can configure manually

The hook configuration is generated from the user's ContextOS token and the Hooks Bridge URL stored in VS Code settings:

```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "curl -s -X POST https://hooks.contextos.dev/hooks/session-start -H 'Content-Type: application/json' -H 'Authorization: Bearer TOKEN_PLACEHOLDER' -d @-"
    }],
    "PreToolUse": [{
      "type": "command",
      "command": "curl -s -X POST https://hooks.contextos.dev/hooks/pre-tool-use -H 'Content-Type: application/json' -H 'Authorization: Bearer TOKEN_PLACEHOLDER' -d @-"
    }],
    "PostToolUse": [{
      "type": "command",
      "command": "curl -s -X POST https://hooks.contextos.dev/hooks/post-tool-use -H 'Content-Type: application/json' -H 'Authorization: Bearer TOKEN_PLACEHOLDER' -d @-"
    }],
    "Stop": [{
      "type": "command",
      "command": "curl -s -X POST https://hooks.contextos.dev/hooks/stop -H 'Content-Type: application/json' -H 'Authorization: Bearer TOKEN_PLACEHOLDER' -d @-"
    }]
  }
}
```

`TOKEN_PLACEHOLDER` is replaced with the actual token retrieved from `SecretStorage`. The settings file is written using VS Code's `workspace.fs.writeFile()` API.

If `.claude/settings.json` already exists, the extension merges the hooks section without overwriting existing configuration (using `JSON.parse` → merge → `JSON.stringify`).

### Cursor Configuration

After configuring Claude Code hooks (or independently via `contextos.configureCursorHooks`), the extension offers to configure Cursor hooks:

**Prompt**: "ContextOS: Configure Cursor hooks?"
- **Yes**: write `.cursor/hooks.json` and create `.cursor/hooks/contextos.sh`
- **No**: dismiss

The Cursor hook configuration uses the stdin/stdout adapter pattern:

`.cursor/hooks.json`:
```json
{
  "hooks": {
    "pre-command": [{
      "command": ".cursor/hooks/contextos.sh pre-tool-use"
    }],
    "post-command": [{
      "command": ".cursor/hooks/contextos.sh post-tool-use"
    }]
  }
}
```

The `contextos.sh` adapter script reads Cursor's JSON from stdin, normalizes field names (`conversation_id` → `session_id`, `tool` → `tool_name`), POSTs to the Hooks Bridge, and writes the response back to stdout. The full adapter specification is in `docs/SYSTEM-DESIGN.md` Section 15.

---

## 5. Bidirectional Sync Engine

The extension uses a bidirectional sync engine:

**Push (local → cloud):** Unsynced local writes (runs, run events, context packs) are pushed to the cloud API. Each record has a `synced_at` timestamp; records with `synced_at = NULL` are pending push.

**Pull (cloud → local):** Feature packs, projects, and team members' runs are pulled from the cloud API into the local store.

The extension registers for VS Code's `workspace.onDidChangeWindowState` event. When the window regains focus:

1. Check if the stored token is still valid (call `GET /api/health` with the token)
2. If valid: run a full sync (push unsynced local records, then pull projects, feature packs, recent runs from API → update local store)
3. If invalid (401): clear token, show "Session expired — please sign in again" notification

Additionally, on extension activation:
- Register a background sync timer: `setInterval(syncAll, 5 * 60 * 1000)` — every 5 minutes

Full sync runs both push and pull. Push sends unsynced local records to the cloud API. Pull fetches from the web app API and updates the local store. Sync is non-blocking (async) and silent — no notifications unless there are errors. If the cloud API is unreachable, push is deferred and retried on next sync cycle.

---

## 6. Status Bar Item

The extension adds a status bar item showing connection status:
- **Signed out**: `$(cloud-slash) ContextOS: Sign In`
- **Signed in, connected**: `$(cloud) ContextOS: {OrgName}`
- **Offline**: `$(warning) ContextOS: Offline`
- **Syncing**: `$(sync~spin) ContextOS: Syncing...`

Clicking the status bar item opens the `contextos.signIn` command (if signed out) or shows a Quick Pick with sign out and sync options (if signed in).
