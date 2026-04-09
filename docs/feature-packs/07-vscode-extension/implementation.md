# Feature Pack 07: VS Code Extension — Implementation Guide

## Prerequisites

Module 01 (Foundation) complete. Module 02 (MCP Server) and Module 03 (Hooks Bridge) running. Module 04 (Web App) running.

---

## Step 1: Scaffold the Extension

```bash
# Install VS Code Extension scaffolding tool
npm install -g @vscode/vsce yo generator-code

# Scaffold extension in apps/vscode
cd apps
yo code

# Select:
# > New Extension (TypeScript)
# Name: ContextOS
# Identifier: contextos
# Publisher: contextos-dev
# Initialize git: No (already in monorepo)
```

Update `apps/vscode/package.json` for monorepo compatibility:

```json
{
  "name": "contextos",
  "displayName": "ContextOS",
  "description": "AI Agent Context Management for Claude Code",
  "version": "0.0.1",
  "publisher": "contextos-dev",
  "engines": { "vscode": "^1.96.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "contextos.signIn",
        "title": "ContextOS: Sign In"
      },
      {
        "command": "contextos.signOut",
        "title": "ContextOS: Sign Out"
      },
      {
        "command": "contextos.attachPack",
        "title": "ContextOS: Attach Feature Pack"
      },
      {
        "command": "contextos.triggerRun",
        "title": "ContextOS: Trigger Run"
      },
      {
        "command": "contextos.viewRunDetails",
        "title": "ContextOS: View Run Details"
      }
    ],
    "configuration": {
      "title": "ContextOS",
      "properties": {
        "contextos.serverUrl": {
          "type": "string",
          "default": "https://app.contextos.dev",
          "description": "ContextOS web app URL"
        },
        "contextos.hooksUrl": {
          "type": "string",
          "default": "https://hooks.contextos.dev",
          "description": "ContextOS Hooks Bridge URL"
        }
      }
    }
  },
  "scripts": {
    "build": "tsup src/extension.ts --format cjs --no-dts --external=vscode",
    "dev": "tsup src/extension.ts --format cjs --no-dts --external=vscode --watch",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test:unit": "vitest run --coverage"
  },
  "dependencies": {
    "@contextos/shared": "workspace:*",
    "better-sqlite3": "^11.8.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.7",
    "@types/vscode": "^1.96.0",
    "@vitest/coverage-v8": "^2.1.8",
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

---

## Step 2: Extension Entry Point

Create `apps/vscode/src/extension.ts`:

```typescript
import * as vscode from 'vscode';
import { AuthService } from './services/auth.js';
import { CacheService } from './services/cache.js';
import { SyncService } from './services/sync.js';
import { registerCommands } from './commands/index.js';
import { StatusBarService } from './services/status-bar.js';

let syncInterval: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize services
  const cache = new CacheService(context.globalStorageUri.fsPath);
  const auth = new AuthService(context.secrets);
  const statusBar = new StatusBarService();
  const sync = new SyncService(auth, cache);

  // Register commands
  registerCommands(context, { auth, cache, sync, statusBar });

  // Initialize status bar
  statusBar.update('loading');
  context.subscriptions.push(statusBar.item);

  // Check auth state on activation
  const isAuthenticated = await auth.isAuthenticated();
  if (isAuthenticated) {
    statusBar.update('connected');
    // Initial sync
    await sync.syncAll().catch((err) => {
      console.error('[ContextOS] Initial sync failed:', err);
    });
  } else {
    statusBar.update('signed-out');
  }

  // Sync on window focus
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused && (await auth.isAuthenticated())) {
        await sync.syncAll().catch((err) => {
          console.error('[ContextOS] Focus sync failed:', err);
        });
      }
    }),
  );

  // Background sync every 5 minutes
  syncInterval = setInterval(async () => {
    if (await auth.isAuthenticated()) {
      await sync.syncAll().catch(console.error);
    }
  }, 5 * 60 * 1000);

  context.subscriptions.push({
    dispose: () => {
      if (syncInterval) clearInterval(syncInterval);
      cache.close();
    },
  });
}

