# Feature Pack 06: Semantic Diff — Technology Choices and Rationale

## 1. Why Python for This Service

The Semantic Diff service does two things: parse source code into ASTs, and call an LLM API. Both have Python advantages:

**AST parsing**: tree-sitter has both Python and JavaScript bindings. However, the Python ecosystem for code analysis is more mature: Python's built-in `ast` module handles Python code natively with zero dependencies; `tree-sitter-languages` provides pre-compiled parsers for 50+ languages in a single pip package; code analysis tools (jedi, pygments, semgrep Python bindings) all have Python as their primary target.

**LLM API calls**: The Anthropic Python SDK is a first-class, feature-complete implementation. JavaScript/TypeScript SDK is also first-class. This is neutral.

**Operational benefit**: NL Assembly and Semantic Diff are both Python services. If deployed together (shared container or sidecar), they share the Python runtime environment, reducing operational overhead.

---

## 2. tree-sitter + tree-sitter-languages

### What tree-sitter Provides

tree-sitter is a parser generator that builds concrete syntax trees (CSTs) for source code. It was originally developed for use in editors (the Neovim and VS Code ecosystem uses it for syntax highlighting) and has become the standard for language-agnostic code analysis.

Key properties relevant to ContextOS:
- **Error recovery**: tree-sitter can parse incomplete or malformed code and still return a useful (partial) AST. This is essential for analyzing diffs where code may be in transitional states.
- **Incremental parsing**: tree-sitter can reparse only the changed portions of a file. For large files with small diffs, this is significantly faster.
- **Multi-language**: One parsing API across all supported languages. The Semantic Diff service uses a single `compute_file_diff` function for TypeScript, Python, Go, and Rust.

### tree-sitter-languages

The `tree-sitter-languages` Python package provides pre-compiled tree-sitter grammars for 150+ languages as a single pip dependency. Without it, each language grammar requires a separate compilation step from C source during installation (complex, platform-specific, slow).

With `tree-sitter-languages`:
```python
from tree_sitter_languages import get_parser
parser = get_parser('typescript')  # Pre-compiled grammar, no C compilation
```

This makes the Dockerfile simpler (no need for gcc, cmake, or tree-sitter CLI) and ensures consistent grammar versions across environments.

### Limitation: CST vs. Semantic Analysis

tree-sitter produces a Concrete Syntax Tree (CST), not a full semantic model. It cannot:
- Resolve type aliases or generics
- Track variable bindings across scopes
- Understand TypeScript's structural typing

For ContextOS's use case — identifying which functions were added/removed and which tests were added/broken — CST analysis is sufficient. The function name appears directly in the AST without requiring type resolution.

For deeper semantic analysis (e.g., "did the behavior of function X change?"), a full language server (tsserver for TypeScript, pyright for Python) would be needed. That is out of scope for ContextOS's Semantic Diff service, which uses the LLM for semantic interpretation.

---

## 3. Anthropic Claude API for Async Enrichment

### Why LLM Enrichment Exists (and Why It Is Async)

Pure AST diff can tell you what changed syntactically. It cannot tell you:
- Why a change was made
- What the change accomplishes for the user
- Whether a change is likely to introduce bugs
- What architectural pattern is being applied

The LLM synthesizes the raw diff and AST context into natural language that a developer can understand at a glance.

**Critically, the LLM call is NOT in the synchronous `/analyze` path.** The `/analyze` endpoint returns AST-only results in 200–500ms. LLM enrichment runs asynchronously via a BullMQ worker that calls the `/enrich` endpoint. This means:
- The sync path never blocks on LLM latency or availability
- If `ANTHROPIC_API_KEY` is not configured, the service operates in AST-only mode — fully functional, just without enrichment
- LLM failures do not degrade the core diff analysis pipeline

### Why Claude (Anthropic) Over GPT-4

ContextOS uses Anthropic's API across its ecosystem. Using Anthropic's API for the Semantic Diff enrichment avoids introducing a second LLM vendor dependency. Note: `ANTHROPIC_API_KEY` is **optional** for the Semantic Diff service — the service starts and serves AST-only analysis without it.

Claude Haiku (`claude-3-5-haiku-20241022`) is the correct model for this task:
- **Speed**: Haiku is the fastest Claude model. Even though enrichment is async, lower latency means enrichment results are available sooner for Context Pack assembly.
- **Cost**: Haiku is significantly cheaper than Sonnet or Opus. Diff analysis runs on every session stop — cost efficiency is important at scale.
- **Quality**: Haiku is more than capable for structured extraction from code diffs. The structured JSON output format constrains the task sufficiently that the full power of Opus is not needed.

### Structured Output Enforcement

The prompt instructs Claude to return ONLY valid JSON. The response is parsed with `json.loads()`. If parsing fails, the error is logged and the exception is propagated (triggering a BullMQ retry in the calling worker). This is more reliable than trying to parse JSON from markdown code fences.

Future improvement: Anthropic's JSON mode or tool use can guarantee valid JSON responses. Implementing this would eliminate the `json.loads` error case.

### Token Budget Management

The diff is truncated to 8,000 tokens (approximately 32,000 characters) before sending to Claude. This:
- Keeps the total prompt under 12,000 tokens (within Haiku's context window)
- Manages cost (fewer input tokens = lower cost)
- Focuses the LLM on the most important changes (smaller files are preserved in full; very large files are truncated)

The AST diff (structured, compact JSON) is always sent in full regardless of token budget, since it provides the structure that guides the LLM's analysis.

---

## 4. Two-Phase Architecture — AST-Only Sync + LLM Async Enrichment

ContextOS uses **both** approaches as complementary phases, not competing alternatives:

### Phase 1: Synchronous AST-Only Analysis (always runs)

- Deterministic: same input always produces same output
- No LLM API cost or latency
- Works offline and without `ANTHROPIC_API_KEY`
- Returns in 200–500ms via `POST /analyze`
- Provides: `apis_added`, `apis_removed`, `tests_added`, `tests_broken`, `new_modules`, `new_imports`
- Output has `enrichment_status: "pending"` (or `"skipped"` if no API key)

### Phase 2: Asynchronous LLM Enrichment (runs when available)

- Semantic understanding: explains WHY and WHAT, not just WHAT CHANGED
- Identifies breaking changes that AST analysis cannot detect
- Produces human-readable summaries for Context Pack archives
- Enables the "search context packs by natural language" use case (the summary is embedded)
- Runs via BullMQ worker calling `POST /enrich`
- Updates `enrichment_status` to `"complete"` (or `"failed"` on error)

### Why This Split

The original design had LLM analysis in the synchronous path. This was wrong for three reasons:
1. **Latency**: LLM calls add 2–10s to every diff analysis — unacceptable for a blocking pipeline step
2. **Availability**: If Anthropic's API is down, the entire diff pipeline fails — AST results are lost too
3. **Enterprise deployment**: Some environments cannot send code to external LLM APIs. AST-only mode is a valid, complete operating state.

The AST analysis is included in the LLM enrichment prompt — it provides structure that makes the LLM's analysis more reliable and specific. The two phases are complementary: AST provides the "what", LLM adds the "why".
