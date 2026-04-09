# Feature Pack 07: VS Code Extension

## Overview

The ContextOS VS Code Extension is the local integration point between the developer's editor and the ContextOS platform. It provides commands for signing in, attaching Feature Packs to projects, triggering runs, and viewing run details — all without leaving VS Code. It also handles auto-configuration of Claude Code's hook settings.

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
  │   ├── Local SQLite Cache (better-sqlite3)
  │   │   ├── projects table
  │   │   ├── feature_packs table
  │   │   ├── runs table (recent 100)
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

Clears the stored token and local SQLite cache.

**Flow**:
1. Delete token from `SecretStorage`
2. Clear SQLite cache tables
3. Show notification: "Signed out of ContextOS"
4. Update status bar item to show "Sign in" state

### `contextos.attachPack`

Shows a Quick Pick list of available Feature Packs for the current project. Writes the selected pack ID to the project's `.contextos.json` file.

**Flow**:
1. Determine current project from workspace root + `cwd`
2. Load Feature Packs from SQLite cache (or fetch from API if stale)
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
1. Show Quick Pick of recent runs (from SQLite cache, ordered by `started_at` desc)
2. On selection: open a WebView panel
3. WebView fetches run details from `{MCP_SERVER_URL}/api/runs/{id}` via the stored token
4. Renders: event timeline, tool names, policy decisions, context pack links

---

## 3. Local SQLite Cache

The SQLite cache provides offline support and reduces API calls. It is managed by `better-sqlite3` (synchronous Node.js SQLite3 bindings).

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

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Cache Staleness Policy

- Feature Packs: stale after 5 minutes
- Projects: stale after 5 minutes
- Runs: stale after 30 seconds (near-realtime)
- On stale: fetch from API and update cache; show stale data while fetching (stale-while-revalidate)

### Offline Behavior

When API is unreachable:
- Commands that only read data (view run details, attach pack) work with cached data
- Commands that write (trigger run) show an error notification
- Extension status bar shows "ContextOS (offline)" indicator

---

## 4. Auto-Configuration of `.claude/settings.json`

When `contextos.attachPack` is run or on first sign-in, the extension checks if `.claude/settings.json` exists in the workspace root. If not (or if the ContextOS hooks are not configured), it offers to configure them:

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

---

## 5. Sync-on-Reconnect Behavior

The extension registers for VS Code's `workspace.onDidChangeWindowState` event. When the window regains focus:

1. Check if the stored token is still valid (call `GET /api/health` with the token)
2. If valid: run a full sync (fetch projects, feature packs, recent runs from API → update SQLite cache)
3. If invalid (401): clear token, show "Session expired — please sign in again" notification

Additionally, on extension activation:
- Register a background sync timer: `setInterval(syncAll, 5 * 60 * 1000)` — every 5 minutes

Full sync fetches from the web app API and updates all SQLite tables. Sync is non-blocking (async) and silent — no notifications unless there are errors.

---

## 6. Status Bar Item

The extension adds a status bar item showing connection status:
- **Signed out**: `$(cloud-slash) ContextOS: Sign In`
- **Signed in, connected**: `$(cloud) ContextOS: {OrgName}`
- **Offline**: `$(warning) ContextOS: Offline`
- **Syncing**: `$(sync~spin) ContextOS: Syncing...`

Clicking the status bar item opens the `contextos.signIn` command (if signed out) or shows a Quick Pick with sign out and sync options (if signed in).
