# Feature Pack 06: Semantic Diff Service — Implementation Guide

## Prerequisites

Module 01 (Foundation) complete. `uv` installed. `ANTHROPIC_API_KEY` in `.env` is **optional** — without it the service runs in AST-only mode (no LLM enrichment).

---

## Step 1: Initialize the Service

```bash
mkdir -p services/semantic-diff/src/semantic_diff
cd services/semantic-diff

uv init --name semantic-diff --python 3.12
```

Create `services/semantic-diff/pyproject.toml`:

```toml
[project]
name = "semantic-diff"
version = "0.0.1"
description = "Semantic Diff service for ContextOS — AST parsing and LLM diff summarization"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.32.0",
  "anthropic>=0.40.0",
  "tree-sitter>=0.23.0",
  "tree-sitter-languages>=1.10.2",
  "redis[hiredis]>=5.2.0",
  "pydantic>=2.10.0",
  "pydantic-settings>=2.7.0",
  "structlog>=24.4.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.3.0",
  "pytest-asyncio>=0.25.0",
  "httpx>=0.28.0",
  "pytest-cov>=6.0.0",
  "ruff>=0.8.0",
]

[tool.ruff]
target-version = "py312"
line-length = 100
[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "ANN"]
```

```bash
uv sync && uv sync --extra dev
```

---

## Step 2: Project Structure

```
services/semantic-diff/
├── src/
│   └── semantic_diff/
│       ├── __init__.py
│       ├── main.py          # FastAPI app
│       ├── config.py        # Settings
│       ├── ast_parser.py    # tree-sitter AST analysis
│       ├── llm_client.py    # Anthropic API client
│       ├── diff_pipeline.py # Orchestrates full pipeline
│       ├── cache.py         # Redis caching
│       └── models.py        # Pydantic models
├── tests/
│   ├── conftest.py
│   ├── fixtures/            # Known diff files for testing
│   │   ├── add_function.diff
│   │   ├── add_function_old.ts
│   │   ├── add_function_new.ts
│   │   └── expected_output.json
│   ├── test_ast_parser.py
│   ├── test_diff_pipeline.py
│   └── test_cache.py
├── pyproject.toml
└── Dockerfile
```

---

## Step 3: Configuration

Create `services/semantic-diff/src/semantic_diff/config.py`:

```python
from pydantic import RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    anthropic_api_key: str | None = None  # Optional — AST-only mode if absent
    redis_url: RedisDsn
    semantic_diff_model: str = 'claude-3-5-haiku-20241022'
    max_diff_tokens: int = 8000
    cache_ttl_seconds: int = 86400
    log_level: str = 'INFO'
    port: int = 8002


def get_settings() -> Settings:
    return Settings()
```

---

## Step 4: AST Parser

Create `services/semantic-diff/src/semantic_diff/ast_parser.py`:

