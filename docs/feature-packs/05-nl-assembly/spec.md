# Feature Pack 05: NL Assembly Service

## Overview

The NL Assembly service is a Python FastAPI microservice responsible for generating vector embeddings from text and performing semantic similarity search over the Context Pack archive. It is the search intelligence layer of ContextOS — enabling AI agents and human users to find relevant historical context using natural language.

---

## 1. Architecture

```
Callers: MCP Server (search_packs_nl tool), Hooks Bridge (Stop hook)
         │
         │  HTTP
         ▼
┌─────────────────────────────────────────────────────┐
│              NL Assembly Service (FastAPI)           │
│                                                      │
│  POST /embed     → Generate embedding for text       │
│  POST /search    → Semantic search over context packs │
│  GET  /health    → Health check                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Embedding Service                  │    │
│  │  - Load model at startup                     │    │
│  │  - sentence-transformers                     │    │
│  │  - Batch encoding                            │    │
│  │  - all-MiniLM-L6-v2 default (384 dims)      │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Search Service                     │    │
│  │  - asyncpg connection pool                   │    │
│  │  - pgvector cosine similarity                │    │
│  │  - Metadata filtering (project_id)           │    │
│  │  - HNSW index queries                        │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Queue Consumer                     │    │
│  │  - Polls Redis list for embedding jobs       │    │
│  │  - Processes pack_embeddings_queue table     │    │
│  │  - Updates context_packs.embedding           │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │                        │
    PostgreSQL                  Redis
  (context_packs table)    (nl-assembly:queue)
```

---

## 2. Embedding Generation Pipeline

### Model: all-MiniLM-L6-v2

Default embedding model: `sentence-transformers/all-MiniLM-L6-v2`
- **Dimensions**: 384
- **Max sequence length**: 256 tokens
- **Performance**: ~14,000 sentences/second on CPU (batch size 32)
- **Memory**: ~80MB model size
- **Quality**: Strong performance on semantic textual similarity tasks; MTEB score competitive for its size

Alternative models supported via `NL_ASSEMBLY_EMBEDDING_MODEL` env var:
- `all-mpnet-base-v2`: 768 dims, higher quality, 2x slower
- `BAAI/bge-small-en-v1.5`: 384 dims, strong retrieval performance
- `text-embedding-3-small` via OpenAI API (fallback when local model is insufficient)

Note: The pgvector HNSW index is created with `dimensions: 384`. If a different dimension model is used, the index must be rebuilt (migration required).

### Preprocessing

Before embedding, Context Pack content is preprocessed:
1. Strip markdown formatting (headers, bold, code fences) — keep the raw text
2. Truncate to 512 characters for search; full text for indexed embedding
3. Normalize whitespace

For the search query: no preprocessing beyond whitespace normalization. The query is embedded as-is to preserve semantic intent.

### Batch Processing

The embedding service processes jobs in batches of 32 for efficiency:

```python
# Pseudo-code for batch embedding
texts: list[str] = []  # Collected from queue
embeddings = model.encode(
    texts,
    batch_size=32,
    show_progress_bar=False,
    normalize_embeddings=True,  # For cosine similarity
)
```

`normalize_embeddings=True` ensures the embedding vectors are unit-norm, so cosine similarity reduces to dot product — the most efficient computation for pgvector's `<=>` operator.

---

## 3. Semantic Search

### Search Pipeline

```
1. Accept query text + projectId + optional filters
2. Embed the query with the same model used for indexing
3. Run pgvector cosine similarity query with projectId filter
4. Apply minimum similarity threshold
5. Return ranked results with similarity scores
```

### pgvector Query Pattern

```sql
SELECT
    cp.id,
    cp.title,
    cp.content,
    cp.run_id,
    cp.created_at,
    cp.metadata,
    fp.name as feature_pack_name,
    1 - (cp.embedding <=> $1) as similarity
FROM context_packs cp
LEFT JOIN feature_packs fp ON fp.id = cp.feature_pack_id
WHERE
    cp.project_id = $2
    AND cp.embedding IS NOT NULL
    AND 1 - (cp.embedding <=> $1) > $3  -- minimum similarity threshold
ORDER BY cp.embedding <=> $1
LIMIT $4;
```

The `<=>` operator computes cosine distance (lower = more similar). `1 - (cp.embedding <=> $1)` converts to cosine similarity (higher = more similar).

### HNSW Index Strategy

