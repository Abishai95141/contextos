# Feature Pack 06: Semantic Diff Service

## Overview

The Semantic Diff service analyzes code changes made during a Claude Code run and produces a structured, human-readable summary. It combines AST-level parsing (via tree-sitter) with LLM-based natural language summarization (via Anthropic Claude) to produce output that tells developers exactly what changed, at the semantic level — not just which lines changed.

---

## 1. Architecture

```
Caller: Hooks Bridge (Stop hook → context pack assembly worker)
         │
         │  HTTP POST /analyze
         ▼
┌─────────────────────────────────────────────────────┐
│             Semantic Diff Service (FastAPI)          │
│                                                      │
│  POST /analyze   → Full diff analysis pipeline       │
│  GET  /health    → Health check                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           AST Parsing Layer                  │    │
│  │  - tree-sitter parsing for each changed file │    │
│  │  - Extracts: function sigs, class defs,      │    │
│  │              exports, test names              │    │
│  │  - Computes structural diff between old/new  │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           LLM Summarization Layer            │    │
│  │  - Anthropic Claude API                      │    │
│  │  - Structured prompt with diff + AST context │    │
│  │  - Returns: JSON with summary + categorized  │    │
│  │    changes                                   │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Cache Layer                        │    │
│  │  - SHA-256 hash of raw_diff as cache key     │    │
│  │  - Redis: TTL 24h                            │    │
│  │  - Skip LLM for identical diffs              │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │
    Redis (cache)
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

For unsupported file extensions (`.json`, `.yaml`, `.md`, `.sql`), the service reports the file as changed but skips AST analysis. The LLM prompt includes the raw diff for these files.

---

## 3. LLM-Based Diff Summarization

### Why LLM for Summarization

Pure AST diff can tell you "function `handleOAuthCallback` was added". It cannot tell you "the OAuth callback now validates the state parameter to prevent CSRF attacks". The semantic meaning of the change — the *why* and *what it does* — requires understanding the code's logic.

The LLM receives:
1. The raw git diff (limited to 8,000 tokens to manage cost)
2. The structured AST diff output
3. The project's Feature Pack context (conventions, architecture description)

It returns a structured JSON response with a natural language summary and categorized change descriptions.

### Prompt Design

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

---

## 4. Output Structure

The `/analyze` endpoint returns:

```typescript
interface AnalysisOutput {
  run_id: string;
  summary: string;                    // LLM-generated 2-3 sentence summary
  apis_added: string[];               // New public APIs
  apis_removed: string[];             // Removed APIs (breaking change risk)
  tests_added: string[];              // New test coverage
  tests_broken: string[];             // Test regressions
  new_modules: string[];              // New files/modules
  breaking_changes: string[];         // Backward-incompatible changes
  key_decisions: string[];            // Notable decisions visible in code
  files_analyzed: number;             // Count of files in the diff
  model_used: string;                 // e.g., 'claude-3-5-haiku-20241022'
  input_tokens: number;
  output_tokens: number;
  cached: boolean;                    // True if result came from cache
  analyzed_at: string;                // ISO timestamp
}
```

This output is stored in `semantic_diffs` table and included in the generated Context Pack.

---

## 5. API Endpoints

### POST /analyze

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
  "summary": "Added Google OAuth callback handler with CSRF state validation...",
  "apis_added": ["handleGoogleCallback(code: string, state: string): Promise<User>"],
  "apis_removed": [],
  "tests_added": ["test_google_callback_validates_state", "test_google_callback_exchanges_code"],
  "tests_broken": [],
  "new_modules": [],
  "breaking_changes": [],
  "key_decisions": ["Using jose library for JWT verification instead of jsonwebtoken"],
  "files_analyzed": 2,
  "model_used": "claude-3-5-haiku-20241022",
  "input_tokens": 1842,
  "output_tokens": 423,
  "cached": false,
  "analyzed_at": "2026-01-20T10:00:00Z"
}
```

**Error** (422): Pydantic validation errors for missing or invalid fields.
**Error** (503): Anthropic API unavailable.

### GET /health

```json
{
  "status": "healthy",
  "anthropic_api": "reachable",
  "cache": "healthy",
  "timestamp": "2026-01-20T10:00:00Z"
}
```

---

## 6. Caching Strategy

To avoid paying for LLM calls on identical diffs (e.g., re-analyzing the same run):

**Cache key**: `SHA-256(raw_diff)`
**Cache value**: Full JSON response from the LLM
**Cache backend**: Redis
**TTL**: 86,400 seconds (24 hours)

Cache hit rate is expected to be low (runs are generally unique) but provides protection against:
- Retry storms if the consumer fails and re-processes a job
- Testing environments that re-run the same fixture diff repeatedly

The cache key uses only the raw_diff (not `run_id` or `project_id`). The same code change in two different projects produces the same semantic diff — caching is correct here.
