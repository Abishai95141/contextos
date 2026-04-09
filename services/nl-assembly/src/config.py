"""Configuration for the NL Assembly service using Pydantic Settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Server
    host: str = "0.0.0.0"
    port: int = 3200
    log_level: str = "info"

    # Database
    database_url: str = "postgresql://contextos:contextos_dev@localhost:5432/contextos"

    # Embedding model
    embedding_model: str = "all-MiniLM-L6-v2"

    # pgvector
    vector_dimensions: int = 384  # all-MiniLM-L6-v2 produces 384-dim embeddings

    # Search defaults
    search_top_k: int = 10
    similarity_threshold: float = 0.6


_settings: Settings | None = None


def get_settings() -> Settings:
    """Return cached singleton settings."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
