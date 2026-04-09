# Feature Pack 05: NL Assembly — Technology Choices and Rationale

## 1. Why Python for This Service

### The Decisive Advantage: sentence-transformers

The NL Assembly service exists to generate vector embeddings from text. The canonical library for this is `sentence-transformers` — a Python library maintained by Hugging Face that wraps BERT-family models for sentence-level embeddings.

`sentence-transformers` provides:
- 15,000+ pretrained models on HuggingFace Hub, all compatible with one API
- State-of-the-art results on the MTEB (Massive Text Embedding Benchmark) — the standard benchmark for embedding quality
- One-line inference: `model.encode(texts)` — batch-optimized, GPU-aware, with automatic tokenization
- No model serving infrastructure needed — the model runs in-process

The JavaScript alternative (`@xenova/transformers`) exists but has known issues: slightly different embeddings due to quantization differences from the Python version, fewer models, no production tooling comparable to sentence-transformers. Using it for a search feature that users rely on would mean accepting degraded search quality for no gain.

**There is no technical reason to use JavaScript for this service. Python is the correct choice.**

### Polyglot Boundary Rule

Python is permitted in ContextOS services only for: ML inference and heavy AST/code analysis. NL Assembly satisfies "ML inference" — it runs a sentence transformer model. Everything else (MCP server, hooks bridge, web app) remains TypeScript. This prevents scope creep.

The boundary is enforced via service contracts (HTTP + JSON Schema). The TypeScript MCP Server calls `POST /search` on the NL Assembly service. The Python service returns a typed Pydantic response. No cross-language type-sharing is needed.

---

## 2. sentence-transformers Library

### Model Selection Rationale

**Default: `all-MiniLM-L6-v2`**

This model offers the best speed/quality tradeoff for ContextOS's use case:
- **384 dimensions**: Small enough for efficient HNSW indexing and cosine distance computation
- **~80MB model size**: Fits in container memory without GPU requirements
- **~14,000 sentences/second on CPU**: Well within the throughput needed for context pack indexing
- **Competitive quality**: Strong on semantic textual similarity tasks; used in production at many companies

For a SaaS with potentially many concurrent projects and context packs, CPU-only inference at this speed is adequate. GPU inference would be overkill (and expensive) for this batch size.

**Why not OpenAI text-embedding-3-small?**

OpenAI embeddings are excellent quality but introduce:
- **Vendor dependency**: Every embedding generation requires an API call. If OpenAI is down or rate-limited, embedding stops.
- **Cost**: $0.02 per million tokens. For a system that embeds every Context Pack on every run, this adds up.
- **Latency**: Network round-trip per batch vs. in-process inference.
- **Dimension mismatch**: OpenAI's models use 1536 or 3072 dimensions. Switching later requires rebuilding all indexes.

Local sentence-transformers is faster, free, and doesn't depend on an external service. OpenAI embeddings are available as a fallback via `NL_ASSEMBLY_EMBEDDING_MODEL=text-embedding-3-small` configuration.

### `normalize_embeddings=True`

Normalizing embeddings to unit L2 norm is essential for cosine similarity via pgvector's `<=>` operator. With unit-norm embeddings, `cosine_similarity(a, b) = dot_product(a, b)`, which is the most computationally efficient operation. pgvector's HNSW index is optimized for this pattern. Without normalization, cosine distance computation is more expensive.

---

## 3. asyncpg + pgvector

### Why asyncpg Over SQLAlchemy or psycopg3

asyncpg is a native asyncio PostgreSQL client — it does not block the event loop during queries. For an API service that handles concurrent search requests, non-blocking DB access is essential.

SQLAlchemy async mode is possible but adds abstraction overhead. For this service's simple query patterns (one search query per request, one UPDATE per embedding job), asyncpg's raw SQL interface is more direct and performant.

psycopg3 is also async-capable and is becoming the new Python PostgreSQL standard. Either would work. asyncpg was chosen for its:
- Excellent pgvector integration via the `pgvector-python` package's `asyncpg` codec
- Mature production track record
- Connection pool implementation that matches ContextOS's concurrency needs

### pgvector Integration

The `pgvector` Python package (`pgvector.asyncpg`) registers a custom asyncpg codec for the `vector` type. After calling `register_vector(conn)` in the pool's `init` function, asyncpg automatically serializes Python lists to pgvector format and deserializes pgvector to Python lists. No manual array formatting needed.

```python
# After register_vector, this just works:
await conn.execute(
    'UPDATE context_packs SET embedding = $1::vector WHERE id = $2::uuid',
    embedding_list_of_floats,  # Python list
    pack_id,
)
```

---

## 4. FastAPI (Not Flask, Not Django)

### Why FastAPI

FastAPI is the right framework for this service for three reasons:

1. **Automatic OpenAPI documentation**: FastAPI generates an OpenAPI spec and Swagger UI from Pydantic models. The TypeScript MCP Server can validate its HTTP calls against the spec. This replaces manual documentation that would drift.

2. **Pydantic validation**: Request bodies are automatically validated against Pydantic models. Invalid requests return structured 422 errors with field-level details — the same error format the TypeScript callers expect. FastAPI + Pydantic v2 is the Python equivalent of Hono + Zod.

3. **asyncio native**: FastAPI route handlers are async by default. Database calls (asyncpg) and Redis calls (redis.asyncio) are awaited without blocking. A synchronous framework (Flask, Django) would block on every DB call, limiting concurrent throughput.

**vs. Flask**: Flask is synchronous by default. Flask async support exists but is less ergonomic than FastAPI's native async. Flask has no built-in validation or OpenAPI generation.

**vs. Django**: Django is designed for full-stack web applications with ORM, admin, templates, and sessions. NL Assembly is a microservice with 3 endpoints. Django is massive overkill. Django REST Framework adds API capabilities but the total package is still significantly heavier than FastAPI.

**vs. Litestar**: Litestar is an excellent modern alternative to FastAPI with similar async-first design and Pydantic v2 support. Either would work. FastAPI has wider ecosystem adoption and more ContextOS team familiarity.

### Lifespan Events

FastAPI's `@asynccontextmanager lifespan` function handles startup and shutdown:
- **Startup**: Load the embedding model (blocking operation — must complete before serving requests), create DB connection pool, start queue consumer
- **Shutdown**: Stop queue consumer gracefully, close DB pool, close Redis connection

This pattern ensures the model is always loaded before any request is served, and cleanup runs reliably on shutdown (SIGTERM). It's cleaner than `@app.on_event("startup")` (deprecated in FastAPI 0.110+).
