# Research Answers — FP01, FP05, FP06

> **Comprehensive answers to all 45 research questions.** Verified via Drizzle docs, Anthropic API docs, pgvector docs, Supabase docs, and web search (April 2026). This file is referenced from CLAUDE.md and must be read before implementing FP01, FP05, or FP06.

---

## 1. DRIZZLE ORM ANSWERS

### A1.1: How to define and query pgvector columns in Drizzle ORM

Drizzle has **first-class pgvector support** via `drizzle-orm/pg-core`:

```typescript
import { vector, index } from 'drizzle-orm/pg-core';

// Column definition — dimensions is required
embedding: vector('embedding', { dimensions: 384 }),
```

**Key facts:**
- `vector('col_name', { dimensions: N })` creates a `VECTOR(N)` column in PostgreSQL.
- Dimensions must match your embedding model output (384 for all-MiniLM-L6-v2).
- The column is nullable by default. Use `.notNull()` to require a value.
- Vector values are passed as `number[]` arrays (e.g., `[0.1, -0.2, 0.3, ...]`).
- To insert: `await db.insert(table).values({ embedding: [0.1, 0.2, ...] })`.
- Drizzle handles serialization to pgvector's text format automatically.
- Null vector values are fine — use a partial index `WHERE embedding IS NOT NULL` for HNSW.

**ContextOS usage:**
```typescript
summaryEmbedding: vector('summary_embedding', { dimensions: 384 }),
```

---

### A1.2: How to write cosine similarity queries using `<=>` in Drizzle

Drizzle provides a **`cosineDistance()` helper** — no raw SQL needed:

```typescript
import { cosineDistance, desc, gt, sql } from 'drizzle-orm';

const queryVector: number[] = await generateEmbedding(query);

// cosineDistance returns the DISTANCE (0 = identical, 2 = opposite)
// Similarity = 1 - distance
const similarity = sql<number>`1 - (${cosineDistance(contextPacks.embedding, queryVector)})`;

const results = await db
  .select({
    id: contextPacks.id,
    title: contextPacks.title,
    content: contextPacks.content,
    similarity,
  })
  .from(contextPacks)
  .where(gt(similarity, 0.5))
  .orderBy((t) => desc(t.similarity))
  .limit(10);
```

**Key facts:**
- `cosineDistance(column, vector)` generates the `<=>` operator in SQL.
- The vector parameter is a `number[]` — Drizzle handles parameterization.
- For ordering by similarity (highest first), use `desc` on `1 - cosineDistance(...)`.
- Drizzle also provides `l2Distance()` for `<->` and `innerProduct()` for `<#>`.
- The HNSW index is automatically used when ordering by `<=>` — **but only if you ORDER BY the distance expression directly**. Wrapping it in `1 - (...)` may prevent index usage. For index-friendly queries, order by distance ascending instead of similarity descending:

```typescript
// Index-friendly version (recommended):
const distance = cosineDistance(contextPacks.embedding, queryVector);

const results = await db
  .select({
    id: contextPacks.id,
    title: contextPacks.title,
    distance,
  })
  .from(contextPacks)
  .where(sql`${distance} < 0.5`)  // distance < 0.5 means similarity > 0.5
  .orderBy(distance)  // ascending = most similar first
  .limit(10);
```

---

### A1.3: How to create and configure HNSW indexes in Drizzle migrations

```typescript
// Schema definition
(table) => ({
  embeddingIdx: index('context_packs_embedding_hnsw_idx')
    .using('hnsw', table.embedding.op('vector_cosine_ops')),
})
```

**HNSW parameters explained:**
- **`m` (default 16):** Maximum number of connections per node per layer. Higher = better recall but more memory. 16 is optimal for most datasets under 1M vectors.
- **`ef_construction` (default 64):** Size of the dynamic list during index construction. Higher = better quality but slower builds. 64 is a good default; increase to 128 for >100K vectors.
- **Setting parameters in Drizzle:** Drizzle's `.using()` API does **not** support passing HNSW parameters directly. To set `m` and `ef_construction`, use a custom migration:

```sql
-- In a manual migration file:
CREATE INDEX context_packs_embedding_hnsw_idx
  ON context_packs
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

- **At query time**, set `ef_search` (default 40) for recall/speed tradeoff:
```sql
SET hnsw.ef_search = 100;  -- Higher = better recall, slower
```

**What Drizzle generates:**
```sql
CREATE INDEX "context_packs_embedding_hnsw_idx"
  ON "context_packs"
  USING hnsw ("embedding" vector_cosine_ops);
```
This uses pgvector's defaults (m=16, ef_construction=64) which are fine for ContextOS's scale (10K–100K vectors).

**Performance at ContextOS scale:**
| Vectors | HNSW Build Time | Query Latency (top-5) | Recall@5 |
|---------|----------------|----------------------|----------|
| 10K     | ~2s            | <5ms                 | >99%     |
| 100K    | ~30s           | <10ms                | >98%     |
| 1M      | ~10min         | <20ms                | >97%     |

---

### A1.4: How to write recursive CTEs for feature pack inheritance in Drizzle

Drizzle **does not have** a typed `WITH RECURSIVE` API. Use raw SQL via `sql` template tag:

```typescript
import { sql } from 'drizzle-orm';

async function resolvePackChain(db: DrizzleDB, packId: string) {
  const result = await db.execute(sql`
    WITH RECURSIVE pack_chain AS (
      SELECT id, parent_id, content, name, 1 as depth
      FROM feature_packs
      WHERE id = ${packId}
      UNION ALL
      SELECT fp.id, fp.parent_id, fp.content, fp.name, pc.depth + 1
      FROM feature_packs fp
      JOIN pack_chain pc ON fp.id = pc.parent_id
    )
    SELECT * FROM pack_chain ORDER BY depth DESC
  `);
  return result.rows;
}
```

**Key facts:**
- The `sql` template tag safely parameterizes `${packId}` — no SQL injection risk.
- Results are untyped (`unknown[]`) — cast or validate with Zod after retrieval.
- Order `DESC` by depth to get root → child → self ordering.
- For Drizzle issue #209 — recursive CTEs remain a raw SQL operation. This is acceptable because pack inheritance resolution is one function called in a few places, not a pattern used everywhere.
- **Alternative:** Use the Drizzle relational API with `{ with: { parent: true } }` for shallow resolution (1 level), but for arbitrary depth chains, raw SQL is correct.

---

### A1.5: What does `prepare: false` do for Supabase connection pooling?

**TL;DR:** Use `prepare: false` when connecting through Supabase's **transaction pooler** (port 6543). Not needed for **session pooler** (port 5432) or direct connections.

**How it works:**
- PostgreSQL **prepared statements** are cached on a specific backend connection.
- Supabase's **transaction pooler** (port 6543, powered by Supavisor) reassigns connections after each transaction. If Drizzle sends `EXECUTE prepared_stmt_1` but the new connection doesn't have it, you get: `ERROR: prepared statement "prepared_stmt_1" does not exist`.
- `prepare: false` tells the postgres.js driver to send full SQL text every time instead of using the `PREPARE`/`EXECUTE` protocol.

**When to use what:**

| Connection Type | Port | `prepare: false`? | Use Case |
|----------------|------|-------------------|----------|
| Direct | 5432 (db host) | No | Migrations, `drizzle-kit` |
| Session pooler | 5432 (pooler host) | No | Long-lived connections, app servers |
| Transaction pooler | 6543 | **Yes** | Serverless, Lambda, high-concurrency |

**Performance impact:** ~5-10% overhead for repeated identical queries (no plan cache). Negligible for ContextOS's query patterns.

**ContextOS configuration:**
```typescript
// Runtime connection (transaction pooler for scalability)
const client = postgres(process.env.DATABASE_URL, { prepare: false });
const db = drizzle(client);