The `context_packs_embedding_idx` HNSW index parameters:
- `m = 16`: Maximum number of connections per node at each layer. Higher = better recall, more memory.
- `ef_construction = 64`: Size of the dynamic candidate list during index construction. Higher = better recall, slower build.
- `ef_search = 40` (query-time setting): Size of the dynamic candidate list during search. Higher = better recall, slower query.

These defaults are appropriate for:
- Dataset size: Up to 1 million context packs
- Query latency target: < 50ms
- Recall target: > 95% for top-5 results

For the ContextOS use case (thousands to tens of thousands of packs per project), these parameters are conservative — performance will be significantly better than the targets.

---

## 4. API Endpoints

### POST /embed

Generate embeddings for one or more texts.

**Request**:
```json
{
  "texts": ["string to embed", "another string"],
  "normalize": true
}
```

**Response** (200 OK):
```json
{
  "embeddings": [
    [0.023, -0.041, ...],  // 384-element float array
    [0.015, 0.082, ...]
  ],
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384,
  "duration_ms": 12.4
}
```

**Error** (400):
```json
{
  "error": "texts array must not be empty",
  "code": "INVALID_INPUT"
}
```

**Limits**:
- Maximum 100 texts per request
- Maximum 10,000 characters per text

### POST /search

Perform semantic search over the Context Pack archive.

**Request**:
```json
{
  "query": "how did we implement OAuth?",
  "project_id": "uuid-of-project",
  "limit": 5,
  "min_similarity": 0.7,
  "feature_pack_id": null
}
```

**Response** (200 OK):
```json
{
  "results": [
    {
      "id": "uuid",
      "title": "Added Google OAuth to auth module",
      "content": "# Context Pack: Added Google OAuth...",
      "similarity": 0.891,
      "run_id": "uuid",
      "feature_pack_name": "Auth Module Pack",
      "created_at": "2026-01-15T10:30:00Z",
      "excerpt": "Implemented Google OAuth flow using the jose library..."
    }
  ],
  "query": "how did we implement OAuth?",
  "searched_at": "2026-01-20T09:00:00Z",
  "embedding_model": "all-MiniLM-L6-v2",
  "result_count": 1
}
```

**Error** (422 Unprocessable Entity):
```json
{
  "detail": [{ "loc": ["body", "project_id"], "msg": "field required", "type": "value_error.missing" }]
}
```

### GET /health

Health check for the service.

**Response** (200 OK):
```json
{
  "status": "healthy",
  "model": "all-MiniLM-L6-v2",
  "model_loaded": true,
  "database": "healthy",
  "queue_consumer": "running",
  "timestamp": "2026-01-20T09:00:00Z"
}
```

**Response** (503 Degraded):
```json
{
  "status": "degraded",
  "model": "all-MiniLM-L6-v2",
  "model_loaded": true,
  "database": "unhealthy",
  "queue_consumer": "running",
  "timestamp": "2026-01-20T09:00:00Z"
}
```

---

## 5. Queue Consumer

The queue consumer runs as an asyncio background task within the FastAPI process:

```
Loop:
  1. Read from Redis list: BLPOP nl-assembly:queue 5  (5-second timeout)
  2. If job received:
     a. Parse job JSON: { contextPackId, jobId, enqueuedAt }
     b. Load context pack content from DB
     c. Generate embedding
     d. UPDATE context_packs SET embedding = $1 WHERE id = $2
     e. UPDATE pack_embeddings_queue SET status = 'completed', processed_at = now()
  3. On error:
     e. UPDATE pack_embeddings_queue SET status = 'failed', last_error = $1, attempts = attempts + 1
     f. If attempts < 3: re-enqueue with backoff
     g. If attempts >= 3: leave as 'failed' (dead letter)
  4. Back to step 1
```

The consumer runs in a separate asyncio task, not a thread. This allows it to use the same asyncpg connection pool as the request handlers without thread-safety concerns.

---

## 6. Model Selection (Configurable)

The embedding model is selected at startup via `NL_ASSEMBLY_EMBEDDING_MODEL` environment variable. The model is loaded once and held in memory for the lifetime of the process.

Model loading uses sentence-transformers' lazy loading — the model is downloaded on first use if not in the local cache. In Docker, the model is pre-downloaded during the image build:

```dockerfile
# Pre-download model during Docker build
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
```

The model directory is at `/root/.cache/torch/sentence_transformers/` inside the container.
