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
# Paramiko na INFO nivou loguje svaku SSH konekciju/autentifikaciju/sftp
# sesiju -- sa vise desetina servera na 30s poll intervalu ovo generise
# ogromnu kolicinu suma i gusi stvarno korisne poruke. Nasa app i dalje
# loguje sve svoje INFO poruke normalno.
logging.getLogger("paramiko").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Server Manager pokrenut")
    # Python-ov podrazumevani thread pool (min(32, cpu_count()+4)) je premali
    # za nas obim paralelnih blokirajucih poziva (SSH/WinRM/ESXi monitoring +
    # terminal sesije + notify/backup, svi dele run_in_executor(None, ...)).
    # Eksplicitno podesi veci dedicated pool pre nego sto bilo sta krene.
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    asyncio.get_running_loop().set_default_executor(
        ThreadPoolExecutor(max_workers=cfg.executor_max_workers))
    logger.info(f"Thread pool podesen na {cfg.executor_max_workers} worker-a")
    # "Zagrej" psutil.cpu_percent -- prvi poziv sa interval=None UVEK vraca 0.0
    # (nema prethodnog uzorka za poredjenje), naredni pozivi su tacni i brzi
    # (ne blokiraju, nema sleep-a).
    import psutil
    psutil.cpu_percent(interval=None)
    await init_db()
    logger.info("Baza dostupna")
    from app.services.monitor import start
    start()
    from app.services.retention import start as start_retention
    start_retention()
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

from app.routers import auth, admin, servers, monitoring, operations, terminal, schedules, alerts, logs, backup, automation, dashboard
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(servers.router)
app.include_router(monitoring.router)
app.include_router(operations.router)
app.include_router(terminal.router)
app.include_router(schedules.router)
app.include_router(alerts.router)
app.include_router(logs.router)
app.include_router(backup.router)
app.include_router(automation.router)
app.include_router(dashboard.router)


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