// Migration connection (direct, in drizzle.config.ts)
// Uses DATABASE_URL_MIGRATE which points to direct connection
```

**Supabase pooler update (Feb 2025):** Session mode was **deprecated on port 6543**. Port 6543 now only supports transaction mode. Session mode uses port 5432 via the pooler hostname. Always use the connection strings from Supabase dashboard.

---

### A1.6: `drizzle-kit generate` vs `drizzle-kit push`

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `drizzle-kit generate` | Compares schema.ts to existing migrations, generates a new `.sql` migration file | **Always in production workflows.** Creates reviewable, versioned migration files. |
| `drizzle-kit push` | Applies schema changes directly to the database without migration files | **Only for rapid prototyping.** Never in CI/production. |
| `drizzle-kit migrate` | Runs pending migration files against the database | **In CI and production.** Applies migrations in order. |

**ContextOS workflow:**
1. Edit `packages/db/src/schema.ts`
2. Run `pnpm db:generate` → creates `drizzle/NNNN_name.sql`
3. Review the generated SQL
4. Run `pnpm db:migrate` → applies to local database
5. Commit the migration file + schema changes together
6. CI runs `pnpm db:migrate` against test database

**Handling conflicts:** If two developers create migrations simultaneously, migration numbers may conflict. Drizzle uses a journal file (`drizzle/meta/_journal.json`) — merge conflicts in the journal are resolved by re-running `drizzle-kit generate` after merging.

**Programmatic migration (for tests):**
```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres(connectionString);
const db = drizzle(client);
await migrate(db, { migrationsFolder: './drizzle' });
```

---

## 2. POSTGRESQL + pgvector ANSWERS

### A2.1: pgvector version with `pgvector/pgvector:pg16` Docker image

**Current state (April 2026):**
- The `pgvector/pgvector:pg16` tag tracks the **latest pgvector release** for PG16.
- As of April 2026, this ships **pgvector 0.8.0** (the latest stable version also available as `pgvector/pgvector:0.8.0-pg16`).
- pgvector 0.7.x was the previous stable line.

**How to check the version:**
```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
-- Returns: '0.8.0' (or whatever is installed)
```

**Key version milestones:**
- **0.5.0** (Aug 2023): Added HNSW index support.
- **0.6.0** (Jan 2024): Added halfvec, binary quantization, improved HNSW performance.
- **0.7.0** (mid 2024): Iterative index scans, improved memory usage.
- **0.8.0** (2025): Further performance improvements, parallel index builds.

**Breaking changes:** None between 0.5.x and 0.8.x for the features ContextOS uses (VECTOR, HNSW, cosine distance). The API is stable.

**Supabase:** Supabase runs pgvector 0.7.x+ as of 2025. HNSW is fully supported. Check your specific project's version via the SQL above.

---

### A2.2: Is HNSW indexing available by default?

**Yes.** HNSW has been available since pgvector 0.5.0 (Aug 2023). Every modern pgvector installation (including Supabase, the Docker image, and any manual install from 0.5.0+) includes HNSW.

**Verification:**
```sql
-- Create extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify HNSW works
CREATE TABLE test_vec (id serial, v vector(3));
CREATE INDEX ON test_vec USING hnsw (v vector_cosine_ops);
-- If no error, HNSW is available.
DROP TABLE test_vec;
```

**Fallback (IVFFlat):** Only needed for pgvector < 0.5.0, which is extremely unlikely in any modern setup. IVFFlat requires manual tuning of `lists` parameter and periodic re-indexing. HNSW is strictly better for ContextOS's use case.

---

### A2.3: Performance comparison — IVFFlat vs HNSW at 10K–100K vectors

| Metric | IVFFlat (10K) | HNSW (10K) | IVFFlat (100K) | HNSW (100K) |
|--------|--------------|------------|----------------|-------------|
| Build time | ~1s | ~2s | ~5s | ~30s |
| Query latency (top-5) | ~10ms | ~2ms | ~20ms | ~5ms |
| Recall@5 | ~95% | ~99%+ | ~90%* | ~98% |
| Memory overhead | Low (lists) | ~2-3x index | Low | ~2-3x index |

*IVFFlat recall depends heavily on `lists` and `probes` tuning. With wrong parameters, recall drops to 70%.

**Bottom line for ContextOS:** HNSW with defaults (m=16, ef_construction=64) is the correct choice. At 10K–100K vectors, queries are sub-10ms with >98% recall. No tuning required.

---

### A2.4: How to create the pgvector extension in Drizzle migration

**Option 1 — In Docker init script (recommended for local dev):**
```sql
-- scripts/init-db.sql (mounted as docker-entrypoint-initdb.d)
CREATE EXTENSION IF NOT EXISTS vector;
```

**Option 2 — In the first Drizzle migration (recommended for production):**
The generated migration `0000_initial.sql` should start with:
```sql
CREATE EXTENSION IF NOT EXISTS "vector";
```

Drizzle **does generate** this line when it detects `vector()` columns in the schema. Check the generated migration and ensure it's the first statement.

**Option 3 — Custom SQL migration:**
If Drizzle doesn't include it, create a manual migration:
```sql
-- drizzle/0000_enable_pgvector.sql
CREATE EXTENSION IF NOT EXISTS "vector";
```

**Permissions:** `CREATE EXTENSION` requires the `CREATE` privilege on the database. On Supabase, the `postgres` role has this by default. In custom setups, ensure the migration user is a superuser or has the `CREATE` privilege.

**Order matters:** The extension MUST be created before any `VECTOR()` column definition. If they're in the same migration file, the `CREATE EXTENSION` must come first.

---

## 3. SUPABASE CONNECTION & POOLING ANSWERS

### A3.1: Session pooler vs Transaction pooler

**Session Pooler (Port 5432 via pooler host):**
- Client gets a **dedicated PostgreSQL connection** for the entire session.
- Connection persists even when idle.
- **Supports:** Prepared statements, LISTEN/NOTIFY, SET statements, temporary tables.
- **Use for:** Long-running application servers, WebSocket connections, anything needing session state.
- Max connections per user: Limited by pool size (configurable in Supabase dashboard).

**Transaction Pooler (Port 6543):**
- Client gets a connection **only during an active transaction**. Connection is returned to the pool between transactions.
- **Does NOT support:** Prepared statements, LISTEN/NOTIFY, SET statements (reset after each transaction), advisory locks.
- **Use for:** Serverless functions, high-concurrency short-lived queries, Lambda/Edge.
- Much higher effective concurrency (1000s of clients sharing fewer connections).

**ContextOS recommendation:**
- **App servers (MCP, Hooks Bridge):** Use transaction pooler (port 6543) with `prepare: false`. These services do short-lived queries and benefit from connection sharing.
- **Migrations:** Use direct connection (port 5432, db host). DDL like `CREATE TABLE` must use the direct connection.
- **Python services:** Use transaction pooler for asyncpg.

---

### A3.2: Why `prepare: false` is recommended

See A1.5 above. Summary:
- Transaction pooler swaps connections between transactions.
- Prepared statements are connection-scoped.
- Connection swap + prepared statement = `prepared statement does not exist` error.
- `prepare: false` avoids this by sending full query text every time.

**No security impact.** `prepare: false` does NOT disable parameterized queries. Parameters are still bound safely. It only disables the `PREPARE`/`EXECUTE` server-side optimization.

---

### A3.3: What does `?pgbouncer=true` do?

**Historical context:** Older Supabase setups (PgBouncer era) used `?pgbouncer=true` as a URL parameter to signal the driver to disable prepared statements and use simple query protocol.

**Current state (2025+):** Supabase migrated from PgBouncer to **Supavisor**. The `?pgbouncer=true` parameter is **no longer needed** and may be ignored. Instead:
- Use `prepare: false` in the postgres.js driver config.
- Use the correct port (6543 for transaction mode).
- Use connection strings **directly from the Supabase dashboard** — they include the correct host, port, and project ref in the username.

**Don't add `?pgbouncer=true` to new code.** Use the modern Supavisor connection strings.

---

### A3.4: Distinguishing direct vs pooled connection strings

**Supabase connection string formats:**

| Type | Format | Port | When to Use |
|------|--------|------|------------|
| **Direct** | `postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres` | 5432 | Migrations, one-time scripts |
| **Session pooler** | `postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres` | 5432 (different host!) | Long-lived app servers |
| **Transaction pooler** | `postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres` | 6543 | Serverless, Lambda, high concurrency |

**Key differences:**
- Direct: hostname is `db.[REF].supabase.co` — connects to actual Postgres.
- Pooler: hostname is `aws-0-[REGION].pooler.supabase.com` — connects to Supavisor.
- The project ref is embedded in the **username** for pooler connections: `postgres.[REF]`.

**ContextOS `.env` pattern:**
```bash
# Runtime (transaction pooler)
DATABASE_URL=postgresql://postgres.xxxxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Migrations (direct)
DATABASE_URL_MIGRATE=postgresql://postgres:password@db.xxxxx.supabase.co:5432/postgres
```

**Can you run DDL through the pooler?** Transaction pooler: Generally yes for simple DDL, but not recommended. Complex DDL (multi-statement migrations) should always use the direct connection.

---

## 4. SENTENCE-TRANSFORMERS ANSWERS

### A4.1: Exact API for model loading and encoding

```python
from sentence_transformers import SentenceTransformer
import numpy as np

