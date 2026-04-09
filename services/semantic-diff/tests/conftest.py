"""Pytest fixtures shared across Semantic Diff test modules."""

from __future__ import annotations

from unittest.mock import MagicMock, AsyncMock

import pytest
from fastapi.testclient import TestClient

from src.analyzer import DiffAnalyzer
from src.config import Settings
from src.main import app
from src.models import SemanticAnalysis


@pytest.fixture(scope="session")
def test_settings() -> Settings:
    """Return Settings with safe test defaults (no real API key needed)."""
    return Settings(
        anthropic_api_key="",  # empty key triggers stub analysis
        anthropic_model="claude-3-5-haiku-20241022",
        max_diff_bytes=512_000,
        max_files_per_diff=200,
    )


@pytest.fixture()
def stub_analysis() -> SemanticAnalysis:
    """A canned SemanticAnalysis used in mock-heavy tests."""
    return SemanticAnalysis(
        apis_added=["new_function"],
        apis_removed=[],
        tests_added=["test_new_function"],
        tests_broken=[],
        first_time_touches=["src/new_module.py"],
        breaking_changes=[],
        summary="Added new_function and corresponding test.",
        risk_level="low",
    )


@pytest.fixture()
def mock_analyzer(stub_analysis: SemanticAnalysis) -> MagicMock:
    """Return a DiffAnalyzer mock that always returns stub_analysis."""
    analyzer = MagicMock(spec=DiffAnalyzer)
    from src.models import AnalyzeResponse, FileSummary
    analyzer.analyze = AsyncMock(
        return_value=AnalyzeResponse(
            files=[],
            analysis=stub_analysis,
            total_lines_added=10,
            total_lines_removed=2,
            total_files=1,
        )
    )
    return analyzer


@pytest.fixture()
def client(mock_analyzer: MagicMock) -> TestClient:
    """Return a TestClient with the mock analyzer injected."""
    import src.main as main_module

    main_module._analyzer = mock_analyzer

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture()
def python_old() -> str:
    return """\
def greet(name: str) -> str:
    return f"Hello, {name}"

class Greeter:
    def say_hi(self) -> str:
        return "hi"
"""


@pytest.fixture()
def python_new() -> str:
    return """\
def greet(name: str) -> str:
    return f"Hello, {name}!"

def farewell(name: str) -> str:
    return f"Goodbye, {name}"

class Greeter:
    def say_hi(self) -> str:
        return "hi"

    def say_bye(self) -> str:
        return "bye"
"""
