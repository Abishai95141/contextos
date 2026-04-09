"""pgvector semantic search service.

Performs approximate nearest-neighbour search over the context_packs table
using its `summary_embedding` column (stored as a pgvector `vector` type).
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg

from .config import Settings, get_settings
from .embeddings import EmbeddingService
from .models import SearchResult

logger = logging.getLogger(__name__)


class SearchService:
    """Semantic search over the context_packs table using pgvector."""

    def __init__(
        self,
        embedding_service: EmbeddingService,
        pool: asyncpg.Pool | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._embedding_service = embedding_service
        self._pool = pool
        self._settings = settings or get_settings()

    # ------------------------------------------------------------------
    # Pool lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Create the asyncpg connection pool. Called once at startup."""
        if self._pool is not None:
            return
        logger.info("Connecting to database: %s", self._settings.database_url)

        async def init_conn(conn: asyncpg.Connection) -> None:  # type: ignore[type-arg]
            # Register the pgvector codec so asyncpg knows how to
            # serialise/deserialise the `vector` type.
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            await conn.set_type_codec(
                "vector",
                encoder=lambda v: str(v),
                decoder=lambda v: [float(x) for x in v.strip("[]").split(",")],
                schema="pg_catalog",
                format="text",
            )

        self._pool = await asyncpg.create_pool(
            self._settings.database_url,
            min_size=2,
            max_size=10,
            init=init_conn,
        )

    async def disconnect(self) -> None:
        """Close all connections in the pool. Called at shutdown."""
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    async def search(
        self,
        query: str,
        project_id: str,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchResult]:
        """Return context packs semantically similar to *query*.

        Args:
            query: Natural-language search query.
            project_id: Scope results to this project UUID.
            top_k: Maximum number of results (defaults to settings value).
            similarity_threshold: Minimum cosine similarity (0-1).
            filters: Optional ``{column: value}`` equality filters applied
                     before the vector search.

        Returns:
            A list of :class:`SearchResult` objects sorted by descending
            similarity score.
        """
        if self._pool is None:
            raise RuntimeError("SearchService.connect() has not been called")

        k = top_k or self._settings.search_top_k
        threshold = similarity_threshold if similarity_threshold is not None else self._settings.similarity_threshold

        # Embed the query
        query_vector = await self._embedding_service.embed(query)
        vector_str = "[" + ",".join(str(f) for f in query_vector) + "]"

        # Build the base SQL.  We use the pgvector <=> operator (cosine
        # distance) and convert to similarity = 1 - distance.
        sql_parts = [
            """
            SELECT
                id                               AS context_pack_id,
                run_id,
                issue_ref,
                summary,
                agent_name,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                1 - (summary_embedding <=> $1::vector) AS similarity
            FROM context_packs
            WHERE project_id = $2
              AND summary_embedding IS NOT NULL
              AND 1 - (summary_embedding <=> $1::vector) >= $3
            """,
        ]

        params: list[Any] = [vector_str, project_id, threshold]
        param_idx = 4

        # Dynamic equality filters
        if filters:
            for col, value in filters.items():
                # Allowlist to prevent SQL injection
                allowed_columns = {"status", "agent_name", "issue_ref"}
                if col in allowed_columns:
                    sql_parts.append(f"AND {col} = ${param_idx}")
                    params.append(value)
                    param_idx += 1

        sql_parts.append(f"ORDER BY similarity DESC LIMIT ${param_idx}")
        params.append(k)

        sql = "\n".join(sql_parts)

        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        return [
            SearchResult(
                context_pack_id=str(row["context_pack_id"]),
                run_id=str(row["run_id"]),
                issue_ref=row["issue_ref"],
                summary=row["summary"],
                similarity=float(row["similarity"]),
                agent_name=row["agent_name"],
                created_at=row["created_at"],
            )
            for row in rows
        ]
