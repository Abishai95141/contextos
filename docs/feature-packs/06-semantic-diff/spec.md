# Feature Pack 06: Semantic Diff Service

## Overview

The Semantic Diff service analyzes code changes made during an AI coding agent run using a **two-phase architecture**:

1. **Synchronous AST-only structural diff** (200–500ms) — tree-sitter parses changed files, computes structural diffs (functions added/removed, tests added/broken, new modules). This runs in the HTTP request path and returns immediately. No external API dependency.

2. **Asynchronous LLM enrichment** (seconds, background) — A BullMQ worker sends the AST diff + raw diff to Anthropic Claude for natural language summarization. This updates the `semantic_diffs` record in the background. Optional — the system works without it.

This split ensures context pack assembly never blocks on an LLM API call, works fully offline, and still provides rich semantic understanding when the Anthropic API is available.

---

## 1. Architecture

```
Caller: Hooks Bridge (Stop hook → context pack assembly worker)
         │
         │  HTTP POST /analyze  (synchronous, AST-only)
         ▼
┌─────────────────────────────────────────────────────┐
│             Semantic Diff Service (FastAPI)          │
│                                                      │
│  POST /analyze   → AST-only structural diff (sync)   │
│  POST /enrich    → LLM summarization (async worker)   │
│  GET  /health    → Health check                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │     SYNC PATH: AST Parsing Layer (200-500ms) │    │
│  │  - tree-sitter parsing for each changed file │    │
│  │  - Extracts: function sigs, class defs,      │    │
│  │              exports, test names              │    │
│  │  - Computes structural diff between old/new  │    │
│  │  - Returns immediately, no external API calls │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │     ASYNC PATH: LLM Enrichment (background)  │    │
│  │  - Triggered by BullMQ job after /analyze     │    │
│  │  - Anthropic Claude API (Haiku)               │    │
│  │  - Structured prompt with diff + AST context  │    │
│  │  - Updates semantic_diffs record when done     │    │
│  │  - Optional: skipped if ANTHROPIC_API_KEY      │    │
│  │    not configured                              │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Cache Layer                        │    │
│  │  - SHA-256 hash of raw_diff as cache key     │    │
│  │  - Redis: TTL 24h                            │    │
│  │  - Skip LLM enrichment for identical diffs   │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │                        │
    Redis (cache)           BullMQ (enrichment queue)
```

---

## 2. AST Parsing Pipeline

### Supported Languages

The tree-sitter parser supports the languages most commonly used in ContextOS-tracked projects:
- TypeScript / TSX
- JavaScript / JSX
- Python
- Go
- Rust

Language detection is based on file extension: `.ts`, `.tsx` → TypeScript; `.py` → Python; `.go` → Go; `.rs` → Rust; `.js`, `.jsx` → JavaScript.

### What AST Parsing Extracts

For each changed file, the parser extracts from BOTH the old version (from git) and the new version (from the working tree):

**Functions and methods**:
- Function name
- Parameter names and types (where statically available)
- Return type (where statically available)
- Is it exported? (`export function` in TypeScript, public method in Python)
- Is it a test? (name starts with `test_`, `it(`, `describe(`, `test(`)

**Classes**:
- Class name
- Method names
- Is it exported?

**Exports** (TypeScript/JavaScript):
- All named exports from the module
- Default export presence

**Imports** (TypeScript/JavaScript):
- Package names imported (for detecting new external dependencies)

### AST Diff Output

After parsing old and new versions of each file, the AST diff computes:

```python
@dataclass
class FileDiff:
    file_path: str
    language: str
    apis_added: list[str]       # Functions/methods/classes new in this file
    apis_removed: list[str]     # Functions/methods/classes removed
    tests_added: list[str]      # Test functions/describe blocks added
    tests_broken: list[str]     # Test functions that existed and were removed/renamed
    new_module: bool            # True if file didn't exist before (new module)
    new_dependencies: list[str] # New package imports not previously present
```

