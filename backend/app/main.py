# app/main.py
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import init_db, close_db

cfg = get_settings()

logging.basicConfig(
    level=logging.DEBUG if cfg.node_env != "production" else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Server Manager pokrenut")
    await init_db()
    logger.info("Baza dostupna")
    from app.services.monitor import start
    start()
    from app.services.scheduler import load_all_jobs
    await load_all_jobs()
    yield
    from app.services.monitor import scheduler
    if scheduler.running:
        scheduler.shutdown(wait=False)
    await close_db()
    logger.info("Server ugasen")


app = FastAPI(
    title="Server Manager", version="2.0.0",
    docs_url="/api/docs", redoc_url=None,
    lifespan=lifespan,
)

if cfg.node_env != "production":
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

from app.routers import auth, admin, servers, monitoring, operations, terminal, schedules
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(servers.router)
app.include_router(monitoring.router)
app.include_router(operations.router)
app.include_router(terminal.router)
app.include_router(schedules.router)


@app.get("/health")
async def health():
    from app.database import fetchval
    return {"status": "ok", "db": str(await fetchval("SELECT NOW()")), "version": "2.0.0"}


FRONTEND = Path("/opt/servermanager/frontend/dist")
if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        return FileResponse(FRONTEND / "index.html")
