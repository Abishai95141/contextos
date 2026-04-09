"""ContextOS NL Assembly Service — FastAPI application entry point.

Provides three endpoints:
  GET  /health    — liveness probe
  POST /embed     — produce an embedding vector for a given text string
  POST /search    — semantic nearest-neighbour search over context_packs
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .config import get_settings
from .embeddings import EmbeddingService
from .models import EmbedRequest, EmbedResponse, HealthResponse, SearchRequest, SearchResponse
from .search import SearchService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------

_embedding_service: EmbeddingService | None = None
_search_service: SearchService | None = None


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Initialise services on startup; tear them down on shutdown."""
    global _embedding_service, _search_service

    settings = get_settings()
    logger.info("Starting NL Assembly service (model=%s)", settings.embedding_model)

    _embedding_service = EmbeddingService(settings)
    _search_service = SearchService(_embedding_service, settings=settings)

    try:
        await _search_service.connect()
        logger.info("NL Assembly service ready")
        yield
    finally:
        logger.info("Shutting down NL Assembly service")
        if _search_service is not None:
            await _search_service.disconnect()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ContextOS NL Assembly",
    description="Embeddings and pgvector semantic search for context packs",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception for %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse, tags=["meta"])
async def health() -> HealthResponse:
    """Return service health status.

    Used as a liveness probe by Docker and Kubernetes.
    """
    settings = get_settings()
    return HealthResponse(
        status="ok",
        model=settings.embedding_model,
        version="0.1.0",
    )


@app.post("/embed", response_model=EmbedResponse, tags=["embeddings"])
async def embed(body: EmbedRequest) -> EmbedResponse:
    """Produce an embedding vector for *text*.

    - Returns a normalised (unit-length) vector suitable for cosine
      similarity comparisons.
    - If *model* is omitted the service default is used.
    """
    if _embedding_service is None:
        raise HTTPException(status_code=503, detail="Embedding service not initialised")

    model_name = body.model or _embedding_service.default_model

    try:
        vector = await _embedding_service.embed(body.text, model_name=body.model)
    except Exception as exc:
        logger.exception("Failed to embed text")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return EmbedResponse(
        embedding=vector,
        dimensions=len(vector),
        model=model_name,
        text_length=len(body.text),
    )


@app.post("/search", response_model=SearchResponse, tags=["search"])
async def search(body: SearchRequest) -> SearchResponse:
    """Semantic search over context packs scoped to a project.

    - Embeds *query* and performs approximate nearest-neighbour search
      using the pgvector `<=>` cosine-distance operator.
    - Results are filtered by *similarity_threshold* and ranked by
      descending similarity.
    """
    if _search_service is None:
        raise HTTPException(status_code=503, detail="Search service not initialised")

    try:
        results = await _search_service.search(
            query=body.query,
            project_id=body.project_id,
            top_k=body.top_k,
            similarity_threshold=body.similarity_threshold,
            filters=body.filters,
        )
    except Exception as exc:
        logger.exception("Search failed for query=%r project_id=%r", body.query, body.project_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return SearchResponse(
        results=results,
        query=body.query,
        total=len(results),
    )


# ---------------------------------------------------------------------------
# Entry point (for `python -m src.main`)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "src.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        reload=False,
    )
