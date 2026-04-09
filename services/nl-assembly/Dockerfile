# ── Stage 1: Base image ──────────────────────────────────────────────────────
FROM python:3.12-slim AS base

# Install system dependencies for sentence-transformers / asyncpg
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# ── Stage 2: Dependency installation ─────────────────────────────────────────
FROM base AS deps

# Copy dependency manifests first for better layer caching
COPY pyproject.toml ./

# Install dependencies into the system Python (no virtualenv in container)
RUN uv pip install --system --no-cache -r pyproject.toml

# ── Stage 3: Development target (with dev deps) ───────────────────────────────
FROM deps AS development

RUN uv pip install --system --no-cache pytest pytest-asyncio pytest-cov

COPY . .

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3200", "--reload"]

# ── Stage 4: Production runner ────────────────────────────────────────────────
FROM deps AS runner

# Create non-root user
RUN groupadd -r app && useradd -r -g app app

# Copy application source
COPY src/ ./src/

# Pre-download the embedding model so the container starts without network access
# (model is cached to /root/.cache/huggingface which we copy to the app user's home)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
RUN cp -r /root/.cache /home/app/.cache && chown -R app:app /home/app/.cache

USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3200/health || exit 1

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3200", "--workers", "2"]