```python
from dataclasses import dataclass, field
import structlog
from tree_sitter import Language, Parser
from tree_sitter_languages import get_language, get_parser

logger = structlog.get_logger()

EXTENSION_TO_LANGUAGE: dict[str, str] = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
}


@dataclass
class FileSymbols:
    """Symbols extracted from a source file via AST parsing."""
    functions: list[str] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    tests: list[str] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)


@dataclass
class FileDiff:
    """Semantic diff for a single file."""
    file_path: str
    language: str
    apis_added: list[str] = field(default_factory=list)
    apis_removed: list[str] = field(default_factory=list)
    tests_added: list[str] = field(default_factory=list)
    tests_broken: list[str] = field(default_factory=list)
    new_module: bool = False
    new_imports: list[str] = field(default_factory=list)


def detect_language(file_path: str) -> str | None:
    """Detect tree-sitter language from file extension."""
    import os
    _, ext = os.path.splitext(file_path.lower())
    return EXTENSION_TO_LANGUAGE.get(ext)


def extract_symbols(content: str, language: str) -> FileSymbols:
    """Extract function names, class names, exports, and tests from source code.

    Args:
        content: Source code content as a string.
        language: tree-sitter language name ('typescript', 'python', etc.)

    Returns:
        FileSymbols with all extracted symbols.
    """
    symbols = FileSymbols()
    if not content.strip():
        return symbols

    try:
        parser = get_parser(language)
        tree = parser.parse(content.encode('utf-8'))
        root = tree.root_node
    except Exception as exc:
        logger.warning('ast_parse_failed', language=language, error=str(exc))
        return symbols

    # Walk the AST recursively
    _walk_node(root, content, language, symbols)
    return symbols


def _walk_node(
    node,
    source: str,
    language: str,
    symbols: FileSymbols,
    depth: int = 0,
) -> None:
    """Recursively walk AST nodes to extract symbols."""
    if depth > 20:
        return  # Prevent infinite recursion on malformed code

    node_text = source[node.start_byte:node.end_byte]

    if language in ('typescript', 'tsx', 'javascript'):
        _extract_ts_symbols(node, node_text, source, symbols)
    elif language == 'python':
        _extract_python_symbols(node, node_text, source, symbols)

    for child in node.children:
        _walk_node(child, source, language, symbols, depth + 1)


def _extract_ts_symbols(node, node_text: str, source: str, symbols: FileSymbols) -> None:
    """Extract TypeScript/JavaScript symbols."""
    node_type = node.type

    if node_type in ('function_declaration', 'function_expression', 'arrow_function'):
        # Get function name
        name_node = node.child_by_field_name('name')
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte]
            if _is_test_name(name):
                symbols.tests.append(name)
            else:
                symbols.functions.append(name)

    elif node_type == 'class_declaration':
        name_node = node.child_by_field_name('name')
        if name_node:
            symbols.classes.append(source[name_node.start_byte:name_node.end_byte])

    elif node_type == 'export_statement':
        # Track what's exported
        for child in node.children:
            if child.type == 'identifier':
                symbols.exports.append(source[child.start_byte:child.end_byte])

    elif node_type == 'import_statement':
        # Extract package name from import source
        source_node = node.child_by_field_name('source')
        if source_node:
            import_path = source[source_node.start_byte:source_node.end_byte].strip('"\'')
            if not import_path.startswith('.'):  # External package
                symbols.imports.append(import_path)

    elif node_type == 'call_expression':
        # Detect test framework calls: it('name', ...), describe('name', ...), test('name', ...)
        func_node = node.child_by_field_name('function')
        if func_node:
            func_name = source[func_node.start_byte:func_node.end_byte]
            if func_name in ('it', 'describe', 'test', 'it.only', 'test.only'):
                args_node = node.child_by_field_name('arguments')
                if args_node and args_node.children:
                    first_arg = args_node.children[0] if args_node.children else None
                    if first_arg and first_arg.type == 'string':
                        test_name = source[first_arg.start_byte:first_arg.end_byte].strip('"\'`')
                        symbols.tests.append(f'{func_name}({test_name!r})')


def _extract_python_symbols(node, node_text: str, source: str, symbols: FileSymbols) -> None:
    """Extract Python symbols."""
    node_type = node.type

    if node_type == 'function_definition':
        name_node = node.child_by_field_name('name')
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte]
            if name.startswith('test_') or name.startswith('Test'):
                symbols.tests.append(name)
            else:
                symbols.functions.append(name)

    elif node_type == 'class_definition':
        name_node = node.child_by_field_name('name')
        if name_node:
            symbols.classes.append(source[name_node.start_byte:name_node.end_byte])

    elif node_type == 'import_statement' or node_type == 'import_from_statement':
        # Track external imports
        for child in node.children:
            if child.type == 'dotted_name' and not node_text.startswith('from .'):
                symbols.imports.append(source[child.start_byte:child.end_byte])


def _is_test_name(name: str) -> bool:
    """Check if a function name looks like a test."""
    lower = name.lower()
    return lower.startswith('test') or lower.startswith('spec') or lower.startswith('should')


