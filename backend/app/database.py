# app/database.py
import asyncpg
import logging
from app.config import get_settings

logger = logging.getLogger(__name__)
_pool: asyncpg.Pool | None = None


async def _init_conn(conn):
    # inet/cidr -> string automatski, nema vise TypeError u SSH konekciji
    await conn.set_type_codec("inet", encoder=str, decoder=str, schema="pg_catalog", format="text")
    await conn.set_type_codec("cidr", encoder=str, decoder=str, schema="pg_catalog", format="text")


async def init_db():
    global _pool
    cfg = get_settings()
    _pool = await asyncpg.create_pool(
        host=cfg.db_host, port=cfg.db_port,
        database=cfg.db_name, user=cfg.db_user, password=cfg.db_pass,
        min_size=2, max_size=10, command_timeout=30,
        init=_init_conn,
    )
    logger.info("PostgreSQL pool kreiran")


async def close_db():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Baza nije inicijalizovana")
    return _pool


async def fetch(q, *a):
    return await (await get_pool()).fetch(q, *a)

async def fetchrow(q, *a):
    return await (await get_pool()).fetchrow(q, *a)

async def fetchval(q, *a):
    return await (await get_pool()).fetchval(q, *a)

async def execute(q, *a):
    return await (await get_pool()).execute(q, *a)
