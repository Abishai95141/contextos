# ── Stage 1: Base image ──────────────────────────────────────────────────────
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# ── Stage 2: Dependency installation ─────────────────────────────────────────
FROM base AS deps

COPY pyproject.toml ./

# tree-sitter-languages compiles native extensions — needs gcc at install time
RUN uv pip install --system --no-cache -r pyproject.toml

# ── Stage 3: Development target ───────────────────────────────────────────────
FROM deps AS development

RUN uv pip install --system --no-cache pytest pytest-asyncio pytest-cov

COPY . .

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3201", "--reload"]

# ── Stage 4: Production runner ────────────────────────────────────────────────
FROM deps AS runner

# Drop build tools not needed at runtime
RUN apt-get purge -y --auto-remove build-essential git

RUN groupadd -r app && useradd -r -g app app

COPY src/ ./src/

USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 3201

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3201/health || exit 1

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3201", "--workers", "2"]