export function deactivate(): void {
  if (syncInterval) clearInterval(syncInterval);
}
```

---

## Step 3: Auth Service

Create `apps/vscode/src/services/auth.ts`:

```typescript
import * as vscode from 'vscode';

const TOKEN_KEY = 'contextos.auth.token';
const ORG_KEY = 'contextos.auth.orgId';
const ORG_NAME_KEY = 'contextos.auth.orgName';

export class AuthService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getToken(): Promise<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    if (!token) return false;
    // Verify token is still valid with a lightweight API call
    try {
      const serverUrl = vscode.workspace.getConfiguration('contextos').get<string>('serverUrl');
      const res = await fetch(`${serverUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.status === 200;
    } catch {
      return false; // Network error — assume offline, not invalid
    }
  }

  async signIn(): Promise<void> {
    const serverUrl = vscode.workspace.getConfiguration('contextos').get<string>('serverUrl');
    const callbackUrl = `vscode://contextos-dev.contextos/auth/callback`;
    const authUrl = `${serverUrl}/vscode-auth?callback=${encodeURIComponent(callbackUrl)}`;

    // Open browser for auth
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    // Wait for callback (registered via registerUriHandler)
    // The callback handler calls this.handleCallback()
  }

  async handleCallback(code: string, orgId: string, orgName: string): Promise<void> {
    const serverUrl = vscode.workspace.getConfiguration('contextos').get<string>('serverUrl');

    // Exchange code for token
    const res = await fetch(`${serverUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      throw new Error(`Token exchange failed: ${res.status}`);
    }

    const { token } = await res.json() as { token: string };

    await this.secrets.store(TOKEN_KEY, token);
    await this.secrets.store(ORG_KEY, orgId);
    await this.secrets.store(ORG_NAME_KEY, orgName);
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    await this.secrets.delete(ORG_KEY);
    await this.secrets.delete(ORG_NAME_KEY);
  }

  async getOrgName(): Promise<string | undefined> {
    return this.secrets.get(ORG_NAME_KEY);
  }
}
```

---

## Step 4: SQLite Cache Service

Create `apps/vscode/src/services/cache.ts`:

```typescript
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repo_url TEXT,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  cwd TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface CachedProject {
  id: string;
  slug: string;
  name: string;
  repoUrl: string | null;
  syncedAt: number;
}

export interface CachedFeaturePack {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  version: number;
  content: unknown;
  isActive: boolean;
  syncedAt: number;
}

export interface CachedRun {
  id: string;
  projectId: string;
  sessionId: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  cwd: string;
  metadata: unknown;
}

export class CacheService {
  private db: Database.Database;

  constructor(storagePath: string) {
    // Ensure storage directory exists
    fs.mkdirSync(storagePath, { recursive: true });
    const dbPath = path.join(storagePath, 'contextos-cache.db');
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA_SQL);
    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  upsertProjects(projects: CachedProject[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO projects (id, slug, name, repo_url, synced_at)
      VALUES (@id, @slug, @name, @repoUrl, @syncedAt)
    `);
    const upsertMany = this.db.transaction((rows: CachedProject[]) => {
      for (const row of rows) stmt.run(row);
    });
    upsertMany(projects);
  }

  getProjects(): CachedProject[] {
    return this.db
      .prepare('SELECT id, slug, name, repo_url as repoUrl, synced_at as syncedAt FROM projects')
      .all() as CachedProject[];
  }

  upsertFeaturePacks(packs: CachedFeaturePack[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO feature_packs (id, project_id, name, slug, version, content, is_active, synced_at)
      VALUES (@id, @projectId, @name, @slug, @version, @content, @isActive, @syncedAt)
    `);
    const upsertMany = this.db.transaction((rows: CachedFeaturePack[]) => {
      for (const row of rows) {
        stmt.run({
          ...row,
          content: JSON.stringify(row.content),
          isActive: row.isActive ? 1 : 0,
        });
      }
    });
    upsertMany(packs);
  }

  getActivePacksForProject(projectId: string): CachedFeaturePack[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id as projectId, name, slug, version, content, is_active as isActive, synced_at as syncedAt
         FROM feature_packs WHERE project_id = ? AND is_active = 1 ORDER BY name ASC`,
      )
      .all(projectId) as Array<CachedFeaturePack & { content: string; isActive: number }>;

    return rows.map((r) => ({
      ...r,
      content: JSON.parse(r.content) as unknown,
      isActive: r.isActive === 1,
    }));
  }

  upsertRuns(runs: CachedRun[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runs (id, project_id, session_id, status, started_at, completed_at, cwd, metadata)
      VALUES (@id, @projectId, @sessionId, @status, @startedAt, @completedAt, @cwd, @metadata)
    `);
    const upsertMany = this.db.transaction((rows: CachedRun[]) => {
      for (const row of rows) {
        stmt.run({ ...row, metadata: JSON.stringify(row.metadata) });
      }
    });
    upsertMany(runs);
  }

  getRecentRuns(limit: number = 20): CachedRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id as projectId, session_id as sessionId, status,
                started_at as startedAt, completed_at as completedAt, cwd, metadata
         FROM runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Array<CachedRun & { metadata: string }>;

    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) as unknown }));
  }

  close(): void {
    this.db.close();
  }
}
```

---

## Step 5: Register Commands

Create `apps/vscode/src/commands/index.ts`:

```typescript
import * as vscode from 'vscode';
import type { AuthService } from '../services/auth.js';
import type { CacheService } from '../services/cache.js';
import type { SyncService } from '../services/sync.js';
import type { StatusBarService } from '../services/status-bar.js';

interface CommandDeps {
  auth: AuthService;
  cache: CacheService;
  sync: SyncService;
  statusBar: StatusBarService;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
): void {
  const { auth, cache, sync, statusBar } = deps;

  // Sign In
  context.subscriptions.push(
    vscode.commands.registerCommand('contextos.signIn', async () => {
      try {
        await auth.signIn();
        // Token is stored in handleCallback — called by URI handler
      } catch (err) {
        vscode.window.showErrorMessage(`ContextOS: Sign in failed — ${err}`);
      }
    }),
  );

  // Sign Out
  context.subscriptions.push(
    vscode.commands.registerCommand('contextos.signOut', async () => {
      await auth.signOut();
      cache.close();
      statusBar.update('signed-out');
      vscode.window.showInformationMessage('ContextOS: Signed out');
    }),
  );

  // Attach Pack
  context.subscriptions.push(
    vscode.commands.registerCommand('contextos.attachPack', async () => {
      const projects = cache.getProjects();
      if (projects.length === 0) {
        vscode.window.showWarningMessage('ContextOS: No projects found. Sign in and sync first.');
        return;
      }

      const projectItems = projects.map((p) => ({
        label: p.name,
        description: p.slug,
        projectId: p.id,
      }));

      const selectedProject = await vscode.window.showQuickPick(projectItems, {
        placeHolder: 'Select a project',
      });
      if (!selectedProject) return;

      const packs = cache.getActivePacksForProject(selectedProject.projectId);
      const packItems = packs.map((p) => ({
        label: `${p.name}`,
        description: `v${p.version}`,
        packId: p.id,
        packName: p.name,
      }));

      const selectedPack = await vscode.window.showQuickPick(packItems, {
        placeHolder: 'Select a Feature Pack to attach',
      });
      if (!selectedPack) return;

      // Write .contextos.json
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('ContextOS: No workspace folder open.');
        return;
      }

      const configPath = vscode.Uri.joinPath(workspaceFolder.uri, '.contextos.json');
      const config = {
        projectSlug: selectedProject.description,
        featurePackId: selectedPack.packId,
        updatedAt: new Date().toISOString(),
      };
      await vscode.workspace.fs.writeFile(
        configPath,
        Buffer.from(JSON.stringify(config, null, 2)),
      );

      vscode.window.showInformationMessage(`ContextOS: Attached pack "${selectedPack.packName}"`);

      // Offer to configure Claude Code hooks
      await offerHookConfiguration(workspaceFolder, auth);
    }),
  );

  // View Run Details
  context.subscriptions.push(
    vscode.commands.registerCommand('contextos.viewRunDetails', async () => {
      const runs = cache.getRecentRuns(20);
      if (runs.length === 0) {
        vscode.window.showInformationMessage('ContextOS: No recent runs found.');
        return;
      }

      const items = runs.map((r) => ({
        label: `$(${r.status === 'completed' ? 'check' : r.status === 'active' ? 'sync~spin' : 'error'}) ${r.sessionId.slice(0, 8)}`,
        description: `${r.status} · ${new Date(r.startedAt).toLocaleDateString()}`,
        runId: r.id,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a run to view details',
      });
      if (!selected) return;

      // Open WebView panel with run details
      const panel = vscode.window.createWebviewPanel(
        'contextosRunDetails',
        `Run: ${selected.label}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );

      const token = await auth.getToken();
      const serverUrl = vscode.workspace.getConfiguration('contextos').get<string>('serverUrl');
      panel.webview.html = getRunDetailsHtml(selected.runId, serverUrl!, token!);
    }),
  );
}

