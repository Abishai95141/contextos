"""Pydantic request/response models for the NL Assembly API."""

from typing import Any

from pydantic import BaseModel, Field


# ── Embed endpoint ──────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    """Request body for the /embed endpoint."""

    text: str = Field(..., description="Text to embed", min_length=1, max_length=32768)
    model: str | None = Field(None, description="Override embedding model. Uses service default if omitted.")


class EmbedResponse(BaseModel):
    """Response body for the /embed endpoint."""

    embedding: list[float] = Field(..., description="Embedding vector as a list of floats")
    dimensions: int = Field(..., description="Number of dimensions in the embedding")
    model: str = Field(..., description="Model used to produce the embedding")
    text_length: int = Field(..., description="Length of the input text in characters")


# ── Search endpoint ─────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    """Request body for the /search endpoint."""

    query: str = Field(..., description="Natural-language query to search for", min_length=1, max_length=4096)
    project_id: str = Field(..., description="UUID of the project to scope the search to")
    top_k: int = Field(10, description="Maximum number of results to return", ge=1, le=100)
    similarity_threshold: float = Field(
        0.6,
        description="Minimum cosine similarity score (0-1) for a result to be included",
        ge=0.0,
        le=1.0,
    )
    filters: dict[str, Any] | None = Field(
        None,
        description="Optional key/value filters applied to context_pack metadata before vector search",
    )


class SearchResult(BaseModel):
    """A single semantic search result."""

    context_pack_id: str = Field(..., description="UUID of the matching context pack")
    run_id: str = Field(..., description="UUID of the run that produced this context pack")
    issue_ref: str | None = Field(None, description="Issue reference, e.g. 'PROJ-123'")
    summary: str | None = Field(None, description="Human-readable summary of the context pack")
    similarity: float = Field(..., description="Cosine similarity score (0-1)")
    agent_name: str | None = Field(None, description="Name of the agent that produced this context pack")
    created_at: str = Field(..., description="ISO-8601 timestamp of when the context pack was created")


class SearchResponse(BaseModel):
    """Response body for the /search endpoint."""

    results: list[SearchResult] = Field(..., description="Ranked list of matching context packs")
    query: str = Field(..., description="The original query string")
    total: int = Field(..., description="Number of results returned")


# ── Health endpoint ─────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = Field(..., description="'ok' when the service is healthy")
    model: str = Field(..., description="Name of the loaded embedding model")
    version: str = Field(..., description="Service version string")