### Handling Files Without AST Support

For unsupported file extensions (`.json`, `.yaml`, `.md`, `.sql`), the service reports the file as changed but skips AST analysis. The raw diff for these files is included in the LLM enrichment prompt (async path).

---

## 3. Async LLM Enrichment

### Why LLM as a Separate Phase

The `/analyze` endpoint returns AST-only structural data synchronously (200–500ms). This is sufficient for context pack assembly — the context pack records what functions were added/removed, what tests changed, and what new modules appeared.

The LLM enrichment adds *semantic understanding* asynchronously: it explains *why* a change was made, *what* it accomplishes, and whether it introduces breaking changes that aren't syntactically obvious. This runs as a background BullMQ job that updates the `semantic_diffs` record after the context pack is already saved.

**This split exists because:**
- Context pack assembly must not block on an external API call
- The system must work fully offline (no Anthropic API key required)
- LLM enrichment is a nice-to-have, not a requirement for a usable context pack
- Enterprise users may prohibit sending code to external APIs

### LLM Enrichment Prompt

The BullMQ enrichment worker sends the following to the LLM:

```
System: You are a senior software engineer analyzing code changes made by an AI coding agent.
Your task is to produce a structured summary of what changed, focusing on semantic meaning
rather than line-level details. Be concise and precise.

User: Analyze the following code changes and return a JSON object.

## Feature Pack Context
{feature_pack_description}

## Structural Changes (AST Analysis)
{ast_diff_as_json}

## Raw Diff
```diff
{truncated_raw_diff}
```

Return a JSON object with this exact structure:
{
  "summary": "2-3 sentence summary of what changed and why",
  "apis_added": ["list of new API functions/endpoints/methods with brief description"],
  "apis_removed": ["list of removed APIs with brief description"],
  "tests_added": ["list of new tests with what they cover"],
  "tests_broken": ["list of test functions removed or that may be broken"],
  "new_modules": ["list of new files/modules added with their purpose"],
  "breaking_changes": ["list of backward-incompatible changes"],
  "key_decisions": ["notable architectural or implementation decisions visible in the code"]
}
```

### Token Management

- Raw diff truncated to 8,000 tokens (approximately 6,000 words) to keep total prompt under 12,000 tokens
- If diff exceeds limit: the largest files' diffs are truncated first; small files are preserved in full
- The AST diff (structured, compact) is always included in full regardless of size
- Model: `claude-3-5-haiku-20241022` (fast, cost-effective for this structured extraction task)
- **This model is used only in the async enrichment worker, never in the sync `/analyze` path**

---

## 4. Output Structure

The `/analyze` endpoint returns the **AST-only structural diff** synchronously. LLM-enriched fields are populated asynchronously by the enrichment worker.

```typescript
interface AnalysisOutput {
  run_id: string;
  enrichment_status: 'pending' | 'complete' | 'failed' | 'skipped'; // pending = AST-only, complete = LLM enriched, failed = LLM error after retries, skipped = no API key
  // AST-only fields (always populated by /analyze):
  apis_added: string[];               // New public APIs (from AST)
  apis_removed: string[];             // Removed APIs (from AST)
  tests_added: string[];              // New test coverage (from AST)
  tests_broken: string[];             // Test regressions (from AST)
  new_modules: string[];              // New files/modules (from AST)
  files_analyzed: number;             // Count of files in the diff
  analyzed_at: string;                // ISO timestamp
  // LLM-enriched fields (populated async, null until enrichment completes):
  summary: string | null;             // LLM-generated 2-3 sentence summary
  breaking_changes: string[] | null;  // Backward-incompatible changes (requires semantic understanding)
  key_decisions: string[] | null;     // Notable decisions visible in code
  model_used: string | null;          // e.g., 'claude-3-5-haiku-20241022'
  input_tokens: number | null;
  output_tokens: number | null;
  cached: boolean;                    // True if LLM result came from cache
}
```