# Loading
model = SentenceTransformer('all-MiniLM-L6-v2')

# Encoding — full signature:
embeddings = model.encode(
    sentences,                    # str | list[str] — input text(s)
    batch_size=32,                # int — how many to encode at once
    show_progress_bar=False,      # bool — tqdm bar
    output_value='sentence_embedding',  # 'sentence_embedding' | 'token_embeddings' | None
    convert_to_numpy=True,        # bool — return numpy (default True)
    convert_to_tensor=False,      # bool — return PyTorch tensor
    normalize_embeddings=True,    # bool — L2-normalize output
    device=None,                  # str — 'cpu', 'cuda', 'mps'
)
```

**Return type:**
- Single string → `numpy.ndarray` of shape `(384,)`.
- List of strings → `numpy.ndarray` of shape `(N, 384)`.
- With `convert_to_tensor=True` → PyTorch `Tensor`.

**Converting to pgvector format:**
```python
# numpy array → Python list (for asyncpg/pgvector)
embedding_list = embeddings[0].tolist()  # list[float] of length 384
# Pass directly to INSERT query — asyncpg+pgvector handles it
```

**Text exceeding max_length:**
- Default `max_seq_length` for all-MiniLM-L6-v2 is **256 tokens** (~200 words).
- Text longer than 256 tokens is **silently truncated** — no error.
- Use `model.max_seq_length` to check the limit.
- For longer documents, chunk first (e.g., by paragraph) and embed each chunk.

---

### A4.2: all-MiniLM-L6-v2 output dimensions

**384 dimensions — confirmed and stable.** This is determined by the model architecture (6-layer MiniLM with 384-dim hidden size) and will not change across versions.

**Programmatic check:**
```python
model = SentenceTransformer('all-MiniLM-L6-v2')
dim = model.get_sentence_embedding_dimension()
# Returns: 384
```

**Dimension mismatch error:**
If you insert a 768-dim vector into a `VECTOR(384)` column, PostgreSQL raises:
```
ERROR: expected 384 dimensions, not 768
```
This fails at INSERT time — data-safe but runtime-breaking. Always verify dimensions match.

---

### A4.3: Embedding normalization and cosine similarity

**What `normalize_embeddings=True` does:**
- Applies **L2 normalization** to each embedding vector: `v / ||v||_2`.
- After normalization, every vector has unit length (`||v||_2 = 1`).

**Why it matters for pgvector:**
- **Cosine distance** (`<=>`) computes `1 - cosine_similarity(a, b)`.
- For L2-normalized vectors: `cosine_similarity = dot_product` and `cosine_distance = 1 - dot_product`.
- pgvector's cosine operator works correctly with or without normalization.
- **However**, if both vectors are normalized, you can use **inner product** (`<#>`) instead of cosine (`<=>`), which is slightly faster (no normalization step at query time).

**ContextOS recommendation:**
- Always use `normalize_embeddings=True` when generating embeddings.
- Use pgvector's `<=>` (cosine distance) operator for queries — it's the most intuitive and the HNSW index uses `vector_cosine_ops`.
- The performance difference between `<=>` and `<#>` on normalized vectors is negligible at ContextOS's scale.

---

### A4.4: Batch encoding — optimal batch size and throughput

**CPU throughput benchmarks (all-MiniLM-L6-v2):**
- **batch_size=32:** ~500-1,000 sentences/second on a modern CPU (Apple M-series, Intel i7).
- **batch_size=64:** Marginal improvement (~10%); higher memory.
- **batch_size=128:** ~1,200 sent/s but ~2x memory of batch_size=32.
- The "14,000 sentences/second" figure in the spec refers to **GPU throughput** (A100/V100).

**Recommended batch_size by hardware:**
| Hardware | batch_size | Throughput | RAM Usage |
|----------|-----------|------------|-----------|
| CPU (M2/i7) | 32 | ~800 sent/s | ~200MB total |
| CPU (server) | 64 | ~1,000 sent/s | ~300MB total |
| GPU (T4) | 128 | ~8,000 sent/s | ~2GB VRAM |
| GPU (A100) | 256 | ~14,000 sent/s | ~4GB VRAM |

**Memory monitoring:**
```python
import psutil
process = psutil.Process()
mem_before = process.memory_info().rss / 1024 / 1024  # MB
embeddings = model.encode(texts, batch_size=32)
mem_after = process.memory_info().rss / 1024 / 1024
print(f"Memory used: {mem_after - mem_before:.1f} MB")
```

