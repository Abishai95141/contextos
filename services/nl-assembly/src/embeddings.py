"""Embedding service using sentence-transformers.

Loads the model once at startup and caches it for the lifetime of the
process. Encode is synchronous (sentence-transformers doesn't have async
support) so we run it in a thread-pool executor to avoid blocking the
event loop.
"""

from __future__ import annotations

import asyncio
import logging
from functools import lru_cache

import numpy as np
from sentence_transformers import SentenceTransformer

from .config import Settings, get_settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=4)
def _load_model(model_name: str) -> SentenceTransformer:
    """Load (and cache) a sentence-transformers model by name."""
    logger.info("Loading embedding model: %s", model_name)
    return SentenceTransformer(model_name)


class EmbeddingService:
    """High-level async wrapper around sentence-transformers."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._default_model_name = self._settings.embedding_model
        # Pre-load the default model during construction so the first request
        # doesn't incur the full model-loading latency.
        _load_model(self._default_model_name)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def embed(self, text: str, model_name: str | None = None) -> list[float]:
        """Return a normalised embedding vector for *text*.

        Args:
            text: The text to embed.  Will be silently truncated to 512
                  tokens by the underlying model.
            model_name: Override the default model for this request.

        Returns:
            A Python list of floats representing the embedding vector.
        """
        name = model_name or self._default_model_name
        loop = asyncio.get_running_loop()
        embedding: np.ndarray = await loop.run_in_executor(None, self._encode, name, text)
        return embedding.tolist()

    def embed_sync(self, text: str, model_name: str | None = None) -> list[float]:
        """Synchronous version of *embed*, for use in tests."""
        name = model_name or self._default_model_name
        return self._encode(name, text).tolist()

    @property
    def default_model(self) -> str:
        """Return the name of the default embedding model."""
        return self._default_model_name

    @property
    def dimensions(self) -> int:
        """Return the number of dimensions produced by the default model."""
        return self._settings.vector_dimensions

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _encode(self, model_name: str, text: str) -> np.ndarray:
        """Encode *text* with *model_name* and return a normalised vector."""
        model = _load_model(model_name)
        # normalize_embeddings=True ensures unit-length vectors so that dot
        # product equals cosine similarity.
        embedding: np.ndarray = model.encode(text, normalize_embeddings=True)
        return embedding
