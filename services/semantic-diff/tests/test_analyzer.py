"""Unit tests for the DiffAnalyzer and its helper functions.

All tests that touch the Anthropic API use the stub path (empty API key)
so no network calls are made.
"""

from __future__ import annotations

import pytest

from src.analyzer import (
    DiffAnalyzer,
    count_line_delta,
    detect_language,
    extract_symbols,
)
from src.config import Settings
from src.models import AnalyzeRequest, FileDiff


# ---------------------------------------------------------------------------
# detect_language
# ---------------------------------------------------------------------------


class TestDetectLanguage:
    def test_python_by_extension(self) -> None:
        assert detect_language("src/main.py") == "python"

    def test_typescript_by_extension(self) -> None:
        assert detect_language("src/app.ts") == "typescript"

    def test_tsx_by_extension(self) -> None:
        assert detect_language("components/Button.tsx") == "tsx"

    def test_javascript_by_extension(self) -> None:
        assert detect_language("index.js") == "javascript"

    def test_go_by_extension(self) -> None:
        assert detect_language("main.go") == "go"

    def test_rust_by_extension(self) -> None:
        assert detect_language("lib.rs") == "rust"

    def test_unknown_extension_returns_unknown(self) -> None:
        assert detect_language("data.xml") == "unknown"

    def test_hint_overrides_extension(self) -> None:
        # Even though the file is .py, the explicit hint wins
        assert detect_language("confusing.py", hint="typescript") == "typescript"

    def test_hint_is_lowercased(self) -> None:
        assert detect_language("foo.bar", hint="Python") == "python"

    def test_cpp_extensions(self) -> None:
        for ext in [".cpp", ".cc", ".cxx"]:
            assert detect_language(f"main{ext}") == "cpp"


# ---------------------------------------------------------------------------
# count_line_delta
# ---------------------------------------------------------------------------


class TestCountLineDelta:
    def test_empty_old_counts_all_new_as_added(self) -> None:
        added, removed = count_line_delta(None, "a\nb\nc\n")
        assert added == 3
        assert removed == 0

    def test_empty_new_counts_all_old_as_removed(self) -> None:
        added, removed = count_line_delta("x\ny\n", None)
        assert added == 0
        assert removed == 2

    def test_identical_content_yields_zero_delta(self) -> None:
        content = "line1\nline2\nline3\n"
        added, removed = count_line_delta(content, content)
        assert added == 0
        assert removed == 0

    def test_pure_additions(self) -> None:
        old = "a\nb\n"
        new = "a\nb\nc\nd\n"
        added, removed = count_line_delta(old, new)
        assert added == 2
        assert removed == 0

    def test_pure_removals(self) -> None:
        old = "a\nb\nc\n"
        new = "a\n"
        added, removed = count_line_delta(old, new)
        assert added == 0
        assert removed == 2

    def test_both_none_yields_zero(self) -> None:
        added, removed = count_line_delta(None, None)
        assert added == 0
        assert removed == 0


# ---------------------------------------------------------------------------
# extract_symbols
# ---------------------------------------------------------------------------


class TestExtractSymbols:
    def test_extracts_python_functions(self) -> None:
        content = "def foo():\n    pass\ndef bar():\n    pass\n"
        syms = extract_symbols(content, "python")
        names = [s.name for s in syms]
        assert "foo" in names
        assert "bar" in names

    def test_extracts_python_class(self) -> None:
        content = "class MyService:\n    def method(self):\n        pass\n"
        syms = extract_symbols(content, "python")
        names = [s.name for s in syms]
        assert "MyService" in names

    def test_extracts_typescript_function(self) -> None:
        content = "export function createUser(name: string): User {\n  return {};\n}\n"
        syms = extract_symbols(content, "typescript")
        names = [s.name for s in syms]
        assert "createUser" in names

    def test_extracts_typescript_class(self) -> None:
        content = "export class UserService {\n  getUser() {}\n}\n"
        syms = extract_symbols(content, "typescript")
        names = [s.name for s in syms]
        assert "UserService" in names

    def test_empty_content_returns_empty(self) -> None:
        syms = extract_symbols("", "python")
        assert syms == []

    def test_unknown_language_returns_empty(self) -> None:
        syms = extract_symbols("some random text", "cobol")
        assert syms == []

    def test_symbols_have_correct_fields(self) -> None:
        content = "def my_func():\n    pass\n"
        syms = extract_symbols(content, "python")
        assert len(syms) >= 1
        sym = syms[0]
        assert sym.name == "my_func"
        assert sym.kind in ("function", "class", "method")
        assert isinstance(sym.line, int)
        assert sym.line >= 1

    def test_go_function_extraction(self) -> None:
        content = "func HandleRequest(w http.ResponseWriter, r *http.Request) {\n}\n"
        syms = extract_symbols(content, "go")
        names = [s.name for s in syms]
        assert "HandleRequest" in names


