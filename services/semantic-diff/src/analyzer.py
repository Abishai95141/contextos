"""Semantic diff analyser — combines tree-sitter AST parsing with Anthropic LLM analysis.

Flow for each analysis request:
  1. Parse each file's old/new content with tree-sitter to extract top-level
     symbols (functions, classes, types) and count line changes.
  2. Build a structured prompt that includes the file diffs and symbol deltas.
  3. Call the Anthropic Messages API to produce a high-level semantic summary.
  4. Return a combined :class:`AnalyzeResponse`.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import anthropic

from .config import Settings, get_settings
from .models import AnalyzeRequest, AnalyzeResponse, AstSymbol, FileDiff, FileSummary, SemanticAnalysis

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

_EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
}


def detect_language(path: str, hint: str | None = None) -> str:
    """Return the source language for *path*, using *hint* if provided."""
    if hint:
        return hint.lower()
    ext = Path(path).suffix.lower()
    return _EXT_TO_LANG.get(ext, "unknown")


# ---------------------------------------------------------------------------
# AST parsing with tree-sitter
# ---------------------------------------------------------------------------

# Minimal regex-based fallbacks so tests don't need the compiled tree-sitter
# grammars.  Production will use tree-sitter-languages.

_PYTHON_SYMBOL_RE = re.compile(r"^(def|class|async def)\s+([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)
_TS_SYMBOL_RE = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)
_GO_SYMBOL_RE = re.compile(r"^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)
_RUST_SYMBOL_RE = re.compile(r"^(?:pub\s+)?(?:fn|struct|enum|trait|type|impl)\s+([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)


def _extract_symbols_regex(content: str, language: str) -> list[tuple[str, str, int]]:
    """Return list of (name, kind, line) tuples using a regex fallback.

    Used when tree-sitter-languages is not available or the language is
    unsupported.
    """
    patterns: dict[str, re.Pattern[str]] = {
        "python": _PYTHON_SYMBOL_RE,
        "typescript": _TS_SYMBOL_RE,
        "tsx": _TS_SYMBOL_RE,
        "javascript": _TS_SYMBOL_RE,
        "jsx": _TS_SYMBOL_RE,
        "go": _GO_SYMBOL_RE,
        "rust": _RUST_SYMBOL_RE,
    }
    pattern = patterns.get(language)
    if pattern is None:
        return []

    results: list[tuple[str, str, int]] = []
    for m in pattern.finditer(content):
        line = content[: m.start()].count("\n") + 1
        raw_kind = m.group(1).strip() if language == "python" else "symbol"
        kind = "class" if "class" in raw_kind else "function"
        name = m.group(2) if language == "python" else m.group(1)
        results.append((name, kind, line))
    return results


def _try_tree_sitter_extract(content: str, language: str) -> list[tuple[str, str, int]] | None:
    """Attempt tree-sitter-based extraction; return None on failure."""
    try:
        from tree_sitter_languages import get_language, get_parser  # type: ignore[import]

        lang_obj = get_language(language)
        parser = get_parser(language)
        tree = parser.parse(content.encode())
        root = tree.root_node
        results: list[tuple[str, str, int]] = []
        for node in root.children:
            if node.type in ("function_definition", "async_function_definition", "function_declaration"):
                for child in node.children:
                    if child.type == "identifier":
                        results.append((child.text.decode(), "function", node.start_point[0] + 1))
                        break
            elif node.type in ("class_definition", "class_declaration"):
                for child in node.children:
                    if child.type == "identifier":
                        results.append((child.text.decode(), "class", node.start_point[0] + 1))
                        break
        return results
    except Exception:
        return None


def extract_symbols(content: str, language: str) -> list[AstSymbol]:
    """Extract top-level symbols from *content* for *language*."""
    if not content:
        return []
    raw = _try_tree_sitter_extract(content, language) or _extract_symbols_regex(content, language)
    return [AstSymbol(name=name, kind=kind, line=line) for name, kind, line in raw]


# ---------------------------------------------------------------------------
# Line-count helpers
# ---------------------------------------------------------------------------


def count_line_delta(old: str | None, new: str | None) -> tuple[int, int]:
    """Return (lines_added, lines_removed) comparing *old* to *new*.

    Uses the simple heuristic: if content is absent it's treated as empty.
    """
    old_lines = set(old.splitlines()) if old else set()
    new_lines = set(new.splitlines()) if new else set()
    added = len(new_lines - old_lines)
    removed = len(old_lines - new_lines)
    return added, removed


# ---------------------------------------------------------------------------
# LLM prompt construction
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are an expert software engineer performing a semantic code review.
Given a structured diff summary, produce a JSON object describing the high-level semantic
changes. You must respond with ONLY valid JSON matching the schema below — no markdown,
no explanation outside the JSON.

Schema:
{
  "apis_added": ["..."],
  "apis_removed": ["..."],
  "tests_added": ["..."],
  "tests_broken": ["..."],
  "first_time_touches": ["..."],
  "breaking_changes": ["..."],
  "summary": "One-paragraph summary of the diff",
  "risk_level": "low|medium|high"
}"""


