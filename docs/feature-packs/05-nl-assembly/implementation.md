# Feature Pack 05: NL Assembly Service — Implementation Guide

## Prerequisites

Module 01 (Foundation) complete. PostgreSQL and Redis running. `uv` installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`).

---

## Step 1: Initialize the Python Service

```bash
mkdir -p services/nl-assembly/src/nl_assembly
cd services/nl-assembly

# Initialize with uv
uv init --name nl-assembly --python 3.12
```

Create `services/nl-assembly/pyproject.toml`:

```toml
[project]
name = "nl-assembly"
version = "0.0.1"
description = "NL Assembly service for ContextOS — embedding generation and semantic search"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.32.0",
  "sentence-transformers>=3.3.0",
  "asyncpg>=0.30.0",
  "pgvector>=0.3.6",
  "redis[hiredis]>=5.2.0",
  "pydantic>=2.10.0",
  "pydantic-settings>=2.7.0",
  "structlog>=24.4.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.3.0",
  "pytest-asyncio>=0.25.0",
  "httpx>=0.28.0",
  "pytest-cov>=6.0.0",
  "ruff>=0.8.0",
]

[tool.ruff]
target-version = "py312"
line-length = 100
[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "ANN"]
ignore = ["ANN101", "ANN102"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

```bash
uv sync
uv sync --extra dev
```

---

## Step 2: Project Structure

```
services/nl-assembly/
├── src/
│   └── nl_assembly/
│       ├── __init__.py
│       ├── main.py          # FastAPI app
│       ├── config.py        # Settings (pydantic-settings)
│       ├── embedding.py     # Embedding service
│       ├── search.py        # Search service
│       ├── consumer.py      # Queue consumer
│       ├── database.py      # asyncpg connection pool
│       └── models.py        # Pydantic models
├── tests/
│   ├── conftest.py
│   ├── test_embedding.py
│   ├── test_search.py
│   └── test_consumer.py
├── pyproject.toml
└── Dockerfile
```

---

## Step 3: Configuration

Create `services/nl-assembly/src/nl_assembly/config.py`:

```python
from pydantic import PostgresDsn, RedisDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    database_url: PostgresDsn
    redis_url: RedisDsn
    embedding_model: str = 'all-MiniLM-L6-v2'
    embedding_dimensions: int = 384
    max_batch_size: int = 32
    min_similarity_default: float = 0.7
    max_search_results: int = 20
    queue_name: str = 'nl-assembly:queue'
    queue_consumer_concurrency: int = 3
    log_level: str = 'INFO'
    port: int = 8001


def get_settings() -> Settings:
    return Settings()
```

---

## Step 4: Database Connection

Create `services/nl-assembly/src/nl_assembly/database.py`:

```python
import asyncpg
from pgvector.asyncpg import register_vector


_pool: asyncpg.Pool | None = None


async def get_pool(database_url: str) -> asyncpg.Pool:
    """Return the shared asyncpg connection pool, creating it if needed."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=str(database_url),
            min_size=2,
            max_size=10,
            init=_init_connection,
        )
    return _pool


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Initialize each connection with pgvector codec."""
    await register_vector(conn)


async def close_pool() -> None:
    """Close the connection pool on shutdown."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
```

---

## Step 5: Embedding Service

Create `services/nl-assembly/src/nl_assembly/embedding.py`:

```python
import time
from typing import Any
import structlog
from sentence_transformers import SentenceTransformer
import numpy as np

logger = structlog.get_logger()


class EmbeddingService:
    """Handles loading the sentence-transformers model and generating embeddings."""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self._model: SentenceTransformer | None = None

    def load(self) -> None:
        """Load the embedding model into memory. Called once at startup."""
        logger.info('loading_embedding_model', model=self.model_name)
        start = time.perf_counter()
        self._model = SentenceTransformer(self.model_name)
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info(
            'embedding_model_loaded',
            model=self.model_name,
            duration_ms=round(elapsed_ms, 1),
        )

    @property
    def model(self) -> SentenceTransformer:
        if self._model is None:
            raise RuntimeError('Embedding model not loaded. Call load() first.')
        return self._model

    @property
    def dimensions(self) -> int:
        return self.model.get_sentence_embedding_dimension() or 384

    def encode(self, texts: list[str], normalize: bool = True) -> np.ndarray:
        """Encode a list of texts into embedding vectors.

        Args:
            texts: List of strings to embed. Must be non-empty.
            normalize: If True, L2-normalize the embeddings (enables dot-product similarity).

        Returns:
            numpy array of shape (len(texts), self.dimensions)
        """
        if not texts:
            raise ValueError('texts list must not be empty')

        start = time.perf_counter()
        embeddings: np.ndarray = self.model.encode(
            texts,
            batch_size=32,
            show_progress_bar=False,
            normalize_embeddings=normalize,
            convert_to_numpy=True,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.debug(
            'embeddings_generated',
            count=len(texts),
            dimensions=self.dimensions,
            duration_ms=round(elapsed_ms, 1),
        )
        return embeddings

    def encode_single(self, text: str, normalize: bool = True) -> list[float]:
        """Encode a single text and return as a Python list of floats."""
        embeddings = self.encode([text], normalize=normalize)
        return embeddings[0].tolist()
```

---

## Step 6: Search Service

Create `services/nl-assembly/src/nl_assembly/search.py`:

```python
from dataclasses import dataclass
from datetime import datetime
import asyncpg
import structlog
from .embedding import EmbeddingService

logger = structlog.get_logger()


@dataclass
class SearchResult:
    id: str
    title: str
    content: str
    similarity: float
    run_id: str
    feature_pack_name: str | None
    created_at: datetime
    excerpt: str


class SearchService:
    """Handles semantic search over context packs using pgvector."""

    def __init__(self, pool: asyncpg.Pool, embedder: EmbeddingService) -> None:
        self.pool = pool
        self.embedder = embedder

    async def search(
        self,
        query: str,
        project_id: str,
        limit: int = 5,
        min_similarity: float = 0.7,
        feature_pack_id: str | None = None,
    ) -> list[SearchResult]:
        """Search context packs by semantic similarity.

        Args:
            query: Natural language search query.
            project_id: UUID of the project to search within.
            limit: Maximum number of results (1-20).
            min_similarity: Minimum cosine similarity score (0-1).
            feature_pack_id: Optional filter to a specific feature pack.

        Returns:
            List of SearchResult ordered by similarity descending.
        """
        query_embedding = self.embedder.encode_single(query)

        logger.info(
            'semantic_search',
            query=query[:100],
            project_id=project_id,
            limit=limit,
            min_similarity=min_similarity,
        )

        sql = """
            SELECT
                cp.id::text,
                cp.title,
                cp.content,
                cp.run_id::text,
                fp.name as feature_pack_name,
                cp.created_at,
                1 - (cp.embedding <=> $1::vector) as similarity
            FROM context_packs cp
            LEFT JOIN feature_packs fp ON fp.id = cp.feature_pack_id
            WHERE
                cp.project_id = $2::uuid
                AND cp.embedding IS NOT NULL
                AND 1 - (cp.embedding <=> $1::vector) > $3
                {feature_pack_filter}
            ORDER BY cp.embedding <=> $1::vector
            LIMIT $4
        """

        params: list = [query_embedding, project_id, min_similarity, limit]
        feature_pack_filter = ''
        if feature_pack_id:
            params.append(feature_pack_id)
            feature_pack_filter = f'AND cp.feature_pack_id = ${len(params)}::uuid'

        sql = sql.format(feature_pack_filter=feature_pack_filter)

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        results = []
        for row in rows:
            results.append(
                SearchResult(
                    id=row['id'],
                    title=row['title'],
                    content=row['content'],
                    similarity=float(row['similarity']),
                    run_id=row['run_id'],
                    feature_pack_name=row['feature_pack_name'],
                    created_at=row['created_at'],
                    excerpt=row['content'][:300].strip(),
                )
            )

        logger.info('search_complete', result_count=len(results), query=query[:100])
        return results
```

---

## Step 7: Queue Consumer

Create `services/nl-assembly/src/nl_assembly/consumer.py`:

```python
import asyncio
import json
import structlog
import asyncpg
import redis.asyncio as aioredis
from .embedding import EmbeddingService

logger = structlog.get_logger()


class QueueConsumer:
    """Consumes embedding jobs from Redis and processes them."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        redis_client: aioredis.Redis,
        embedder: EmbeddingService,
        queue_name: str,
    ) -> None:
        self.pool = pool
        self.redis = redis_client
        self.embedder = embedder
        self.queue_name = queue_name
        self._running = False
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        """Start the consumer as a background asyncio task."""
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name='queue-consumer')
        logger.info('queue_consumer_started', queue=self.queue_name)

    async def stop(self) -> None:
        """Stop the consumer gracefully."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info('queue_consumer_stopped')

    async def _run_loop(self) -> None:
        """Main consumer loop — runs until stopped."""
        while self._running:
            try:
                # Block for up to 5 seconds waiting for a job
                result = await self.redis.blpop(self.queue_name, timeout=5)
                if result is None:
                    continue  # Timeout — loop again

                _, job_bytes = result
                job = json.loads(job_bytes)
                await self._process_job(job)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error('consumer_loop_error', exc=str(exc))
                await asyncio.sleep(1)  # Brief pause before retrying

    async def _process_job(self, job: dict) -> None:
        """Process a single embedding generation job."""
        context_pack_id = job.get('contextPackId')
        if not context_pack_id:
            logger.warning('invalid_job', job=job)
            return

        logger.info('processing_embedding_job', context_pack_id=context_pack_id)

        async with self.pool.acquire() as conn:
            # Load the context pack content
            row = await conn.fetchrow(
                'SELECT id, content FROM context_packs WHERE id = $1::uuid',
                context_pack_id,
            )

            if not row:
                logger.warning('context_pack_not_found', context_pack_id=context_pack_id)
                await self._update_queue_status(conn, context_pack_id, 'failed', 'Pack not found')
                return

            # Generate embedding
            try:
                embedding = self.embedder.encode_single(row['content'])
            except Exception as exc:
                logger.error('embedding_generation_failed', context_pack_id=context_pack_id, exc=str(exc))
                await self._update_queue_status(conn, context_pack_id, 'failed', str(exc))
                return

            # Update the context pack with its embedding
            await conn.execute(
                'UPDATE context_packs SET embedding = $1::vector WHERE id = $2::uuid',
                embedding,
                context_pack_id,
            )

            # Mark queue entry as completed
            await self._update_queue_status(conn, context_pack_id, 'completed', None)

            logger.info('embedding_job_complete', context_pack_id=context_pack_id)

    async def _update_queue_status(
        self,
        conn: asyncpg.Connection,
        context_pack_id: str,
        status: str,
        error: str | None,
    ) -> None:
        await conn.execute(
            """
            UPDATE pack_embeddings_queue
            SET status = $1, last_error = $2, processed_at = now(),
                attempts = attempts + 1
            WHERE context_pack_id = $3::uuid AND status != 'completed'
            """,
            status,
            error,
            context_pack_id,
        )
```

---

## Step 8: FastAPI Application

Create `services/nl-assembly/src/nl_assembly/main.py`:

```python
from contextlib import asynccontextmanager
import structlog
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from .config import get_settings
from .database import get_pool, close_pool
from .embedding import EmbeddingService
from .search import SearchService
from .consumer import QueueConsumer

logger = structlog.get_logger()
settings = get_settings()

# Global service instances
_embedder: EmbeddingService | None = None
_searcher: SearchService | None = None
_consumer: QueueConsumer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize services on startup, clean up on shutdown."""
    global _embedder, _searcher, _consumer

    # Load embedding model (blocks until loaded)
    _embedder = EmbeddingService(settings.embedding_model)
    _embedder.load()

    # Connect to database
    pool = await get_pool(str(settings.database_url))

    # Connect to Redis
    redis_client = aioredis.from_url(str(settings.redis_url))

    # Initialize services
    _searcher = SearchService(pool, _embedder)

    # Start queue consumer
    _consumer = QueueConsumer(pool, redis_client, _embedder, settings.queue_name)
    _consumer.start()

    logger.info('nl_assembly_started', model=settings.embedding_model, port=settings.port)

    yield  # Application runs

    # Cleanup
    if _consumer:
        await _consumer.stop()
    await close_pool()
    await redis_client.aclose()
    logger.info('nl_assembly_stopped')


app = FastAPI(title='NL Assembly', version='0.1.0', lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=100)
    normalize: bool = True


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int
    duration_ms: float


@app.post('/embed', response_model=EmbedResponse)
async def embed_texts(request: EmbedRequest) -> EmbedResponse:
    if _embedder is None:
        raise HTTPException(status_code=503, detail='Embedding service not initialized')

    import time
    start = time.perf_counter()
    embeddings_array = _embedder.encode(request.texts, normalize=request.normalize)
    duration_ms = (time.perf_counter() - start) * 1000

    return EmbedResponse(
        embeddings=[row.tolist() for row in embeddings_array],
        model=settings.embedding_model,
        dimensions=_embedder.dimensions,
        duration_ms=round(duration_ms, 2),
    )


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    project_id: str
    limit: int = Field(default=5, ge=1, le=20)
    min_similarity: float = Field(default=0.7, ge=0.0, le=1.0)
    feature_pack_id: str | None = None


class SearchResultItem(BaseModel):
    id: str
    title: str
    content: str
    similarity: float
    run_id: str
    feature_pack_name: str | None
    created_at: str
    excerpt: str


class SearchResponse(BaseModel):
    results: list[SearchResultItem]
    query: str
    searched_at: str
    embedding_model: str
    result_count: int


@app.post('/search', response_model=SearchResponse)
async def search_packs(request: SearchRequest) -> SearchResponse:
    from datetime import datetime, timezone

    if _searcher is None:
        raise HTTPException(status_code=503, detail='Search service not initialized')

    results = await _searcher.search(
        query=request.query,
        project_id=request.project_id,
        limit=request.limit,
        min_similarity=request.min_similarity,
        feature_pack_id=request.feature_pack_id,
    )

    return SearchResponse(
        results=[
            SearchResultItem(
                id=r.id,
                title=r.title,
                content=r.content,
                similarity=round(r.similarity, 4),
                run_id=r.run_id,
                feature_pack_name=r.feature_pack_name,
                created_at=r.created_at.isoformat(),
                excerpt=r.excerpt,
            )
            for r in results
        ],
        query=request.query,
        searched_at=datetime.now(timezone.utc).isoformat(),
        embedding_model=settings.embedding_model,
        result_count=len(results),
    )


@app.get('/health')
async def health_check() -> dict:
    from datetime import datetime, timezone

    db_healthy = False
    try:
        pool = await get_pool(str(settings.database_url))
        async with pool.acquire() as conn:
            await conn.fetchval('SELECT 1')
        db_healthy = True
    except Exception:
        pass

    status = 'healthy' if db_healthy and _embedder is not None else 'degraded'
    return {
        'status': status,
        'model': settings.embedding_model,
        'model_loaded': _embedder is not None,
        'database': 'healthy' if db_healthy else 'unhealthy',
        'queue_consumer': 'running' if _consumer and _consumer._running else 'stopped',
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
```

---

## Step 9: Tests

Create `services/nl-assembly/tests/test_embedding.py`:

```python
import pytest
import numpy as np
from nl_assembly.embedding import EmbeddingService


@pytest.fixture(scope='module')
def embedder() -> EmbeddingService:
    """Load the real model once for all tests in this module."""
    svc = EmbeddingService('all-MiniLM-L6-v2')
    svc.load()
    return svc


def test_encode_returns_correct_shape(embedder: EmbeddingService) -> None:
    texts = ['Hello world', 'Another sentence']
    result = embedder.encode(texts)
    assert result.shape == (2, 384)


def test_encode_normalized_unit_vectors(embedder: EmbeddingService) -> None:
    texts = ['Test normalization']
    result = embedder.encode(texts, normalize=True)
    norms = np.linalg.norm(result, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


def test_encode_empty_raises(embedder: EmbeddingService) -> None:
    with pytest.raises(ValueError, match='must not be empty'):
        embedder.encode([])


def test_encode_single_returns_list(embedder: EmbeddingService) -> None:
    result = embedder.encode_single('Single text')
    assert isinstance(result, list)
    assert len(result) == 384
    assert all(isinstance(v, float) for v in result)


def test_similar_texts_have_high_similarity(embedder: EmbeddingService) -> None:
    texts = [
        'How to implement OAuth authentication',
        'Implementing OAuth login flow',
        'Python data structures tutorial',
    ]
    embeddings = embedder.encode(texts, normalize=True)
    # Cosine similarity = dot product for normalized vectors
    sim_01 = float(np.dot(embeddings[0], embeddings[1]))
    sim_02 = float(np.dot(embeddings[0], embeddings[2]))
    # Related texts should be more similar than unrelated
    assert sim_01 > sim_02, f'Expected sim_01 ({sim_01:.3f}) > sim_02 ({sim_02:.3f})'
    assert sim_01 > 0.7, f'Related texts should have similarity > 0.7, got {sim_01:.3f}'
```

Create `services/nl-assembly/tests/test_search.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
import numpy as np
from nl_assembly.search import SearchService, SearchResult
from nl_assembly.embedding import EmbeddingService


@pytest.fixture
def mock_embedder() -> MagicMock:
    embedder = MagicMock(spec=EmbeddingService)
    # Return a fixed embedding vector for any text
    embedder.encode_single.return_value = [0.1] * 384
    return embedder


@pytest.fixture
def mock_pool() -> AsyncMock:
    return AsyncMock()


@pytest.mark.asyncio
async def test_search_returns_empty_for_no_results(mock_pool, mock_embedder) -> None:
    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = []
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

    service = SearchService(mock_pool, mock_embedder)
    results = await service.search('test query', 'project-uuid')

    assert results == []
    mock_embedder.encode_single.assert_called_once_with('test query')


@pytest.mark.asyncio
async def test_search_returns_ordered_results(mock_pool, mock_embedder) -> None:
    from datetime import datetime, timezone

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [
        {
            'id': 'pack-1',
            'title': 'OAuth implementation',
            'content': '# OAuth Context Pack',
            'run_id': 'run-1',
            'feature_pack_name': 'Auth Pack',
            'created_at': datetime(2026, 1, 1, tzinfo=timezone.utc),
            'similarity': 0.92,
        },
        {
            'id': 'pack-2',
            'title': 'Database schema',
            'content': '# DB Schema Context Pack',
            'run_id': 'run-2',
            'feature_pack_name': None,
            'created_at': datetime(2026, 1, 2, tzinfo=timezone.utc),
            'similarity': 0.75,
        },
    ]
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

    service = SearchService(mock_pool, mock_embedder)
    results = await service.search('OAuth login', 'project-uuid', limit=5)

    assert len(results) == 2
    assert results[0].similarity == 0.92
    assert results[0].title == 'OAuth implementation'
    assert results[1].similarity == 0.75
```

---

## Step 10: Dockerfile

Create `services/nl-assembly/Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install uv
RUN pip install uv

# Copy dependency files first (layer caching)
COPY pyproject.toml uv.lock* ./

# Install dependencies
RUN uv sync --frozen --no-dev

# Pre-download the embedding model
RUN uv run python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Copy source code
COPY src/ ./src/

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')"

CMD ["uv", "run", "uvicorn", "nl_assembly.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

---

## Verification Checklist

- [ ] `uv sync` completes without errors
- [ ] `uv run pytest tests/ -v` passes all tests
- [ ] `uv run uvicorn nl_assembly.main:app --port 8001` starts without errors
- [ ] `GET /health` returns `200 { "status": "healthy" }`
- [ ] `POST /embed` with `["Hello world"]` returns a 384-element float array
- [ ] `POST /search` with a valid project_id and query returns results from DB
- [ ] Queue consumer picks up jobs from Redis within 5 seconds
- [ ] Context pack embeddings are populated in DB after job processing
- [ ] `ruff check src/` passes with no errors