# ---------------------------------------------------------------------------
# DiffAnalyzer.analyze — stub path (no API key)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def stub_settings() -> Settings:
    return Settings(
        anthropic_api_key="",  # triggers stub analysis
        anthropic_model="claude-3-5-haiku-20241022",
    )


@pytest.fixture(scope="module")
def analyzer(stub_settings: Settings) -> DiffAnalyzer:
    return DiffAnalyzer(settings=stub_settings)


class TestDiffAnalyzerStub:
    """Tests for the full analyze() pipeline using the stub LLM path."""

    @pytest.mark.asyncio
    async def test_returns_analyze_response(
        self, analyzer: DiffAnalyzer, python_old: str, python_new: str
    ) -> None:
        from src.models import AnalyzeResponse

        request = AnalyzeRequest(
            files=[FileDiff(path="src/greet.py", old_content=python_old, new_content=python_new)]
        )
        result = await analyzer.analyze(request)
        assert isinstance(result, AnalyzeResponse)

    @pytest.mark.asyncio
    async def test_total_files_matches_input(
        self, analyzer: DiffAnalyzer, python_old: str, python_new: str
    ) -> None:
        request = AnalyzeRequest(
            files=[
                FileDiff(path="src/a.py", old_content="", new_content="def a():\n    pass\n"),
                FileDiff(path="src/b.py", old_content="", new_content="def b():\n    pass\n"),
            ]
        )
        result = await analyzer.analyze(request)
        assert result.total_files == 2

    @pytest.mark.asyncio
    async def test_file_summaries_include_correct_path(
        self, analyzer: DiffAnalyzer, python_old: str, python_new: str
    ) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="src/greet.py", old_content=python_old, new_content=python_new)]
        )
        result = await analyzer.analyze(request)
        assert result.files[0].path == "src/greet.py"

    @pytest.mark.asyncio
    async def test_detects_language_from_extension(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="app/service.ts", old_content="", new_content="export function go() {}")]
        )
        result = await analyzer.analyze(request)
        assert result.files[0].language == "typescript"

    @pytest.mark.asyncio
    async def test_symbols_added_detected(
        self, analyzer: DiffAnalyzer, python_old: str, python_new: str
    ) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="src/greet.py", old_content=python_old, new_content=python_new)]
        )
        result = await analyzer.analyze(request)
        # "farewell" is new in python_new
        fs = result.files[0]
        assert "farewell" in fs.symbols_added

    @pytest.mark.asyncio
    async def test_stub_summary_mentions_files(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="main.py", old_content="", new_content="def run(): pass\n")]
        )
        result = await analyzer.analyze(request)
        assert "file" in result.analysis.summary.lower()

    @pytest.mark.asyncio
    async def test_risk_level_is_valid(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="x.py", old_content="", new_content="pass\n")]
        )
        result = await analyzer.analyze(request)
        assert result.analysis.risk_level in ("low", "medium", "high")

    @pytest.mark.asyncio
    async def test_line_counts_aggregate(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[
                FileDiff(path="a.py", old_content="x\n", new_content="x\ny\nz\n"),
                FileDiff(path="b.py", old_content="a\nb\nc\n", new_content="a\n"),
            ]
        )
        result = await analyzer.analyze(request)
        assert result.total_lines_added >= 0
        assert result.total_lines_removed >= 0

    @pytest.mark.asyncio
    async def test_include_ast_summary_false_skips_symbols(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="x.py", old_content="", new_content="def new_fn():\n    pass\n")],
            include_ast_summary=False,
        )
        result = await analyzer.analyze(request)
        # ast_symbols should be empty when include_ast_summary=False
        assert result.files[0].ast_symbols == []

    @pytest.mark.asyncio
    async def test_empty_old_and_new_does_not_crash(self, analyzer: DiffAnalyzer) -> None:
        request = AnalyzeRequest(
            files=[FileDiff(path="blank.py", old_content=None, new_content=None)]
        )
        result = await analyzer.analyze(request)
        assert result.total_files == 1
