"""Configuration for the Semantic Diff service."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Server
    host: str = "0.0.0.0"
    port: int = 3201
    log_level: str = "info"

    # Anthropic
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-5-haiku-20241022"
    anthropic_max_tokens: int = 2048

    # Analysis limits
    max_diff_bytes: int = 512_000  # 512 KB — refuse larger diffs
    max_files_per_diff: int = 200

    # Tree-sitter supported languages
    supported_languages: list[str] = [
        "python",
        "typescript",
        "tsx",
        "javascript",
        "jsx",
        "rust",
        "go",
        "java",
        "c",
        "cpp",
    ]


_settings: Settings | None = None


def get_settings() -> Settings:
    """Return cached singleton settings."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
