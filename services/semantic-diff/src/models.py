"""Pydantic request/response models for the Semantic Diff API."""

from __future__ import annotations

from pydantic import BaseModel, Field


# ── Shared sub-models ────────────────────────────────────────────────────────


class FileDiff(BaseModel):
    """A unified diff for a single file."""

    path: str = Field(..., description="Relative path of the file within the repository")
    old_content: str | None = Field(None, description="Full content of the file before the change")
    new_content: str | None = Field(None, description="Full content of the file after the change")
    language: str | None = Field(
        None,
        description="Source language hint (python, typescript, …). "
        "If omitted the service infers it from the file extension.",
    )


# ── Analyze endpoint ──────────────────────────────────────────────────────────


class AnalyzeRequest(BaseModel):
    """Request body for the /analyze endpoint."""

    files: list[FileDiff] = Field(
        ...,
        description="List of file diffs to analyse",
        min_length=1,
    )
    context: str | None = Field(
        None,
        description="Optional free-text context provided by the developer (e.g. the issue description)",
        max_length=4096,
    )
    include_ast_summary: bool = Field(
        True,
        description="If true, include a tree-sitter AST symbol summary for each file",
    )


class AstSymbol(BaseModel):
    """A top-level symbol extracted by tree-sitter."""

    name: str = Field(..., description="Symbol name (function, class, type, …)")
    kind: str = Field(..., description="Symbol kind: 'function' | 'class' | 'method' | 'type' | 'variable'")
    line: int = Field(..., description="1-based line number in the new content")


class FileSummary(BaseModel):
    """Analysis summary for a single file."""

    path: str = Field(..., description="File path")
    language: str = Field(..., description="Detected language")
    symbols_added: list[str] = Field(default_factory=list, description="Names of symbols added in this file")
    symbols_removed: list[str] = Field(default_factory=list, description="Names of symbols removed in this file")
    symbols_modified: list[str] = Field(default_factory=list, description="Names of symbols modified in this file")
    lines_added: int = Field(0, description="Number of lines added (from unified diff)")
    lines_removed: int = Field(0, description="Number of lines removed")
    ast_symbols: list[AstSymbol] = Field(
        default_factory=list,
        description="Top-level symbols present in the new content (only when include_ast_summary=True)",
    )


class SemanticAnalysis(BaseModel):
    """High-level semantic analysis produced by the LLM."""

    apis_added: list[str] = Field(
        default_factory=list,
        description="Public API surfaces added (function signatures, exported types, …)",
    )
    apis_removed: list[str] = Field(
        default_factory=list,
        description="Public API surfaces removed",
    )
    tests_added: list[str] = Field(
        default_factory=list,
        description="Test cases / test functions added",
    )
    tests_broken: list[str] = Field(
        default_factory=list,
        description="Test cases that appear to have been broken or deleted",
    )
    first_time_touches: list[str] = Field(
        default_factory=list,
        description="Files modified for the first time (no prior history in this diff)",
    )
    breaking_changes: list[str] = Field(
        default_factory=list,
        description="Changes that are likely to break callers",
    )
    summary: str = Field(..., description="One-paragraph natural-language summary of the diff")
    risk_level: str = Field(
        ...,
        description="Estimated risk level: 'low' | 'medium' | 'high'",
    )


class AnalyzeResponse(BaseModel):
    """Response body for the /analyze endpoint."""

    files: list[FileSummary] = Field(..., description="Per-file structural summaries")
    analysis: SemanticAnalysis = Field(..., description="Aggregate semantic analysis")
    total_lines_added: int = Field(..., description="Total lines added across all files")
    total_lines_removed: int = Field(..., description="Total lines removed across all files")
    total_files: int = Field(..., description="Total number of files analysed")


# ── Health endpoint ─────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = Field(..., description="'ok' when the service is healthy")
    model: str = Field(..., description="Anthropic model used for analysis")
    version: str = Field(..., description="Service version string")