async function offerHookConfiguration(
  workspaceFolder: vscode.WorkspaceFolder,
  auth: AuthService,
): Promise<void> {
  const settingsPath = vscode.Uri.joinPath(workspaceFolder.uri, '.claude', 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    const bytes = await vscode.workspace.fs.readFile(settingsPath);
    existing = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Record<string, unknown>;
  } catch {
    // File doesn't exist — start fresh
  }

  const hasHooks = existing.hooks !== undefined;
  if (hasHooks) return; // Already configured

  const answer = await vscode.window.showInformationMessage(
    'ContextOS: Configure Claude Code hooks?',
    'Yes',
    'Not now',
  );

  if (answer !== 'Yes') return;

  const token = await auth.getToken();
  const hooksUrl = vscode.workspace.getConfiguration('contextos').get<string>('hooksUrl');

  const makeCmd = (hookPath: string) =>
    `curl -s -X POST ${hooksUrl}/hooks/${hookPath} -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' -d @-`;

  const hooks = {
    SessionStart: [{ type: 'command', command: makeCmd('session-start') }],
    PreToolUse: [{ type: 'command', command: makeCmd('pre-tool-use') }],
    PostToolUse: [{ type: 'command', command: makeCmd('post-tool-use') }],
    Stop: [{ type: 'command', command: makeCmd('stop') }],
  };

  const merged = { ...existing, hooks };

  // Ensure .claude directory exists
  const claudeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.claude');
  try {
    await vscode.workspace.fs.createDirectory(claudeDir);
  } catch {
    // Directory may already exist
  }

  await vscode.workspace.fs.writeFile(
    settingsPath,
    Buffer.from(JSON.stringify(merged, null, 2)),
  );

  vscode.window.showInformationMessage('ContextOS: Claude Code hooks configured in .claude/settings.json');
}