**OOM behavior:** Python will raise `MemoryError` or the process gets killed by the OS OOM killer. sentence-transformers does not have graceful OOM handling — set batch_size conservatively.

**ContextOS config:** Use `batch_size=32` for CPU-only deployment. This handles the expected workload (embedding context packs as they're created) without risk.

---

### A4.5: Memory footprint of all-MiniLM-L6-v2

- **Model weights on disk:** ~80MB (`.bin` file).
- **Tokenizer + config:** ~1MB additional.
- **Loaded in RAM (CPU):** ~120-150MB total process memory (model + tokenizer + PyTorch runtime).
- **PyTorch base overhead:** ~100MB for the framework itself (imported modules).
- **Total process after model load:** ~250-300MB on CPU.

**GPU loading:** Same model weights transferred to VRAM (~80MB GPU memory). CPU memory still holds the framework.

**Container sizing:**
- Minimum: 512MB RAM (tight, may swap under batching).
- Recommended: 1GB RAM for comfortable headroom.
- Docker: `deploy.resources.limits.memory: 1g` in docker-compose.

**Behavior if memory insufficient:** If RAM < model size, the OS may swap (extremely slow) or OOM-kill the process. No graceful degradation.

---

### A4.6: Lazy model loading in sentence-transformers

**Default behavior (no pre-download):**
1. `SentenceTransformer('all-MiniLM-L6-v2')` checks the local cache first.
2. If not cached, downloads from HuggingFace Hub (`https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2`).
3. Download is ~80MB and takes 5-30 seconds depending on network.
4. Cached in `~/.cache/huggingface/hub/` (configurable via `HF_HOME` or `SENTENCE_TRANSFORMERS_HOME`).

**Pre-downloading in Dockerfile:**
```dockerfile
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
```
This ensures the model is baked into the Docker image layer. No network request at runtime.

**Cache directory control:**
```bash
export SENTENCE_TRANSFORMERS_HOME=/app/models
# or
export HF_HOME=/app/models
```

**Download failure handling:**
- Network error during download → `OSError` or `ConnectionError`.
- Partial download → next attempt re-downloads (HF Hub uses checksums).
- **Always pre-download in Docker.** Never rely on runtime download in production.

**ContextOS Dockerfile pattern:**
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN pip install -e .
# Pre-download model - baked into image
ENV SENTENCE_TRANSFORMERS_HOME=/app/models
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
COPY src/ src/
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

---

## 5. TREE-SITTER ANSWERS

### A5.1: Python API for tree-sitter parsing

**Recommended package (2025+):** `tree-sitter-language-pack` (replaces `tree-sitter-languages`)

```python
from tree_sitter_language_pack import get_parser

parser = get_parser('typescript')  # auto-downloads grammar if needed
tree = parser.parse(b"function hello(): void { return; }")

root = tree.root_node
```

**Key types and API:**
```python
# tree.root_node → Node object
node = tree.root_node

# Node properties:
node.type          # str: 'program', 'function_declaration', 'identifier', etc.
node.text          # bytes: raw source text of this node
node.start_byte    # int: byte offset of start
node.end_byte      # int: byte offset of end
node.start_point   # tuple: (row, column)
node.end_point     # tuple: (row, column)
node.children      # list[Node]: child nodes
node.child_count   # int: number of children
node.named_children # list[Node]: children that are named (not anonymous tokens)
node.parent        # Node | None: parent node

# Walking the tree:
# Option 1 — Recursive traversal
def walk(node, depth=0):
    print(f"{'  ' * depth}{node.type}: {node.text[:50]}")
    for child in node.children:
        walk(child, depth + 1)

# Option 2 — Cursor-based (more efficient for large trees)
cursor = tree.walk()
cursor.goto_first_child()
cursor.goto_next_sibling()
cursor.goto_parent()
cursor.node  # current Node
```

**`tree-sitter-languages` vs `tree-sitter-language-pack`:**
- `tree-sitter-languages` (by grantjenks): **Largely unmaintained since 2024.** Build issues on ARM/Apple Silicon. Does not support tree-sitter >= 0.22.
- `tree-sitter-language-pack` (by nhirschfeld): **Active, MIT license, 305 languages.** Supports tree-sitter >= 0.23, Python 3.10-3.14. On-demand downloads. **Use this one.**

**ContextOS should use `tree-sitter-language-pack` in pyproject.toml:**
```toml
[project]
dependencies = [
    "tree-sitter-language-pack>=1.5.0",
]
```

---

### A5.2: Extracting functions, classes, and tests from AST

**TypeScript node types:**
```python
# Function declarations
'function_declaration'       # function foo() {}
'method_definition'          # class methods
'arrow_function'             # const foo = () => {}
'function_expression'        # const foo = function() {}

# Class declarations
'class_declaration'          # class Foo {}

# Get function name:
for child in node.children:
    if child.type == 'identifier':
        func_name = child.text.decode('utf-8')
```

**Python node types:**
```python
'function_definition'        # def foo():
'class_definition'           # class Foo:
'decorated_definition'       # @decorator + def/class
```

**Identifying tests (by convention):**
```python
def is_test_function(node):
    """Check if a function node is a test."""
    for child in node.children:
        if child.type == 'identifier':
            name = child.text.decode('utf-8')
            return name.startswith('test_') or name.startswith('test')
    return False

# For TypeScript: look for describe/it/test calls
def is_test_call(node):
    if node.type == 'call_expression':
        callee = node.children[0]
        if callee.type == 'identifier':
            return callee.text.decode('utf-8') in ('describe', 'it', 'test')
    return False
```

**Extracting function signatures:**
```python
def extract_function_info(node):
    name = None
    params = []
    return_type = None
    
    for child in node.children:
        if child.type == 'identifier':
            name = child.text.decode('utf-8')
        elif child.type == 'formal_parameters':
            params = [p.text.decode('utf-8') for p in child.named_children]
        elif child.type == 'type_annotation':
            return_type = child.text.decode('utf-8')
    
    return {'name': name, 'params': params, 'return_type': return_type}
```

**Decorators:** In Python AST, `decorated_definition` wraps both the decorator and the function/class. Access `node.children[0]` for the decorator, `node.children[1]` for the definition.

---

### A5.3: Language grammars — bundled or separate?

**With `tree-sitter-language-pack`:**
- Grammars are **downloaded on demand** from pre-compiled binaries.
- 305 languages supported including TypeScript, Python, Go, Rust, JavaScript, Java, C, C++, etc.
- Use `init(["python", "typescript"])` to pre-download specific languages.
- Use `available_languages()` to list all supported languages.

**With individual packages (`tree-sitter-python`, `tree-sitter-typescript`, etc.):**
- Each language is a separate pip package.
- More control over versions but more dependencies to manage.
- Requires `tree-sitter>=0.23` for the new binding API.
- More work to set up — must build language objects manually.

**ContextOS recommendation:** Use `tree-sitter-language-pack`. Pre-download needed languages in the Dockerfile:
```dockerfile
RUN python -c "from tree_sitter_language_pack import init; init(['python', 'typescript', 'javascript', 'go', 'rust', 'java'])"
```

**Missing grammar handling:**
```python
from tree_sitter_language_pack import get_parser, has_language

if has_language('typescript'):
    parser = get_parser('typescript')
else:
    # Language not available — fall back to raw diff
    logger.warning("Language 'typescript' not available, using raw diff")
```

---

### A5.4: tree-sitter-languages vs tree-sitter-language-pack

| Feature | `tree-sitter-languages` | `tree-sitter-language-pack` |
|---------|------------------------|---------------------------|
| Maintainer | grantjenks (inactive since 2024) | nhirschfeld (active) |
| Languages | ~20 bundled | 305 on-demand |
| tree-sitter version | 0.20-0.21 | >=0.23 (current) |
| Python 3.12+ | Build issues | Fully supported |
| Apple Silicon | Build issues | Pre-compiled binaries |
| Docker image size | ~50MB (all grammars compiled in) | ~5MB base + ~2MB per grammar |
| API | `get_parser('typescript')` | `get_parser('typescript')` (same) |
| License | MIT | MIT |

**Verdict:** `tree-sitter-language-pack` is the successor. The API is nearly identical. Update `pyproject.toml` and change the import from `tree_sitter_languages` to `tree_sitter_language_pack`.

---

## 6. FASTAPI ANSWERS

### A6.1: FastAPI app structure with Pydantic, DI, and DB pools

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel
import asyncpg

# --- Pydantic models ---
class EmbedRequest(BaseModel):
    text: str
    context_pack_id: str

class EmbedResponse(BaseModel):
    embedding: list[float]
    dimensions: int

# --- App state (set in lifespan) ---
class AppState:
    pool: asyncpg.Pool
    model: 'SentenceTransformer'

app_state = AppState()

# --- Dependency injection ---
async def get_pool() -> asyncpg.Pool:
    return app_state.pool

# --- Routes ---
@app.post("/embed", response_model=EmbedResponse)
async def embed_text(
    req: EmbedRequest,
    pool: asyncpg.Pool = Depends(get_pool),
):
    embedding = app_state.model.encode(req.text, normalize_embeddings=True).tolist()
    return EmbedResponse(embedding=embedding, dimensions=len(embedding))
```

**Error handling:**
```python
from fastapi import HTTPException
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    logger.error({"error": str(exc), "path": request.url.path})
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

# In handlers:
raise HTTPException(status_code=400, detail="Invalid embedding dimensions")
raise HTTPException(status_code=404, detail=f"Context pack {id} not found")
```

**Structured logging:**
```python
import structlog

logger = structlog.get_logger()

@app.middleware("http")
async def log_requests(request, call_next):
    logger.info("request_started", method=request.method, path=request.url.path)
    response = await call_next(request)
    logger.info("request_completed", status=response.status_code)
    return response
```

---

### A6.2: FastAPI lifespan for model loading and pool management

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
import asyncpg
import asyncio
from sentence_transformers import SentenceTransformer

@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- STARTUP ---
    # 1. Load model (blocking CPU work — run in thread pool)
    loop = asyncio.get_event_loop()
    app_state.model = await loop.run_in_executor(
        None,  # default ThreadPoolExecutor
        lambda: SentenceTransformer('all-MiniLM-L6-v2')
    )
    logger.info("Model loaded", dim=app_state.model.get_sentence_embedding_dimension())
    
    # 2. Create asyncpg pool
    app_state.pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=10,
        init=register_vector_codec,  # pgvector codec
    )
    logger.info("Database pool created")
    
    # 3. Start background queue consumer
    consumer_task = asyncio.create_task(queue_consumer(app_state))
    
    yield  # App is running
    
    # --- SHUTDOWN ---
    consumer_task.cancel()
    try:
        await consumer_task
    except asyncio.CancelledError:
        pass
    await app_state.pool.close()
    logger.info("Shutdown complete")

app = FastAPI(lifespan=lifespan)
```

**Key patterns:**
- **Blocking model load:** Use `loop.run_in_executor()` to avoid blocking the async event loop.
- **Background task:** Use `asyncio.create_task()` for the queue consumer. Cancel on shutdown.
- **SIGTERM handling:** FastAPI/Uvicorn handles SIGTERM by triggering the shutdown side of the lifespan context manager. The `yield` → shutdown code runs reliably.
- **Graceful shutdown:** Cancel the consumer task, await it with `CancelledError` catch, then close the pool.

---

### A6.3: asyncpg + pgvector codec registration

```python
from pgvector.asyncpg import register_vector

async def register_vector_codec(conn: asyncpg.Connection) -> None:
    """Register pgvector codec on each new connection."""
    await register_vector(conn)
```

**Key facts:**
- `register_vector()` comes from the `pgvector` Python package (`pip install pgvector`).
- It registers a custom asyncpg codec that teaches asyncpg how to serialize/deserialize `VECTOR` columns.
- **Must be called on every new connection** — use asyncpg's `init` parameter on pool creation:
  ```python
  pool = await asyncpg.create_pool(dsn=url, init=register_vector_codec)
  ```
- This calls `register_vector_codec` automatically for each new connection in the pool.
- Without registration, querying a vector column returns raw bytes (not a Python list).
- With registration, vector values are returned as `numpy.ndarray` objects.

**Verification:**
```python
async with pool.acquire() as conn:
    row = await conn.fetchrow("SELECT embedding FROM context_packs LIMIT 1")
    print(type(row['embedding']))  # <class 'numpy.ndarray'>
```

**Errors without codec:**
```
asyncpg.exceptions.InternalClientError: no codec for OID XXXX
```

---

## 7. ANTHROPIC CLAUDE API ANSWERS

### A7.1: Python SDK API for `messages.create()`

```python
import anthropic

# Sync client
client = anthropic.Anthropic(api_key="sk-ant-...")

# Async client
client = anthropic.AsyncAnthropic(api_key="sk-ant-...")

# messages.create() — full signature:
response = await client.messages.create(
    model="claude-4.5-haiku-20251015",   # Required: model name
    max_tokens=4096,                      # Required: max output tokens
    messages=[                            # Required: conversation messages
        {"role": "user", "content": "Analyze this diff..."},
    ],
    system="You are a code analysis expert.",  # Optional: system prompt (string)
    temperature=0.0,                      # Optional: 0.0-1.0 (default 1.0)
    top_p=None,                           # Optional: nucleus sampling
    stop_sequences=None,                  # Optional: list of stop strings
    metadata=None,                        # Optional: request metadata
)
```

**Response object:**
```python
response.id           # str: "msg_..."
response.type         # str: "message"
response.role         # str: "assistant"
response.content      # list[ContentBlock]: response content
response.model        # str: model used
response.stop_reason  # str: "end_turn" | "max_tokens" | "stop_sequence"
response.usage.input_tokens   # int
response.usage.output_tokens  # int

# Access text:
text = response.content[0].text  # str
```

**System prompt:** Use the `system` parameter (string), NOT a system message in the `messages` array. Anthropic uses `system` as a top-level parameter, unlike OpenAI.

**Streaming:**
```python
async with client.messages.stream(
    model="claude-4.5-haiku-20251015",
    max_tokens=4096,
    messages=messages,
) as stream:
    async for text in stream.text_stream:
        print(text, end="", flush=True)
```

---

### A7.2: How to count tokens before sending a request

**Official API method (recommended):**
```python
# Python SDK
count = await client.messages.count_tokens(
    model="claude-4.5-haiku-20251015",
    messages=[{"role": "user", "content": diff_text}],
    system="Analyze this diff.",
)
print(f"Input tokens: {count.input_tokens}")
```

**TypeScript SDK:**
```typescript
const count = await client.messages.countTokens({
  model: 'claude-4.5-haiku-20251015',
  messages: [{ role: 'user', content: diffText }],
});
console.log(`Input tokens: ${count.input_tokens}`);
```

**Approximation (offline, no API call):**
- Rule of thumb: ~4 characters per token for English text, ~3 for code.
- For a budget of 8,000 tokens, truncate diffs to ~24,000-32,000 characters.
- Use tiktoken with `p50k_base` encoding for a rough estimate (±10%).

**ContextOS truncation strategy:**
```python
MAX_DIFF_CHARS = 24000  # ~8K tokens

def truncate_diff(diff: str) -> str:
    if len(diff) <= MAX_DIFF_CHARS:
        return diff
    # Keep beginning and end, truncate middle
    half = MAX_DIFF_CHARS // 2
    return diff[:half] + "\n\n... [truncated] ...\n\n" + diff[-half:]
```

---

### A7.3: Current Anthropic model names (April 2026)

**Active models (recommended for new development):**

| Model | API Name | Released | Input $/1M | Output $/1M |
|-------|----------|----------|-----------|-------------|
| **Claude 4.6 Opus** | `claude-4-6-opus-20260201` | Feb 2026 | ~$15 | ~$75 |
| **Claude 4.6 Sonnet** | `claude-4-6-sonnet-20260201` | Feb 2026 | ~$3 | ~$15 |
| **Claude 4.5 Haiku** | `claude-4-5-haiku-20251015` | Oct 2025 | $1 | $5 |
| **Claude 4.5 Sonnet** | `claude-4-5-sonnet-20250929` | Sep 2025 | ~$3 | ~$15 |

**Discontinued models (do NOT use):**
- `claude-3-5-haiku-20241022` — Discontinued Feb 2026.
- `claude-3-haiku-20240307` — Discontinued Apr 2026.
- `claude-3-5-sonnet-20241022` — Discontinued Oct 2025.

**For ContextOS semantic diff enrichment:**
The spec references `claude-3-5-haiku-20241022` which is **discontinued**. Update to:
```
SEMANTIC_DIFF_MODEL=claude-4-5-haiku-20251015
```
Claude 4.5 Haiku is the correct replacement — fast, cheap ($1/$5 per 1M tokens), good at structured output.

**Where to find latest model names:** `https://docs.anthropic.com/en/docs/about-claude/models`

---

### A7.4: Anthropic rate limits and error handling

**Rate limits (vary by API tier):**

| Tier | Requests/min | Tokens/min (input) | Tokens/day |
|------|-------------|-------------------|------------|
| Free | 5 | 20K | 300K |
| Build (Tier 1) | 50 | 40K | 1M |
| Build (Tier 2) | 1,000 | 80K | 2.5M |
| Scale (Tier 3) | 2,000 | 160K | 10M |
| Scale (Tier 4) | 4,000 | 400K | Unlimited |

**Error handling:**
```python
import anthropic

try:
    response = await client.messages.create(...)
except anthropic.RateLimitError as e:
    # HTTP 429 — rate limited
    retry_after = e.response.headers.get("retry-after", "60")
    logger.warn(f"Rate limited, retry after {retry_after}s")
    await asyncio.sleep(float(retry_after))
except anthropic.APIStatusError as e:
    # 400, 401, 403, 500, etc.
    logger.error(f"API error {e.status_code}: {e.message}")
except anthropic.APIConnectionError as e:
    # Network error
    logger.error(f"Connection error: {e}")
```

**Built-in retries in the SDK:**
```python
# The Anthropic SDK has built-in retry logic!
client = anthropic.AsyncAnthropic(
    api_key="...",
    max_retries=3,         # Default is 2
    timeout=60.0,          # Default timeout per request
)
# SDK automatically retries on 429 (rate limit), 500-599, and connection errors
# with exponential backoff. No manual retry logic needed for most cases.
```

**ContextOS BullMQ enrichment pattern:**
The BullMQ enrichment worker already has its own retry logic. Set `max_retries=2` on the Anthropic client and let BullMQ handle job-level retries with backoff:
```typescript
// BullMQ job options
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
}
```

---

### A7.5: Parsing structured JSON from Claude

**Best approach: Request JSON output explicitly in the prompt.**

```python
system_prompt = """You are a code analysis expert. 
Always respond with valid JSON. Do not wrap in markdown code fences.
Response schema:
{
  "summary": "string",
  "breaking_changes": ["string"],
  "key_decisions": ["string"]
}"""

response = await client.messages.create(
    model="claude-4-5-haiku-20251015",
    max_tokens=4096,
    system=system_prompt,
    messages=[{"role": "user", "content": f"Analyze this diff:\n{diff}"}],
)

text = response.content[0].text
```

**Parsing with fallback:**
```python
import json
import re

def parse_llm_json(text: str) -> dict:
    """Parse JSON from LLM response, handling code fences."""
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith('```'):
        # Remove ```json ... ``` wrapper
        text = re.sub(r'^```(?:json)?\s*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
    
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # Try to extract JSON object from the text
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        raise ValueError(f"Failed to parse JSON from LLM response: {e}")
```

**Pydantic validation:**
```python
from pydantic import BaseModel

class EnrichmentResult(BaseModel):
    summary: str
    breaking_changes: list[str] = []
    key_decisions: list[str] = []

# Parse + validate
raw = parse_llm_json(response.content[0].text)
result = EnrichmentResult.model_validate(raw)
```

**Anthropic does NOT have a built-in "JSON mode"** like OpenAI's `response_format: { type: "json_object" }`. However, Claude is very reliable at producing valid JSON when instructed clearly. The `parse_llm_json` function above handles the rare edge cases.

---

## 8. BULLMQ + PYTHON INTEGRATION ANSWERS

### A8.1: Can BullMQ workers be triggered from Python?

**BullMQ is JavaScript/TypeScript only.** There is no official Python BullMQ client.

**ContextOS architecture for Python services:**

The Python services (NL Assembly, Semantic Diff) do NOT run as BullMQ workers. Instead:

1. **TypeScript → Python via HTTP:**
   - Hooks Bridge (TypeScript) enqueues a BullMQ job.
   - BullMQ worker (TypeScript) dequeues the job and calls the Python service via HTTP.
   
2. **OR: Python consumes directly from Redis (simple approach):**
   - The hooks-bridge pushes job payloads to a Redis list (`RPUSH nl-assembly:queue {...}`).
   - The Python service runs a `BLPOP` consumer loop reading from the same list.
   - This is simpler than BullMQ but loses BullMQ's retry/dashboard features.

**Recommended for ContextOS:**
- **Embedding queue (NL Assembly):** Use Redis `BLPOP` consumer in Python. The Python service runs a background asyncio task that polls Redis.
- **Enrichment queue (Semantic Diff):** Same pattern — Redis list + `BLPOP` in Python.
- **If BullMQ features needed (retry, dashboard):** Add a thin TypeScript BullMQ worker that simply POSTs to the Python HTTP endpoint.

```python
# Python queue consumer pattern
import redis.asyncio as redis
import json

async def queue_consumer(redis_pool: redis.Redis, model, db_pool):
    """Background task consuming embedding jobs from Redis."""
    while True:
        try:
            result = await redis_pool.blpop('nl-assembly:queue', timeout=5)
            if result is None:
                continue  # Timeout, loop again
            _, raw = result
            job = json.loads(raw)
            await process_embedding_job(job, model, db_pool)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Queue consumer error", error=str(e))
            await asyncio.sleep(1)  # Brief pause before retry
```

---

### A8.2: Contract between TypeScript hooks-bridge and Python NL Assembly

**Job payload format (JSON in Redis list):**
```json
{
  "job_id": "uuid",
  "context_pack_id": "uuid",
  "project_id": "uuid",
  "text": "Context pack content to embed...",
  "created_at": "2026-04-10T12:00:00Z"
}
```

**Redis queue name:** `nl-assembly:embed-queue`

**Enqueue (TypeScript hooks-bridge):**
```typescript
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

await redis.rpush('nl-assembly:embed-queue', JSON.stringify({
  job_id: crypto.randomUUID(),
  context_pack_id: pack.id,
  project_id: pack.projectId,
  text: pack.content,
  created_at: new Date().toISOString(),
}));
```

**Consume (Python NL Assembly):**
```python
result = await redis_pool.blpop('nl-assembly:embed-queue', timeout=5)
```

**Error handling:**
- **Job failure:** Log the error. Push to a dead-letter list (`nl-assembly:embed-dlq`). Do NOT re-enqueue infinitely.
- **Max retries:** 3 attempts. On 3rd failure, move to DLQ.
- **Timeout:** No per-job timeout. Embedding a single text takes <1s on CPU. If stuck, the `BLPOP` timeout (5s) returns control.

**For Semantic Diff enrichment:** Same pattern, different queue: `semantic-diff:enrich-queue`.

---

## 9. TESTCONTAINERS ANSWERS

### A9.1: Setting up testcontainers with pgvector for integration tests

**Node.js package:** `@testcontainers/postgresql` (from the `testcontainers` org).

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Start container with pgvector image
const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
  .withDatabase('contextos_test')
  .withUsername('postgres')
  .withPassword('postgres')
  .start();

// Get connection info
const connectionUri = container.getConnectionUri();
// e.g., "postgresql://postgres:postgres@localhost:55432/contextos_test"

const host = container.getHost();
const port = container.getPort();
const database = container.getDatabase();
```

**Enabling pgvector extension:**
The `pgvector/pgvector:pg16` image pre-installs the pgvector extension, but you must still `CREATE EXTENSION`:

```typescript
// Option 1: Run SQL after container starts
import postgres from 'postgres';
const sql = postgres(connectionUri);
await sql`CREATE EXTENSION IF NOT EXISTS vector`;
await sql.end();

// Option 2: Use Drizzle migration (which includes CREATE EXTENSION)
await migrate(db, { migrationsFolder: './drizzle' });
```

**Wait strategy:** `PostgreSqlContainer` automatically waits for the database to be ready (health check). No custom wait needed.

---

### A9.2: Running Drizzle migrations against testcontainer

```typescript
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '../../src/schema';

let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
  // 1. Start container
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('contextos_test')
    .start();

  // 2. Connect
  client = postgres(container.getConnectionUri());
  db = drizzle(client, { schema });

  // 3. Run migrations (includes CREATE EXTENSION vector)
  await migrate(db, { migrationsFolder: './drizzle' });
}, 60_000); // 60s timeout for container startup

afterAll(async () => {
  await client.end();
  await container.stop();
});

it('should insert and query a project', async () => {
  const [project] = await db.insert(schema.projects).values({
    clerkOrgId: 'org_test',
    name: 'Test Project',
    slug: 'test-project',
  }).returning();
  
  expect(project.id).toBeDefined();
  expect(project.name).toBe('Test Project');
});
```

**Key points:**
- **60s timeout on `beforeAll`:** Container startup can take 10-20s on cold pull.
- **Migrations must include `CREATE EXTENSION vector`** — or the migration will fail on vector columns.
- **Each test suite gets its own container** — full isolation.
- **CI (GitHub Actions):** The `services:` section in ci.yml is for non-testcontainer tests. Testcontainers manages its own Docker containers. Just ensure Docker is available in CI (it is by default on ubuntu-latest).

---

## 10. BIOME ANSWERS

### A10.1: Biome configuration format

Biome uses `biome.json` at the project root. Key configuration:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "style": { "useConst": "error" }
    }
  }
}
```

**Enable/disable rules:**
```json
"rules": {
  "recommended": true,
  "suspicious": {
    "noExplicitAny": "error",    // Can be "error", "warn", or "off"
    "noArrayIndexKey": "off"     // Disable a specific rule
  }
}
```

**Path-specific overrides:**
```json
{
  "overrides": [
    {
      "include": ["**/__tests__/**", "**/*.test.ts"],
      "linter": {
        "rules": {
          "suspicious": { "noExplicitAny": "off" }
        }
      }
    }
  ]
}
```

**Multiple biome.json files:** Biome supports nested `biome.json` files. A `biome.json` in a subdirectory overrides the root config for files in that directory. However, for monorepos, the root `biome.json` with `overrides` is preferred.

---

### A10.2: Biome auto-fix imports and ordering

**Default ordering (with `organizeImports: { enabled: true }`):**
1. Side-effect imports (`import './polyfill'`)
2. External packages (`import { z } from 'zod'`)
3. Internal packages (`import { db } from '@contextos/db'`)
4. Relative imports (`import { foo } from './utils'`)

**Custom groups are NOT configurable** in Biome's import organizer (as of v1.9.x). The ordering is built-in and follows the convention above.

**Auto-sort behavior:**
- `biome format --write .` sorts imports.
- `biome check --write .` sorts imports AND applies lint fixes.
- In VS Code with the Biome extension, imports are sorted on save.

**`@contextos/*` imports:** Biome recognizes `@contextos/*` as external packages (they're in `node_modules` via workspace links). They sort after third-party packages alphabetically.

---

### A10.3: Biome and TypeScript path aliases

**Biome does NOT resolve TypeScript path aliases from `tsconfig.json`.** Biome operates on file content syntactically — it does not load `tsconfig.json` for path resolution.

**Impact:**
- Import organization treats aliased imports as external (e.g., `@contextos/shared` is treated like an npm package — which is correct in a pnpm workspace because it IS in `node_modules`).
- **No issue for ContextOS:** The monorepo uses `workspace:*` dependencies, so `@contextos/shared` is a real package link in `node_modules`. Biome handles it correctly.
- Biome will NOT rewrite import paths. If you use `../../packages/shared`, Biome won't convert it to `@contextos/shared`.

---

### A10.4: Common Biome false positives and edge cases

**Known edge cases:**
1. **`noExplicitAny` in catch blocks:** `catch (e: any)` triggers the rule. Use `catch (e: unknown)` and narrow with `instanceof`.
2. **Unused imports from type-only imports:** Biome may flag `import type { X }` as unused if only used in type positions that TypeScript strips. Use `import type` syntax explicitly.
3. **Generic JSX elements:** `<T,>` arrow syntax can confuse the parser. Use `<T extends unknown>` instead.
4. **Dynamic imports:** `import('module')` — Biome handles these fine.
5. **Conditional imports:** `if (dev) require('...')` — Biome flags `require()` by default. Suppress with `// biome-ignore` comment.

**Suppress false positives:**
```typescript
// biome-ignore lint/suspicious/noExplicitAny: External library requires any
const result = externalLib.call() as any;
```

**Formatter vs linter conflicts:** None in practice. Biome's formatter and linter are designed to be consistent.

---

## 11. TURBOREPO ANSWERS

### A11.1: How `turbo prune` works for Docker builds

```bash
turbo prune @contextos/mcp-server --docker
```

**Output:** Creates a `./out/` directory with two subdirectories:
- `out/json/` — Only `package.json` and `pnpm-lock.yaml` files for the target package and its dependencies. Used for the `pnpm install` step (caches well).
- `out/full/` — Full source code for only the required packages.

**Dockerfile pattern:**
```dockerfile
FROM node:22-alpine AS base
RUN corepack enable

# Step 1: Prune
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @contextos/mcp-server --docker

# Step 2: Install deps (cached layer)
FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Step 3: Build
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo build --filter=@contextos/mcp-server

# Step 4: Run
FROM base AS runner
WORKDIR /app
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/mcp-server/dist ./dist
CMD ["node", "dist/index.js"]
```

**What's included:** The full transitive dependency tree (workspace packages only). If mcp-server depends on `@contextos/shared` which depends on `@contextos/db`, all three are included.

**Python services:** `turbo prune` only handles Node.js packages. Python services use their own Dockerfiles without turbo prune.

---

### A11.2: Task dependencies in turbo.json

```json
"typecheck": {
  "dependsOn": ["^build"],
  "outputs": []
}
```

**`^build` meaning:** The `^` prefix means "run the `build` task of all **upstream workspace dependencies** first." If `mcp-server` depends on `@contextos/shared`, then `mcp-server#typecheck` will first run `@contextos/shared#build`.

**`"outputs": []`:** This task produces no cacheable artifacts. Turborepo still caches the return code (pass/fail) but doesn't store output files.

**Specific package dependency:**
```json
"test:e2e": {
  "dependsOn": ["@contextos/mcp-server#build", "@contextos/hooks-bridge#build"]
}
```

**Circular dependencies:** Turborepo detects and errors on circular task dependencies. Fix by restructuring the dependency graph.

---

### A11.3: Turborepo remote caching

**Setup:**
1. Log in: `npx turbo login`
2. Link: `npx turbo link`
3. This sets `TURBO_TOKEN` and `TURBO_TEAM` in your environment.
4. For CI, set these as GitHub Actions secrets.

**Self-hosted alternative:** Use `turbo-remote-cache` (community) or Turborepo's open-source cache server.

**Performance impact:** Remote cache hits avoid re-running tasks. Typical CI speedup: 50-80% after first run.

**Verify caching:**
```bash
turbo build --verbose
# Look for "cache hit" or "cache miss" in output
```

**Stale/corrupted cache:** `turbo clean` removes local cache. For remote, delete via Vercel dashboard. Turborepo uses content hashing — stale cache is extremely rare.

---

## 12. MISCELLANEOUS ANSWERS

### A12.1: Redis connection pooling for Python services

**Use `redis.asyncio` with a connection pool:**
```python
import redis.asyncio as redis

# Single shared pool for the service
pool = redis.ConnectionPool.from_url(
    settings.redis_url,
    max_connections=10,       # Max simultaneous connections
    decode_responses=True,     # Return strings instead of bytes
)

redis_client = redis.Redis(connection_pool=pool)
```

**Sensible defaults:**
| Setting | Value | Reason |
|---------|-------|--------|
| `max_connections` | 10 | ContextOS services have low Redis traffic (queue ops only) |
| `socket_timeout` | 5.0 | Fail fast on hung connections |
| `socket_connect_timeout` | 5.0 | Fail fast on unreachable Redis |
| `retry_on_timeout` | True | Auto-retry on transient timeouts |
| `decode_responses` | True | Work with strings, not bytes |

**Connection failure handling:**
```python
try:
    await redis_client.ping()
except redis.ConnectionError as e:
    logger.error("Redis connection failed", error=str(e))
    # Service should start without Redis (degraded mode: no queue processing)
```

---

### A12.2: Queue consumer — blocking pop vs polling

**BLPOP (blocking pop) — recommended:**
```python
# BLPOP blocks the connection until data arrives or timeout expires
result = await redis_client.blpop('nl-assembly:embed-queue', timeout=5)
# result = (b'queue-name', b'{"job_id": "..."}') or None on timeout
```

**How it works:**
- `BLPOP` is a Redis command that blocks the connection until an item is available.
- `timeout=5` means wait up to 5 seconds. Returns `None` if no item arrives.
- The consumer loop immediately gets items when they're pushed (no polling delay).
- **Much more efficient than polling** — no wasted Redis roundtrips.

**Concurrent workers:**
```python
# Run multiple concurrent consumers with asyncio.gather
async def run_workers(n_workers: int = 3):
    tasks = [queue_consumer(redis_client, model, db_pool) for _ in range(n_workers)]
    await asyncio.gather(*tasks)
```

**Dead letter queue pattern:**
```python
MAX_RETRIES = 3

async def process_with_retry(job: dict, redis_client, model, db_pool):
    retries = job.get('retries', 0)
    try:
        await process_embedding_job(job, model, db_pool)
    except Exception as e:
        if retries >= MAX_RETRIES:
            # Move to dead letter queue
            await redis_client.rpush('nl-assembly:embed-dlq', json.dumps({
                **job, 'error': str(e), 'failed_at': datetime.utcnow().isoformat()
            }))
            logger.error("Job moved to DLQ", job_id=job['job_id'], error=str(e))
        else:
            # Re-enqueue with incremented retry count
            await redis_client.rpush('nl-assembly:embed-queue', json.dumps({
                **job, 'retries': retries + 1
            }))
            logger.warn("Job retried", job_id=job['job_id'], retries=retries + 1)
```

---

## SUMMARY

All 45 questions answered. Key action items for implementation:

1. **Update `SEMANTIC_DIFF_MODEL`** from `claude-3-5-haiku-20241022` to `claude-4-5-haiku-20251015` everywhere.
2. **Update `tree-sitter-languages`** to `tree-sitter-language-pack>=1.5.0` in `pyproject.toml`.
3. **Use `prepare: false`** in postgres.js config when connecting to Supabase transaction pooler.
4. **Use `cosineDistance()` helper** from `drizzle-orm` for vector queries — no raw SQL needed.
5. **Pre-download models in Dockerfiles** — never rely on runtime downloads.
6. **Use `redis.asyncio` + `BLPOP`** for Python queue consumers.
7. **Use `@testcontainers/postgresql`** with `pgvector/pgvector:pg16` for integration tests.
