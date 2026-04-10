# Feature Pack 07: VS Code Extension — Technology Choices and Rationale

## 1. VS Code Extension API

### Why a VS Code Extension (Not a Separate App)

Claude Code runs inside VS Code. The developer who uses ContextOS is already in VS Code. A VS Code extension integrates directly into the environment where the developer works:

- **Status bar**: Always-visible connection status without switching windows
- **Quick Pick**: Fast pack selection with keyboard navigation — faster than opening a browser
- **SecretStorage**: Platform-native encrypted credential storage (macOS Keychain, Windows Credential Manager, Linux SecretService) — no custom keychain integration needed
- **WebView**: Rich run details panel embedded in VS Code without a browser
- **URI Handler**: Handles OAuth callbacks from the browser back into the extension without manual copy-paste

A standalone Electron or web app would duplicate the workspace context that VS Code already provides and require users to switch contexts.

### Extension API Key Features Used

**`vscode.authentication`**: The Authentication API provides a standardized way for extensions to authenticate. Sessions are managed by VS Code and shared between extensions. However, ContextOS uses `SecretStorage` directly for the Clerk token because Clerk's PKCE flow doesn't map cleanly to VS Code's OAuth session model.

**`vscode.SecretStorage`**: Encrypted key-value storage that persists per-machine. Tokens stored here are never accessible from extension code on other machines and are encrypted at rest using the OS keychain. This is the correct place for API tokens in VS Code extensions — never use `globalState` for secrets.

**`vscode.window.showQuickPick`**: The primary interaction pattern for the extension. Quick Pick is keyboard-navigable, fuzzy-searchable, and appears inline — much faster than a modal dialog or WebView for selection tasks.

**`vscode.workspace.fs`**: The VS Code file system API for reading and writing workspace files (`.contextos.json`, `.claude/settings.json`). Using `workspace.fs` instead of Node.js `fs` ensures compatibility with remote workspaces (SSH, Dev Containers, Codespaces).

**`vscode.window.createWebviewPanel`**: For the run details view — a complex UI that benefits from HTML/CSS rather than Quick Pick. The WebView fetches run data directly from the ContextOS API using the stored token.

---

## 2. better-sqlite3 + sqlite-vec for Local Primary Store

### Why Local-First

The ContextOS extension uses local SQLite as the **primary data store**, not a cache. All write operations (runs, run events, context packs) are written locally first. Cloud PostgreSQL is the team-sync layer — optional for individual developer use.

This architecture solves three problems:
- **Enterprise blocker**: Code context data never leaves the developer's machine unless they opt in to cloud sync
- **Zero-latency reads**: Pack list, project list, recent runs, semantic search — all served from SQLite in microseconds
- **Full offline support**: Extension is fully operational without network — not just read-only, but writes too

### Why better-sqlite3 (Not sql.js, Not @databases/sqlite)

`better-sqlite3` is the standard synchronous SQLite binding for Node.js:
- **Synchronous API**: VS Code extension hosts run Node.js synchronously in many contexts. `better-sqlite3`'s synchronous API avoids promise chain complexity for simple cache reads.
- **Performance**: Native C++ bindings — faster than any pure-JavaScript SQLite implementation.
- **WAL mode**: `PRAGMA journal_mode = WAL` enables concurrent read access without write locking — important for the sync service and UI commands running concurrently.
- **Well-maintained**: Active maintenance, full SQLite feature support, excellent TypeScript types via `@types/better-sqlite3`.

`sql.js` is a WebAssembly port — useful for browser environments but slower than native bindings in Node.js. `@databases/sqlite` is a thin wrapper around `better-sqlite3` that adds a promise-based API — unnecessary overhead for synchronous operations.

### sqlite-vec for Local Vector Search

`sqlite-vec` is a SQLite extension that adds vector similarity search as a virtual table. It enables the extension to perform local semantic search over feature packs and context packs without requiring a network call to the NL Assembly service.

Key properties:
- **Single binary**: Loads as a SQLite extension — no separate process or service
- **384-dimension vectors**: Compatible with `all-MiniLM-L6-v2` embeddings (same model used by NL Assembly)
- **HNSW index**: Approximate nearest-neighbor search, fast enough for interactive queries
- **Offline semantic search**: Developers can search context packs by natural language without cloud connectivity

