"""Async PostgreSQL pool lifecycle helpers."""

from __future__ import annotations

import asyncio
import os
import ssl
from urllib.parse import quote

import asyncpg

_POOL: asyncpg.Pool | None = None
_POOL_LOCK = asyncio.Lock()
_PASSWORD_PLACEHOLDERS = ("[YOUR-PASSWORD]", "<YOUR-PASSWORD>", "YOUR-PASSWORD")


class DBConfigError(RuntimeError):
    """Raised when required DB configuration is missing or invalid."""


def _parse_bool(raw_value: str | None, *, default: bool) -> bool:
    if raw_value is None:
        return default
    value = raw_value.strip().lower()
    if value in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise DBConfigError(
        f"Invalid boolean value '{raw_value}' for DB_SSL. "
        "Use true/false."
    )


def _resolve_database_url() -> str:
    raw_url = os.getenv("DATABASE_URL", "").strip()
    password = os.getenv("SUPABASE_PASSWORD", "").strip()

    if raw_url:
        if any(token in raw_url for token in _PASSWORD_PLACEHOLDERS):
            if not password:
                raise DBConfigError(
                    "DATABASE_URL contains a password placeholder but "
                    "SUPABASE_PASSWORD is not set."
                )
            encoded_password = quote(password, safe="")
            for token in _PASSWORD_PLACEHOLDERS:
                raw_url = raw_url.replace(token, encoded_password)
        return raw_url

    required = {
        "DB_HOST": os.getenv("DB_HOST", "").strip(),
        "DB_PORT": os.getenv("DB_PORT", "").strip(),
        "DB_NAME": os.getenv("DB_NAME", "").strip(),
        "DB_USER": os.getenv("DB_USER", "").strip(),
        "SUPABASE_PASSWORD": password,
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        missing_str = ", ".join(missing)
        raise DBConfigError(
            "Missing required DB configuration. "
            f"Set DATABASE_URL or all of: {missing_str}."
        )

    try:
        port = int(required["DB_PORT"])
    except ValueError as exc:
        raise DBConfigError("DB_PORT must be a valid integer.") from exc

    user = quote(required["DB_USER"], safe="")
    encoded_password = quote(required["SUPABASE_PASSWORD"], safe="")
    db_name = quote(required["DB_NAME"], safe="")
    host = required["DB_HOST"]
    return f"postgresql://{user}:{encoded_password}@{host}:{port}/{db_name}"


def _build_ssl_context() -> ssl.SSLContext | None:
    enabled = _parse_bool(os.getenv("DB_SSL"), default=True)
    if not enabled:
        return None
    return ssl.create_default_context()


def _statement_cache_size() -> int:
    pool_mode = os.getenv("DB_POOL_MODE", "transaction").strip().lower()
    if pool_mode == "transaction":
        return 0
    return 100


async def init_db_pool() -> asyncpg.Pool:
    """Initialize and return the singleton DB pool."""
    global _POOL
    if _POOL is not None:
        return _POOL

    async with _POOL_LOCK:
        if _POOL is not None:
            return _POOL

        dsn = _resolve_database_url()
        _POOL = await asyncpg.create_pool(
            dsn=dsn,
            min_size=1,
            max_size=10,
            ssl=_build_ssl_context(),
            statement_cache_size=_statement_cache_size(),
        )
        return _POOL


async def get_db_pool() -> asyncpg.Pool:
    """Return the initialized DB pool."""
    if _POOL is None:
        raise RuntimeError(
            "DB pool is not initialized. Call init_db_pool() during app startup."
        )
    return _POOL


async def close_db_pool() -> None:
    """Close the singleton DB pool."""
    global _POOL
    if _POOL is None:
        return

    async with _POOL_LOCK:
        if _POOL is None:
            return
        pool = _POOL
        _POOL = None
        await pool.close()


async def ping_db() -> None:
    """Run a basic connectivity check against the DB."""
    pool = await get_db_pool()
    async with pool.acquire() as connection:
        result = await connection.fetchval("SELECT 1")
    if result != 1:
        raise RuntimeError("Database ping failed: SELECT 1 did not return 1.")
