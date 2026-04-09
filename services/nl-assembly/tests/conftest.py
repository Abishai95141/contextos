"""Pytest fixtures shared across NL Assembly test modules."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.config import Settings
from src.embeddings import EmbeddingService
from src.main import app
from src.search import SearchService


@pytest.fixture(scope="session")
def test_settings() -> Settings:
    """Return a Settings instance with safe test defaults."""
    return Settings(
        database_url="postgresql://contextos:contextos_test@localhost:5433/contextos_test",
        embedding_model="all-MiniLM-L6-v2",
        vector_dimensions=384,
        search_top_k=5,
        similarity_threshold=0.5,
    )


@pytest.fixture(scope="session")
def embedding_service(test_settings: Settings) -> EmbeddingService:
    """Return a real EmbeddingService backed by the test settings.

    The model is small (all-MiniLM-L6-v2, ~80 MB) so we load it once per
    session to keep the test suite fast.
    """
    return EmbeddingService(settings=test_settings)


@pytest.fixture()
def mock_embedding_service() -> MagicMock:
    """Return a mock EmbeddingService that returns a deterministic vector."""
    svc = MagicMock(spec=EmbeddingService)
    # 384-dim unit vector (all 1/√384 ≈ 0.051)
    dim = 384
    unit = 1.0 / (dim**0.5)
    svc.embed = AsyncMock(return_value=[unit] * dim)
    svc.embed_sync.return_value = [unit] * dim
    svc.default_model = "all-MiniLM-L6-v2"
    svc.dimensions = dim
    return svc


@pytest.fixture()
def mock_search_service(mock_embedding_service: MagicMock) -> MagicMock:
    """Return a mock SearchService."""
    svc = MagicMock(spec=SearchService)
    svc.search = AsyncMock(return_value=[])
    return svc


@pytest.fixture()
def client(mock_embedding_service: MagicMock, mock_search_service: MagicMock) -> TestClient:
    """Return a TestClient with mocked services injected via module-level globals."""
    import src.main as main_module

    main_module._embedding_service = mock_embedding_service
    main_module._search_service = mock_search_service

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