def _build_user_prompt(request: AnalyzeRequest, file_summaries: list[FileSummary]) -> str:
    """Build the user-turn prompt for the Anthropic API call."""
    lines: list[str] = ["# Code Diff Analysis Request\n"]

    if request.context:
        lines.append(f"## Developer Context\n{request.context}\n")

    lines.append("## Files Changed\n")
    for fs in file_summaries:
        lines.append(f"### {fs.path} ({fs.language})")
        lines.append(f"- Lines added: {fs.lines_added}, removed: {fs.lines_removed}")
        if fs.symbols_added:
            lines.append(f"- Symbols added: {', '.join(fs.symbols_added)}")
        if fs.symbols_removed:
            lines.append(f"- Symbols removed: {', '.join(fs.symbols_removed)}")
        if fs.symbols_modified:
            lines.append(f"- Symbols modified: {', '.join(fs.symbols_modified)}")
        lines.append("")

    # Include abbreviated diffs for small files
    lines.append("## Abbreviated Diffs\n")
    for file_diff in request.files[:20]:  # cap at 20 files to stay within token limits
        old = file_diff.old_content or ""
        new = file_diff.new_content or ""
        if len(old) + len(new) < 8000:
            lines.append(f"### {file_diff.path}")
            if old:
                lines.append("**Before (first 30 lines):**")
                lines.append("```")
                lines.extend(old.splitlines()[:30])
                lines.append("```")
            if new:
                lines.append("**After (first 30 lines):**")
                lines.append("```")
                lines.extend(new.splitlines()[:30])
                lines.append("```")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Diff Analyser
# ---------------------------------------------------------------------------


class DiffAnalyzer:
    """Orchestrates AST parsing and LLM analysis for a set of file diffs."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._client = anthropic.Anthropic(api_key=self._settings.anthropic_api_key)

    async def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse:
        """Run the full analysis pipeline for *request*.

        Steps:
          1. Parse AST symbols for each file.
          2. Compute line deltas.
          3. Call Anthropic to produce semantic summary.
          4. Assemble and return :class:`AnalyzeResponse`.
        """
        file_summaries = self._build_file_summaries(request)

        semantic = await self._run_llm_analysis(request, file_summaries)

        total_added = sum(fs.lines_added for fs in file_summaries)
        total_removed = sum(fs.lines_removed for fs in file_summaries)

        return AnalyzeResponse(
            files=file_summaries,
            analysis=semantic,
            total_lines_added=total_added,
            total_lines_removed=total_removed,
            total_files=len(file_summaries),
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_file_summaries(self, request: AnalyzeRequest) -> list[FileSummary]:
        summaries: list[FileSummary] = []
        for fd in request.files:
            lang = detect_language(fd.path, fd.language)
            old_symbols = {s.name for s in extract_symbols(fd.old_content or "", lang)}
            new_symbols_list = extract_symbols(fd.new_content or "", lang) if request.include_ast_summary else []
            new_symbols = {s.name for s in new_symbols_list}

            added = sorted(new_symbols - old_symbols)
            removed = sorted(old_symbols - new_symbols)
            modified = sorted(old_symbols & new_symbols)  # rough heuristic: present in both

            lines_added, lines_removed = count_line_delta(fd.old_content, fd.new_content)

            summaries.append(
                FileSummary(
                    path=fd.path,
                    language=lang,
                    symbols_added=added,
                    symbols_removed=removed,
                    symbols_modified=modified,
                    lines_added=lines_added,
                    lines_removed=lines_removed,
                    ast_symbols=new_symbols_list,
                )
            )
        return summaries

    async def _run_llm_analysis(
        self, request: AnalyzeRequest, file_summaries: list[FileSummary]
    ) -> SemanticAnalysis:
        """Call Anthropic and parse the JSON response."""
        if not self._settings.anthropic_api_key:
            logger.warning("ANTHROPIC_API_KEY not set — returning stub analysis")
            return self._stub_analysis(file_summaries)

        prompt = _build_user_prompt(request, file_summaries)

        try:
            message = self._client.messages.create(
                model=self._settings.anthropic_model,
                max_tokens=self._settings.anthropic_max_tokens,
                system=_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = message.content[0].text
            data = json.loads(raw)
            return SemanticAnalysis(**data)
        except json.JSONDecodeError as exc:
            logger.error("LLM returned invalid JSON: %s", exc)
            return self._stub_analysis(file_summaries)
        except Exception as exc:
            logger.exception("LLM analysis failed: %s", exc)
            return self._stub_analysis(file_summaries)

    def _stub_analysis(self, file_summaries: list[FileSummary]) -> SemanticAnalysis:
        """Return a best-effort stub when LLM is unavailable."""
        apis_added: list[str] = []
        for fs in file_summaries:
            apis_added.extend(fs.symbols_added)

        return SemanticAnalysis(
            apis_added=apis_added,
            apis_removed=[sym for fs in file_summaries for sym in fs.symbols_removed],
            tests_added=[],
            tests_broken=[],
            first_time_touches=[],
            breaking_changes=[],
            summary=(
                f"Diff touches {len(file_summaries)} file(s). "
                "LLM analysis unavailable — AST-based summary only."
            ),
            risk_level="medium",
        )