This output is stored in `semantic_diffs` table and included in the generated Context Pack.

---

## 5. API Endpoints

### POST /analyze (synchronous, AST-only)

**Request**:
```json
{
  "run_id": "uuid-of-run",
  "raw_diff": "--- a/src/auth/index.ts\n+++ b/src/auth/index.ts\n...",
  "changed_files": [
    {
      "file_path": "src/auth/index.ts",
      "old_content": "// old file content",
      "new_content": "// new file content",
      "language": "typescript"
    }
  ],
  "feature_pack_description": "Authentication module handling OAuth flows",
  "project_id": "uuid-of-project"
}
```

**Response** (200 OK):
```json
{
  "run_id": "uuid",
  "enrichment_status": "pending",
  "apis_added": ["handleGoogleCallback(code: string, state: string): Promise<User>"],
  "apis_removed": [],
  "tests_added": ["test_google_callback_validates_state", "test_google_callback_exchanges_code"],
  "tests_broken": [],
  "new_modules": [],
  "files_analyzed": 2,
  "analyzed_at": "2026-01-20T10:00:00Z",
  "summary": null,
  "breaking_changes": null,
  "key_decisions": null,
  "model_used": null,
  "input_tokens": null,
  "output_tokens": null,
  "cached": false
}
```

`enrichment_status` is `pending` (LLM enrichment queued), `skipped` (no `ANTHROPIC_API_KEY`), or `complete` (cache hit from prior enrichment of identical diff).

**Error** (422): Pydantic validation errors for missing or invalid fields.

> **Note:** This endpoint never returns 503 for Anthropic API issues — the LLM is not in the request path.

### POST /enrich (called by BullMQ worker, not by external clients)

The enrichment worker calls this endpoint (or invokes the function directly) to run LLM summarization on a previously-analyzed diff.

**Request**:
```json
{
  "run_id": "uuid",
  "raw_diff": "...",
  "ast_diff": { "...AST output from /analyze..." },
  "feature_pack_description": "Authentication module handling OAuth flows"
}
```

**Response** (200 OK):
```json
{
  "run_id": "uuid",
  "enrichment_status": "complete",
  "summary": "Added Google OAuth callback handler with CSRF state validation...",
  "breaking_changes": [],
  "key_decisions": ["Using jose library for JWT verification instead of jsonwebtoken"],
  "model_used": "claude-3-5-haiku-20241022",
  "input_tokens": 1842,
  "output_tokens": 423
}
```

**Error** (503): Anthropic API unavailable. Worker retries with exponential backoff.

### GET /health

```json
{
  "status": "healthy",
  "anthropic_api": "reachable",
  "enrichment_enabled": true,
  "cache": "healthy",
  "timestamp": "2026-01-20T10:00:00Z"
}
```

`enrichment_enabled` is `true` if `ANTHROPIC_API_KEY` is configured, `false` otherwise. When `false`, the service operates in AST-only mode and `anthropic_api` is reported as `"not_configured"`. This is a valid operating state, not an error.

---

## 6. Caching Strategy

To avoid paying for LLM calls on identical diffs (e.g., re-analyzing the same run):

**Cache key**: `SHA-256(raw_diff)`
**Cache value**: Full JSON response from the LLM enrichment
**Cache backend**: Redis
**TTL**: 86,400 seconds (24 hours)

The cache is checked in two places:
1. **In `/analyze`**: if a cache hit exists, `enrichment_status` is returned as `complete` with the cached LLM fields populated. No BullMQ job is enqueued.
2. **In the enrichment worker**: before calling the LLM API, check cache again (in case another worker already enriched this diff).

Cache hit rate is expected to be low (runs are generally unique) but provides protection against:
- Retry storms if the consumer fails and re-processes a job
- Testing environments that re-run the same fixture diff repeatedly

The cache key uses only the raw_diff (not `run_id` or `project_id`). The same code change in two different projects produces the same semantic diff — caching is correct here.
