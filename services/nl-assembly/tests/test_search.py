"""Unit tests for the SearchService.

These tests mock out the asyncpg pool and the EmbeddingService so no
real database or model is required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from src.embeddings import EmbeddingService
from src.models import SearchResult
from src.search import SearchService


def _make_pool_row(
    context_pack_id: str,
    run_id: str,
    similarity: float,
    issue_ref: str | None = None,
    summary: str | None = None,
    agent_name: str | None = None,
    created_at: str = "2024-01-01T00:00:00Z",
) -> dict:
    return {
        "context_pack_id": context_pack_id,
        "run_id": run_id,
        "issue_ref": issue_ref,
        "summary": summary,
        "similarity": similarity,
        "agent_name": agent_name,
        "created_at": created_at,
    }


def _make_mock_pool(rows: list[dict]) -> MagicMock:
    """Return a mock asyncpg pool that yields *rows* for any SELECT."""
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(return_value=rows)
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=None)

    mock_pool = MagicMock()
    mock_pool.acquire = MagicMock(return_value=mock_conn)
    mock_pool.close = AsyncMock()
    return mock_pool


@pytest.fixture()
def dim() -> int:
    return 384


@pytest.fixture()
def unit_vector(dim: int) -> list[float]:
    v = 1.0 / (dim**0.5)
    return [v] * dim


@pytest.fixture()
def mock_embedding(unit_vector: list[float]) -> MagicMock:
    svc = MagicMock(spec=EmbeddingService)
    svc.embed = AsyncMock(return_value=unit_vector)
    return svc


@pytest.fixture()
def search_service(mock_embedding: MagicMock) -> SearchService:
    from src.config import Settings

    settings = Settings(
        database_url="postgresql://x:y@localhost/test",
        embedding_model="all-MiniLM-L6-v2",
        search_top_k=10,
        similarity_threshold=0.5,
    )
    return SearchService(embedding_service=mock_embedding, settings=settings)


class TestSearchServiceSearch:
    """Tests for SearchService.search()."""

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_rows(self, search_service: SearchService) -> None:
        search_service._pool = _make_mock_pool([])
        results = await search_service.search("test query", project_id=str(uuid4()))
        assert results == []

    @pytest.mark.asyncio
    async def test_returns_search_results(self, search_service: SearchService) -> None:
        pack_id = str(uuid4())
        run_id = str(uuid4())
        rows = [_make_pool_row(pack_id, run_id, similarity=0.85, summary="Great context")]
        search_service._pool = _make_mock_pool(rows)

        results = await search_service.search("find relevant context", project_id=str(uuid4()))

        assert len(results) == 1
        r = results[0]
        assert r.context_pack_id == pack_id
        assert r.run_id == run_id
        assert r.similarity == 0.85
        assert r.summary == "Great context"

    @pytest.mark.asyncio
    async def test_results_are_search_result_instances(self, search_service: SearchService) -> None:
        rows = [
            _make_pool_row(str(uuid4()), str(uuid4()), 0.9, issue_ref="PROJ-1"),
            _make_pool_row(str(uuid4()), str(uuid4()), 0.75, agent_name="claude-code"),
        ]
        search_service._pool = _make_mock_pool(rows)

        results = await search_service.search("query", project_id=str(uuid4()))

        assert all(isinstance(r, SearchResult) for r in results)

    @pytest.mark.asyncio
    async def test_raises_when_pool_not_initialised(self, search_service: SearchService) -> None:
        search_service._pool = None
        with pytest.raises(RuntimeError, match="connect()"):
            await search_service.search("query", project_id=str(uuid4()))

    @pytest.mark.asyncio
    async def test_uses_custom_top_k(self, search_service: SearchService, mock_embedding: MagicMock) -> None:
        """top_k should be passed through as the LIMIT parameter."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=None)
        mock_pool = MagicMock()
        mock_pool.acquire = MagicMock(return_value=mock_conn)
        search_service._pool = mock_pool

        await search_service.search("query", project_id=str(uuid4()), top_k=42)

        call_args = mock_conn.fetch.call_args
        # The last positional argument to fetch() is the LIMIT value
        positional_params = call_args[0]  # (sql, *params)
        assert 42 in positional_params, f"Expected 42 in params, got {positional_params}"

    @pytest.mark.asyncio
    async def test_optional_fields_are_none_when_missing(self, search_service: SearchService) -> None:
        rows = [_make_pool_row(str(uuid4()), str(uuid4()), 0.7)]
        search_service._pool = _make_mock_pool(rows)

        results = await search_service.search("query", project_id=str(uuid4()))

        r = results[0]
        assert r.issue_ref is None
        assert r.summary is None
        assert r.agent_name is None

    @pytest.mark.asyncio
    async def test_multiple_results_are_all_returned(self, search_service: SearchService) -> None:
        rows = [
            _make_pool_row(str(uuid4()), str(uuid4()), 0.95),
            _make_pool_row(str(uuid4()), str(uuid4()), 0.88),
            _make_pool_row(str(uuid4()), str(uuid4()), 0.71),
        ]
        search_service._pool = _make_mock_pool(rows)

        results = await search_service.search("query", project_id=str(uuid4()))
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_embed_is_called_with_query(
        self, search_service: SearchService, mock_embedding: MagicMock
    ) -> None:
        search_service._pool = _make_mock_pool([])
        query = "unique search phrase"
        await search_service.search(query, project_id=str(uuid4()))
        mock_embedding.embed.assert_awaited_once_with(query)


class TestSearchServiceLifecycle:
    """Tests for connect() and disconnect()."""

    @pytest.mark.asyncio
    async def test_disconnect_is_idempotent(self, search_service: SearchService) -> None:
        """disconnect() when pool is None should not raise."""
        search_service._pool = None
        await search_service.disconnect()  # Should not raise

    @pytest.mark.asyncio
    async def test_disconnect_closes_pool(self, search_service: SearchService) -> None:
        mock_pool = MagicMock()
        mock_pool.close = AsyncMock()
        search_service._pool = mock_pool

        await search_service.disconnect()

        mock_pool.close.assert_awaited_once()
        assert search_service._pool is None
