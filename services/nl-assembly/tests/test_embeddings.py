"""Unit tests for the EmbeddingService.

These tests use the actual sentence-transformers model (all-MiniLM-L6-v2)
loaded once via the session-scoped fixture in conftest.py.  No network
calls are made — the model weights are downloaded to ~/.cache on first run.
"""

from __future__ import annotations

import math

import pytest

from src.config import Settings
from src.embeddings import EmbeddingService


class TestEmbeddingServiceSync:
    """Tests for the synchronous embed_sync helper."""

    def test_returns_list_of_floats(self, embedding_service: EmbeddingService) -> None:
        vector = embedding_service.embed_sync("Hello, world!")
        assert isinstance(vector, list)
        assert all(isinstance(v, float) for v in vector)

    def test_correct_dimensions(self, embedding_service: EmbeddingService) -> None:
        """all-MiniLM-L6-v2 produces 384-dimensional embeddings."""
        vector = embedding_service.embed_sync("Testing dimensions")
        assert len(vector) == 384

    def test_normalised_vector(self, embedding_service: EmbeddingService) -> None:
        """Embeddings should be unit-normalised (L2 norm ≈ 1.0)."""
        vector = embedding_service.embed_sync("Unit vector test")
        norm = math.sqrt(sum(v**2 for v in vector))
        assert abs(norm - 1.0) < 1e-5, f"Expected unit norm, got {norm}"

    def test_same_text_produces_same_embedding(self, embedding_service: EmbeddingService) -> None:
        """The model is deterministic — identical text must yield identical embeddings."""
        text = "ContextOS is a developer context management platform."
        v1 = embedding_service.embed_sync(text)
        v2 = embedding_service.embed_sync(text)
        assert v1 == v2

    def test_different_texts_produce_different_embeddings(self, embedding_service: EmbeddingService) -> None:
        """Semantically different texts should not produce identical vectors."""
        v1 = embedding_service.embed_sync("The cat sat on the mat.")
        v2 = embedding_service.embed_sync("Quantum chromodynamics describes strong interactions.")
        assert v1 != v2

    def test_similar_texts_have_high_cosine_similarity(self, embedding_service: EmbeddingService) -> None:
        """Paraphrases should be closer than unrelated sentences."""
        va = embedding_service.embed_sync("How do I deploy a FastAPI app?")
        vb = embedding_service.embed_sync("What is the best way to deploy a FastAPI application?")
        vc = embedding_service.embed_sync("My cat refuses to eat dry food.")

        def cosine(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x**2 for x in a))
            nb = math.sqrt(sum(x**2 for x in b))
            return dot / (na * nb)

        sim_ab = cosine(va, vb)
        sim_ac = cosine(va, vc)
        assert sim_ab > sim_ac, f"Expected sim(a,b)={sim_ab:.3f} > sim(a,c)={sim_ac:.3f}"

    def test_empty_model_name_falls_back_to_default(self, embedding_service: EmbeddingService) -> None:
        """Passing model_name=None must use the service default."""
        v_none = embedding_service.embed_sync("fallback test", model_name=None)
        v_explicit = embedding_service.embed_sync("fallback test", model_name="all-MiniLM-L6-v2")
        assert v_none == v_explicit


class TestEmbeddingServiceProperties:
    """Tests for EmbeddingService properties."""

    def test_default_model_property(self, test_settings: Settings) -> None:
        svc = EmbeddingService(settings=test_settings)
        assert svc.default_model == "all-MiniLM-L6-v2"

    def test_dimensions_property(self, test_settings: Settings) -> None:
        svc = EmbeddingService(settings=test_settings)
        assert svc.dimensions == 384

    def test_custom_settings(self) -> None:
        custom = Settings(
            embedding_model="all-MiniLM-L6-v2",
            vector_dimensions=384,
            database_url="postgresql://x:y@localhost/z",
        )
        svc = EmbeddingService(settings=custom)
        assert svc.dimensions == 384


class TestEmbeddingServiceAsync:
    """Tests for the async embed method."""

    @pytest.mark.asyncio
    async def test_async_embed_matches_sync(self, embedding_service: EmbeddingService) -> None:
        text = "Async embedding test"
        v_sync = embedding_service.embed_sync(text)
        v_async = await embedding_service.embed(text)
        assert v_sync == v_async

    @pytest.mark.asyncio
    async def test_async_embed_dimensions(self, embedding_service: EmbeddingService) -> None:
        v = await embedding_service.embed("async dim check")
        assert len(v) == 384

    @pytest.mark.asyncio
    async def test_async_embed_is_normalised(self, embedding_service: EmbeddingService) -> None:
        v = await embedding_service.embed("normalised check")
        norm = math.sqrt(sum(x**2 for x in v))
        assert abs(norm - 1.0) < 1e-5
