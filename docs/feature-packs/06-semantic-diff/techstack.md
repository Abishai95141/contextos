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

## 3. Anthropic Claude API for Summarization

### Why LLM for Diff Summarization

Pure AST diff can tell you what changed syntactically. It cannot tell you:
- Why a change was made
- What the change accomplishes for the user
- Whether a change is likely to introduce bugs
- What architectural pattern is being applied

The LLM synthesizes the raw diff and AST context into natural language that a developer can understand at a glance. This is the primary value of the Semantic Diff service.

### Why Claude (Anthropic) Over GPT-4

ContextOS already requires `ANTHROPIC_API_KEY` for the Claude Code integration. Using Anthropic's API for the Semantic Diff service avoids introducing a second LLM vendor dependency.

Claude Haiku (`claude-3-5-haiku-20241022`) is the correct model for this task:
- **Speed**: Haiku is the fastest Claude model. Diff analysis is a blocking step in the context pack assembly pipeline. Low latency matters.
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

## 4. LLM-Generated vs. Pure AST Diff — Tradeoffs

### Pure AST Diff Approach

**Pros**:
- Deterministic: same input always produces same output
- No LLM API cost
- No LLM API latency
- Works offline

**Cons**:
- Only syntactic information: "function X was added" not "X implements OAuth CSRF protection"
- No business-level interpretation
- Cannot understand the *purpose* of a change
- Cannot identify breaking changes that aren't syntactically obvious (e.g., a behavior change inside a function)

### LLM-Augmented Approach (ContextOS's choice)

**Pros**:
- Semantic understanding: explains WHY and WHAT, not just WHAT CHANGED
- Identifies breaking changes that AST analysis cannot detect
- Produces human-readable summaries for Context Pack archives
- Enables the "search context packs by natural language" use case (the summary is embedded)

**Cons**:
- API cost (mitigated by caching identical diffs)
- API latency (mitigated by Haiku model + async processing via BullMQ worker)
- Non-deterministic (mitigated by structured JSON output format and temperature=0 default)
- Vendor dependency (mitigated by: Anthropic is the primary LLM partner for ContextOS anyway)

**Decision**: The LLM-augmented approach is clearly better for ContextOS's use case. The Context Pack archive is a knowledge base for developers and AI agents. "Function X was added" is marginally useful; "Added CSRF-protected OAuth callback handler using state parameter validation" is genuinely useful.

The AST analysis is still performed first and included in the LLM prompt — it provides structure that makes the LLM's analysis more reliable and specific. The two approaches are complementary, not competing.
