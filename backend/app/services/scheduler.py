# app/services/scheduler.py
# Zakazano izvrsavanje skripti — koristi isti APScheduler kao monitoring

import logging
from apscheduler.triggers.cron import CronTrigger
from apscheduler.jobstores.base import JobLookupError

from app.database import fetch, fetchrow, execute
from app.services.monitor import scheduler  # deljeni APScheduler iz monitor.py
from app.services.executor import run as executor_run

logger = logging.getLogger(__name__)


def _job_id(scheduled_job_id: str) -> str:
    return f"sched_{scheduled_job_id}"


async def _notify_after_completion(exec_id: str, tenant_id: str, notify_on_failure: bool, notify_always: bool):
    from app.services.notify import notify_scheduled_execution
    await notify_scheduled_execution(exec_id, tenant_id, notify_on_failure, notify_always)


async def _run_scheduled_job(job_id: str):
    """Poziva se od strane APScheduler-a u zakazano vreme."""
    row = await fetchrow(
        """SELECT sj.*, u.username AS creator_username
           FROM scheduled_jobs sj LEFT JOIN users u ON u.id = sj.created_by
           WHERE sj.id=$1 AND sj.active=true""", job_id)
    if not row:
        logger.warning(f"Zakazani posao {job_id} nije pronadjen ili je neaktivan — preskacem")
        return

    script = await fetchrow("SELECT name, content FROM scripts WHERE id=$1", row["script_id"])
    if not script:
        logger.warning(f"Skripta za zakazani posao {job_id} ne postoji vise")
        return

    try:
        tenant_id = str(row["tenant_id"])

        async def _on_complete(exec_id: str):
            await _notify_after_completion(exec_id, tenant_id, row["notify_on_failure"], row["notify_always"])

        exec_id = await executor_run(
            tenant_id      = tenant_id,
            server_ids     = [str(s) for s in row["server_ids"]],
            content        = script["content"],
            script_name    = f"[Zakazano] {script['name']}",
            script_id      = str(row["script_id"]),
            started_by     = str(row["created_by"]) if row["created_by"] else None,
            started_by_username = row["creator_username"],
            notify         = False,  # zakazani poslovi imaju sopstvenu notify logiku (on_complete)
            on_complete    = _on_complete,
        )
        await execute(
            "UPDATE scheduled_jobs SET last_run_at=NOW(), last_execution_id=$1 WHERE id=$2",
            exec_id, job_id
        )
        logger.info(f"Zakazani posao pokrenut: {row['name']} ({job_id}) -> execution {exec_id}")
    except Exception as e:
        logger.error(f"Zakazani posao {job_id} nije uspeo da se pokrene: {e}")


def register_job(job: dict):
    """Registruj/azuriraj posao u APScheduler-u na osnovu cron izraza."""
    try:
        trigger = CronTrigger.from_crontab(job["cron_expression"])
    except ValueError as e:
        raise ValueError(f"Neispravan cron izraz: {e}")

    scheduler.add_job(
        _run_scheduled_job,
        trigger=trigger,
        args=[str(job["id"])],
        id=_job_id(str(job["id"])),
        replace_existing=True,
        misfire_grace_time=300,
    )


def unregister_job(scheduled_job_id: str):
    try:
        scheduler.remove_job(_job_id(scheduled_job_id))
    except JobLookupError:
        pass


def get_next_run(scheduled_job_id: str):
    j = scheduler.get_job(_job_id(scheduled_job_id))
    return j.next_run_time if j else None


async def load_all_jobs():
    """Pozvati pri startu aplikacije — registruje sve aktivne zakazane poslove."""
    rows = await fetch("SELECT * FROM scheduled_jobs WHERE active=true")
    count = 0
    for row in rows:
        try:
            register_job(dict(row))
            count += 1
        except Exception as e:
            logger.error(f"Ne mogu da registrujem zakazani posao {row['id']}: {e}")
    logger.info(f"Zakazani poslovi ucitani: {count}")
