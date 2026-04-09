"""ContextOS Semantic Diff Service — FastAPI application entry point.

Provides two endpoints:
  GET  /health   — liveness probe
  POST /analyze  — semantic diff analysis using tree-sitter + Anthropic
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .analyzer import DiffAnalyzer
from .config import get_settings
from .models import AnalyzeRequest, AnalyzeResponse, HealthResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------

_analyzer: DiffAnalyzer | None = None

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Initialise the analyser on startup."""
    global _analyzer
    settings = get_settings()
    logger.info("Starting Semantic Diff service (model=%s)", settings.anthropic_model)
    _analyzer = DiffAnalyzer(settings)
    logger.info("Semantic Diff service ready")
    yield
    logger.info("Shutting down Semantic Diff service")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ContextOS Semantic Diff",
    description="AST-aware semantic diff analysis powered by tree-sitter and Anthropic Claude",
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
    """Return service health status."""
    settings = get_settings()
    return HealthResponse(
        status="ok",
        model=settings.anthropic_model,
        version="0.1.0",
    )


@app.post("/analyze", response_model=AnalyzeResponse, tags=["analysis"])
async def analyze(body: AnalyzeRequest) -> AnalyzeResponse:
    """Analyse a set of file diffs semantically.

    - Parses each file with tree-sitter to extract symbol-level changes.
    - Calls Anthropic Claude to produce a high-level semantic summary.
    - Returns a structured :class:`AnalyzeResponse` with per-file summaries
      and an aggregate semantic analysis.

    When `ANTHROPIC_API_KEY` is not set, the service returns a stub analysis
    based on AST-only information.
    """
    if _analyzer is None:
        raise HTTPException(status_code=503, detail="Analyzer not initialised")

    settings = get_settings()

    # Reject payloads that exceed size limits
    total_bytes = sum(
        len((f.old_content or "").encode()) + len((f.new_content or "").encode()) for f in body.files
    )
    if total_bytes > settings.max_diff_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Diff exceeds maximum size of {settings.max_diff_bytes} bytes ({total_bytes} received)",
        )

    if len(body.files) > settings.max_files_per_diff:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files ({len(body.files)}). Maximum is {settings.max_files_per_diff}.",
        )

    try:
        return await _analyzer.analyze(body)
    except Exception as exc:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Entry point
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