def compute_file_diff(
    file_path: str,
    old_content: str,
    new_content: str,
) -> FileDiff:
    """Compute the semantic diff between old and new content of a file.

    Args:
        file_path: Path to the file (used for language detection).
        old_content: Content before the change (empty string for new files).
        new_content: Content after the change.

    Returns:
        FileDiff with categorized semantic changes.
    """
    language = detect_language(file_path) or 'unknown'

    if language == 'unknown':
        return FileDiff(file_path=file_path, language='unknown', new_module=not old_content)

    old_symbols = extract_symbols(old_content, language)
    new_symbols = extract_symbols(new_content, language)

    old_fns = set(old_symbols.functions + old_symbols.classes)
    new_fns = set(new_symbols.functions + new_symbols.classes)
    old_tests = set(old_symbols.tests)
    new_tests = set(new_symbols.tests)
    old_imports = set(old_symbols.imports)
    new_imports = set(new_symbols.imports)

    return FileDiff(
        file_path=file_path,
        language=language,
        apis_added=sorted(new_fns - old_fns),
        apis_removed=sorted(old_fns - new_fns),
        tests_added=sorted(new_tests - old_tests),
        tests_broken=sorted(old_tests - new_tests),
        new_module=not bool(old_content.strip()),
        new_imports=sorted(new_imports - old_imports),
    )
```

---

## Step 5: LLM Client

Create `services/semantic-diff/src/semantic_diff/llm_client.py`:

```python
import json
import structlog
from anthropic import AsyncAnthropic
from .models import LLMAnalysisResult

logger = structlog.get_logger()

SYSTEM_PROMPT = """You are a senior software engineer analyzing code changes made by an AI coding agent.
Produce a structured summary of what changed, focusing on semantic meaning — not line-level details.
Be concise, precise, and technical. Return ONLY valid JSON, no markdown fences."""

ANALYSIS_PROMPT_TEMPLATE = """Analyze the following code changes and return a JSON object.

## Feature Pack Context
{feature_pack_description}

## Structural Changes (AST Analysis)
{ast_diff_json}

## Raw Diff (may be truncated)
{raw_diff}

Return a JSON object with this EXACT structure (all fields required, use empty arrays if nothing applies):
{{
  "summary": "2-3 sentence summary of what changed and why",
  "apis_added": ["description of each new public API"],
  "apis_removed": ["description of each removed API"],
  "tests_added": ["description of each new test"],
  "tests_broken": ["description of each broken/removed test"],
  "new_modules": ["description of each new file/module"],
  "breaking_changes": ["description of each backward-incompatible change"],
  "key_decisions": ["notable architectural or implementation decision visible in the code"]
}}"""