Embeddings are generated locally using ONNX Runtime with the MiniLM model. This avoids round-trips to the NL Assembly service for every search query.

### Store Location

The SQLite file is stored at `context.globalStorageUri.fsPath` — the VS Code-provided storage directory for the extension. This directory is:
- Persistent across VS Code sessions
- Extension-specific (not shared with other extensions)
- Cleared when the extension is uninstalled
- Located in the user's home directory, not the workspace

This is the correct location for extension data that should persist globally (across workspaces) but be specific to the ContextOS extension. The filename is `contextos.db` (not `contextos-cache.db` — it is the primary store, not a cache).

---

## 3. VS Code Authentication API for Clerk Integration

### The Integration Challenge

Clerk uses PKCE OAuth flows. The standard OAuth callback URL for VS Code extensions uses the `vscode://` URI scheme. When the user completes authentication in the browser, Clerk redirects to `vscode://contextos-dev.contextos/auth/callback?code=...`, which the OS opens in VS Code.

VS Code extensions handle this via `vscode.window.registerUriHandler()`:

```typescript
context.subscriptions.push(
  vscode.window.registerUriHandler({
    handleUri: async (uri: vscode.Uri) => {
      if (uri.path === '/auth/callback') {
        const params = new URLSearchParams(uri.query);
        const code = params.get('code');
        const orgId = params.get('org_id');
        const orgName = params.get('org_name');
        if (code && orgId && orgName) {
          await auth.handleCallback(code, orgId, orgName);
          statusBar.update('connected');
          vscode.window.showInformationMessage('ContextOS: Signed in successfully');
        }
      }
    },
  }),
);
```

The web app's `/vscode-auth` endpoint initiates the Clerk OAuth flow and then redirects to the `vscode://` callback URI with the authorization code and org information.

### Why Not VS Code's Built-in Authentication

VS Code's `vscode.authentication.createSession()` is designed for providers that register a `vscode.AuthenticationProvider`. This is a heavyweight integration requiring a full provider implementation that handles token refresh, session lifecycle, and event emission.

For ContextOS's needs (store a token, check if valid, clear on sign-out), the direct `SecretStorage` approach is simpler and sufficient. If ContextOS grows to need multi-account support or token refresh integration with VS Code's session model, migrating to a full `AuthenticationProvider` would be the right next step.

### Token Security

Tokens are stored via `context.secrets.store()`, which delegates to:
- macOS: Keychain
- Windows: Windows Credential Manager
- Linux: libsecret (GNOME Keyring or similar)

The token is never written to `globalState`, `workspaceState`, or any file. It never appears in logs (all log statements use `token ? '[present]' : '[absent]'` patterns). This meets the security standard for VS Code extensions handling authentication tokens.

---

## 4. ONNX Runtime for Local Embedding Generation

### Why Local Embeddings

The NL Assembly service (Feature Pack 05) generates embeddings server-side using `sentence-transformers` with the `all-MiniLM-L6-v2` model. But the VS Code extension needs to perform semantic search **locally** — without network access — for the local-first architecture to work. ONNX Runtime enables running the same model locally in the extension's Node.js process.

### Why ONNX Runtime (Not TensorFlow.js, Not WebAssembly)

**`onnxruntime-node`** runs the MiniLM model natively on CPU:
- **Same model, same output**: The `all-MiniLM-L6-v2` model is exported to ONNX format. Local embeddings are numerically identical to server-generated ones — no compatibility issues with sqlite-vec vector search.
- **384-dimensional vectors**: Matches the NL Assembly service and pgvector schema.
- **~50ms per embedding**: Fast enough for interactive search queries.
- **No GPU required**: CPU inference is sufficient for single-query embedding generation.

**vs. TensorFlow.js**: TF.js is heavier (~20MB+ runtime), has more complex model loading, and the ecosystem is shifting toward ONNX for inference-only workloads.

**vs. calling NL Assembly**: This defeats the local-first architecture. If the network is unavailable, semantic search fails. With ONNX, search works offline.

The model file (~90MB ONNX) is bundled with the extension or downloaded on first use. It is stored in the extension's global storage directory alongside the SQLite database.