function getRunDetailsHtml(runId: string, serverUrl: string, token: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Run Details</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 16px; }
    .loading { color: var(--vscode-descriptionForeground); }
    .event { margin-bottom: 8px; padding: 8px; border-left: 3px solid var(--vscode-activityBarBadge-background); }
    .event.deny { border-color: var(--vscode-errorForeground); }
    .event.allow { border-color: var(--vscode-gitDecoration-addedResourceForeground); }
  </style>
</head>
<body>
  <h2>Run Details</h2>
  <div id="content" class="loading">Loading...</div>
  <script>
    (async () => {
      const res = await fetch('${serverUrl}/api/runs/${runId}', {
        headers: { Authorization: 'Bearer ${token}' }
      });
      const data = await res.json();
      const el = document.getElementById('content');
      if (!res.ok) {
        el.innerHTML = '<p class="error">Failed to load run details.</p>';
        return;
      }
      el.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
    })();
  </script>
</body>
</html>`;
}
```

---

## Step 6: Unit Tests

Create `apps/vscode/src/__tests__/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../services/cache.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let tmpDir: string;
let cache: CacheService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-'));
  cache = new CacheService(tmpDir);
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true });
});

describe('CacheService', () => {
  it('upserts and retrieves projects', () => {
    const now = Date.now();
    cache.upsertProjects([{
      id: 'proj-1',
      slug: 'my-app',
      name: 'My App',
      repoUrl: null,
      syncedAt: now,
    }]);

    const projects = cache.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe('my-app');
    expect(projects[0].name).toBe('My App');
  });

  it('upserts and retrieves active feature packs for a project', () => {
    const now = Date.now();
    cache.upsertProjects([{ id: 'proj-1', slug: 'my-app', name: 'My App', repoUrl: null, syncedAt: now }]);
    cache.upsertFeaturePacks([
      { id: 'pack-1', projectId: 'proj-1', name: 'Auth Pack', slug: 'auth', version: 1, content: { description: 'Auth' }, isActive: true, syncedAt: now },
      { id: 'pack-2', projectId: 'proj-1', name: 'Core Pack', slug: 'core', version: 2, content: { description: 'Core' }, isActive: false, syncedAt: now },
    ]);

    const packs = cache.getActivePacksForProject('proj-1');
    expect(packs).toHaveLength(1); // Only active packs
    expect(packs[0].slug).toBe('auth');
  });

  it('upserts and retrieves recent runs ordered by startedAt desc', () => {
    const now = Date.now();
    cache.upsertRuns([
      { id: 'run-1', projectId: 'proj-1', sessionId: 'sess-1', status: 'completed', startedAt: now - 1000, completedAt: now, cwd: '/app', metadata: {} },
      { id: 'run-2', projectId: 'proj-1', sessionId: 'sess-2', status: 'active', startedAt: now, completedAt: null, cwd: '/app', metadata: {} },
    ]);

    const runs = cache.getRecentRuns(10);
    expect(runs[0].id).toBe('run-2'); // Most recent first
    expect(runs[1].id).toBe('run-1');
  });

  it('updates project on upsert (idempotent)', () => {
    const now = Date.now();
    cache.upsertProjects([{ id: 'proj-1', slug: 'my-app', name: 'Old Name', repoUrl: null, syncedAt: now }]);
    cache.upsertProjects([{ id: 'proj-1', slug: 'my-app', name: 'New Name', repoUrl: null, syncedAt: now + 1 }]);

    const projects = cache.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('New Name'); // Updated
  });
});
```

---

## Verification Checklist

- [ ] `pnpm turbo run build --filter=contextos` succeeds
- [ ] `pnpm turbo run typecheck --filter=contextos` passes with zero errors
- [ ] Extension activates in VS Code without errors (check Output → ContextOS)
- [ ] `contextos.signIn` opens a browser window
- [ ] After sign-in, status bar updates to show org name
- [ ] `contextos.attachPack` shows a Quick Pick with packs from cache
- [ ] Attaching a pack writes `.contextos.json` to workspace root
- [ ] Hook configuration offer appears after pack attachment
- [ ] `.claude/settings.json` is created/updated with hook commands
- [ ] `contextos.viewRunDetails` shows recent runs from cache
- [ ] SQLite cache persists between VS Code sessions
- [ ] Extension works in offline mode (shows cached data)
- [ ] Unit tests pass: `pnpm turbo run test:unit --filter=contextos`