class LLMClient:
    """Wrapper for Anthropic API calls for diff summarization."""

    def __init__(self, api_key: str, model: str, max_diff_tokens: int) -> None:
        self.client = AsyncAnthropic(api_key=api_key)
        self.model = model
        self.max_diff_tokens = max_diff_tokens

    async def analyze(
        self,
        raw_diff: str,
        ast_diff_json: str,
        feature_pack_description: str,
    ) -> LLMAnalysisResult:
        """Call Claude to analyze a diff and return structured output.

        Args:
            raw_diff: The raw git diff string (will be truncated if too long).
            ast_diff_json: JSON string of the AST-computed FileDiff objects.
            feature_pack_description: Context about the project/pack being worked on.

        Returns:
            LLMAnalysisResult with parsed analysis.

        Raises:
            ValueError: If the LLM returns invalid JSON.
            anthropic.APIError: If the API call fails.
        """
        # Truncate diff to avoid token overflow
        truncated_diff = self._truncate_diff(raw_diff)

        prompt = ANALYSIS_PROMPT_TEMPLATE.format(
            feature_pack_description=feature_pack_description or 'No feature pack context provided.',
            ast_diff_json=ast_diff_json,
            raw_diff=truncated_diff,
        )

        logger.info('calling_anthropic_api', model=self.model, diff_length=len(truncated_diff))

        response = await self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{'role': 'user', 'content': prompt}],
        )

        content = response.content[0].text
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens

        logger.info(
            'anthropic_response_received',
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            logger.error('llm_returned_invalid_json', content=content[:500], error=str(exc))
            raise ValueError(f'LLM returned invalid JSON: {exc}') from exc

        return LLMAnalysisResult(
            summary=parsed.get('summary', ''),
            apis_added=parsed.get('apis_added', []),
            apis_removed=parsed.get('apis_removed', []),
            tests_added=parsed.get('tests_added', []),
            tests_broken=parsed.get('tests_broken', []),
            new_modules=parsed.get('new_modules', []),
            breaking_changes=parsed.get('breaking_changes', []),
            key_decisions=parsed.get('key_decisions', []),
            model_used=self.model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    def _truncate_diff(self, raw_diff: str) -> str:
        """Truncate the raw diff to max_diff_tokens approximate length."""
        # Rough approximation: 4 chars per token
        max_chars = self.max_diff_tokens * 4
        if len(raw_diff) <= max_chars:
            return raw_diff
        # Keep the first max_chars of the diff
        truncated = raw_diff[:max_chars]
        return truncated + '\n\n[... diff truncated to fit context window ...]'
```

---

## Step 6: Diff Pipeline (Orchestrator)

Create `services/semantic-diff/src/semantic_diff/diff_pipeline.py`:

```python
import hashlib
import json
import structlog
from datetime import datetime, timezone
from .ast_parser import compute_file_diff, FileDiff
from .llm_client import LLMClient
from .cache import DiffCache
from .models import AnalyzeRequest, AnalysisOutput

logger = structlog.get_logger()


class DiffPipeline:
    """Orchestrates the full diff analysis pipeline."""

    def __init__(self, llm_client: LLMClient, cache: DiffCache) -> None:
        self.llm_client = llm_client
        self.cache = cache

    async def analyze(self, request: AnalyzeRequest) -> AnalysisOutput:
        """Run the AST-only analysis pipeline for a diff.

        Pipeline:
        1. Check cache for identical diff
        2. Run AST analysis on all changed files
        3. Return AST-only result with enrichment_status='pending'

        LLM enrichment runs asynchronously via a separate BullMQ worker
        that calls the /enrich endpoint. The /analyze endpoint NEVER
        calls the Anthropic API directly.

        Args:
            request: AnalyzeRequest with raw_diff and changed_files.

        Returns:
            AnalysisOutput with AST analysis (LLM fields null until enriched).
        """
        # Step 1: Cache check
        cache_key = hashlib.sha256(request.raw_diff.encode()).hexdigest()
        cached = await self.cache.get(cache_key)
        if cached:
            logger.info('cache_hit', cache_key=cache_key[:16])
            result = AnalysisOutput(**json.loads(cached))
            result.cached = True
            result.run_id = request.run_id  # Update run_id even on cache hit
            return result

        # Step 2: AST analysis
        file_diffs: list[FileDiff] = []
        for changed_file in request.changed_files:
            diff = compute_file_diff(
                file_path=changed_file.file_path,
                old_content=changed_file.old_content,
                new_content=changed_file.new_content,
            )
            file_diffs.append(diff)
            logger.debug(
                'file_analyzed',
                file_path=changed_file.file_path,
                language=diff.language,
                apis_added=len(diff.apis_added),
                tests_added=len(diff.tests_added),
            )

        # Aggregate AST results
        ast_summary = {
            'files_analyzed': len(file_diffs),
            'files': [
                {
                    'path': d.file_path,
                    'language': d.language,
                    'apis_added': d.apis_added,
                    'apis_removed': d.apis_removed,
                    'tests_added': d.tests_added,
                    'tests_broken': d.tests_broken,
                    'new_module': d.new_module,
                    'new_imports': d.new_imports,
                }
                for d in file_diffs
            ],
        }

        # Step 3: Return AST-only result (LLM enrichment happens async via BullMQ worker)
        enrichment_status = 'pending'
        settings = get_settings()
        if not settings.anthropic_api_key:
            enrichment_status = 'skipped'

        output = AnalysisOutput(
            run_id=request.run_id,
            summary=None,  # Populated by async enrichment
            apis_added=[api for d in file_diffs for api in d.apis_added],
            apis_removed=[api for d in file_diffs for api in d.apis_removed],
            tests_added=[t for d in file_diffs for t in d.tests_added],
            tests_broken=[t for d in file_diffs for t in d.tests_broken],
            new_modules=[d.file_path for d in file_diffs if d.new_module],
            breaking_changes=[],  # Populated by async enrichment
            key_decisions=[],  # Populated by async enrichment
            files_analyzed=len(file_diffs),
            enrichment_status=enrichment_status,
            model_used=None,
            input_tokens=None,
            output_tokens=None,
            cached=False,
            analyzed_at=datetime.now(timezone.utc).isoformat(),
        )

        # Step 4: Cache the AST result
        await self.cache.set(cache_key, output.model_dump_json())

        return output
```

---

## Step 7: Tests with Fixtures

Create `services/semantic-diff/tests/fixtures/add_function_new.ts`:

```typescript
export function getUserById(id: string): Promise<User | null> {
  return db.users.findFirst({ where: { id } });
}

export function createUser(data: CreateUserInput): Promise<User> {
  return db.users.create({ data });
}

test('getUserById returns null for unknown user', async () => {
  const result = await getUserById('nonexistent');
  expect(result).toBeNull();
});
```

Create `services/semantic-diff/tests/test_ast_parser.py`:

```python
import pytest
from semantic_diff.ast_parser import extract_symbols, compute_file_diff


TYPESCRIPT_WITH_FUNCTIONS = """
export function handleLogin(email: string, password: string): Promise<User> {
  return auth.login(email, password);
}

export class UserService {
  async getUser(id: string): Promise<User | null> {
    return db.users.findFirst({ where: { id } });
  }
}

test('handleLogin rejects invalid credentials', async () => {
  await expect(handleLogin('bad@email.com', 'wrong')).rejects.toThrow();
});

it('UserService.getUser returns null for unknown id', async () => {
  const result = await new UserService().getUser('nonexistent');
  expect(result).toBeNull();
});
"""


def test_extract_functions_from_typescript() -> None:
    symbols = extract_symbols(TYPESCRIPT_WITH_FUNCTIONS, 'typescript')
    assert 'handleLogin' in symbols.functions


def test_extract_classes_from_typescript() -> None:
    symbols = extract_symbols(TYPESCRIPT_WITH_FUNCTIONS, 'typescript')
    assert 'UserService' in symbols.classes


def test_extract_tests_from_typescript() -> None:
    symbols = extract_symbols(TYPESCRIPT_WITH_FUNCTIONS, 'typescript')
    # Tests via it() and test() calls
    assert len(symbols.tests) >= 2


def test_empty_content_returns_empty_symbols() -> None:
    symbols = extract_symbols('', 'typescript')
    assert symbols.functions == []
    assert symbols.classes == []
    assert symbols.tests == []


def test_compute_file_diff_detects_new_function() -> None:
    old = 'export function foo() {}'
    new = 'export function foo() {}\nexport function bar() {}'
    diff = compute_file_diff('src/utils.ts', old, new)
    assert 'bar' in diff.apis_added
    assert 'foo' not in diff.apis_added  # foo existed before


def test_compute_file_diff_detects_removed_function() -> None:
    old = 'export function foo() {}\nexport function bar() {}'
    new = 'export function foo() {}'
    diff = compute_file_diff('src/utils.ts', old, new)
    assert 'bar' in diff.apis_removed


def test_compute_file_diff_new_module() -> None:
    diff = compute_file_diff('src/new-module.ts', '', 'export const VALUE = 42;')
    assert diff.new_module is True


def test_compute_file_diff_unknown_extension_skips_ast() -> None:
    diff = compute_file_diff('config.yaml', 'key: old', 'key: new')
    assert diff.language == 'unknown'
    assert diff.apis_added == []
```

Create `services/semantic-diff/tests/test_diff_pipeline.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
from semantic_diff.diff_pipeline import DiffPipeline
from semantic_diff.models import AnalyzeRequest, ChangedFile, LLMAnalysisResult


@pytest.fixture
def mock_llm() -> AsyncMock:
    llm = AsyncMock()
    llm.analyze.return_value = LLMAnalysisResult(
        summary='Added getUserById and createUser functions.',
        apis_added=['getUserById(id: string): Promise<User|null>'],
        apis_removed=[],
        tests_added=["getUserById returns null for unknown user"],
        tests_broken=[],
        new_modules=[],
        breaking_changes=[],
        key_decisions=[],
        model_used='claude-3-5-haiku-20241022',
        input_tokens=500,
        output_tokens=100,
    )
    return llm


@pytest.fixture
def mock_cache() -> AsyncMock:
    cache = AsyncMock()
    cache.get.return_value = None  # No cache hit by default
    return cache


@pytest.mark.asyncio
async def test_pipeline_calls_ast_and_llm(mock_llm, mock_cache) -> None:
    pipeline = DiffPipeline(llm_client=mock_llm, cache=mock_cache)

    request = AnalyzeRequest(
        run_id='run-uuid',
        raw_diff='--- a/src/users.ts\n+++ b/src/users.ts\n+export function getUserById() {}',
        changed_files=[
            ChangedFile(
                file_path='src/users.ts',
                old_content='',
                new_content='export function getUserById(id: string) { return null; }',
                language='typescript',
            )
        ],
        project_id='project-uuid',
    )

    result = await pipeline.analyze(request)

    assert result.run_id == 'run-uuid'
    assert result.cached is False
    assert 'getUserById' in result.apis_added[0] or result.summary
    mock_llm.analyze.assert_called_once()
    mock_cache.set.assert_called_once()


@pytest.mark.asyncio
async def test_pipeline_returns_cached_result(mock_llm, mock_cache) -> None:
    # Set up cache to return a pre-cached result
    cached_result = {
        'run_id': 'different-run',
        'summary': 'Cached summary',
        'apis_added': [],
        'apis_removed': [],
        'tests_added': [],
        'tests_broken': [],
        'new_modules': [],
        'breaking_changes': [],
        'key_decisions': [],
        'files_analyzed': 1,
        'model_used': 'claude-3-5-haiku-20241022',
        'input_tokens': 100,
        'output_tokens': 50,
        'cached': False,
        'analyzed_at': '2026-01-01T00:00:00Z',
    }
    import json
    mock_cache.get.return_value = json.dumps(cached_result)

    pipeline = DiffPipeline(llm_client=mock_llm, cache=mock_cache)

    request = AnalyzeRequest(
        run_id='new-run-uuid',
        raw_diff='some diff',
        changed_files=[],
        project_id='project-uuid',
    )

    result = await pipeline.analyze(request)

    # Should return cached result without calling LLM
    assert result.cached is True
    assert result.run_id == 'new-run-uuid'  # Updated to current run_id
    mock_llm.analyze.assert_not_called()
```

---

## Verification Checklist

- [ ] `uv sync` completes
- [ ] `uv run pytest tests/ -v` passes all tests
- [ ] `uv run uvicorn semantic_diff.main:app --port 8002` starts
- [ ] `GET /health` returns `200 { "status": "healthy", "enrichment_enabled": true/false }`
- [ ] `POST /analyze` with a simple TypeScript diff returns AST-only result with `enrichment_status: "pending"` (or `"skipped"` if no API key)
- [ ] `POST /analyze` succeeds even without `ANTHROPIC_API_KEY` configured (AST-only mode)
- [ ] Repeated `/analyze` with the same diff uses the cache (check `cached: true`)
- [ ] `POST /enrich` with an analysis ID triggers LLM enrichment (when `ANTHROPIC_API_KEY` is set)
- [ ] `ruff check src/` passes with no errors
- [ ] Fixture-based tests in `tests/test_diff_pipeline.py` all pass
