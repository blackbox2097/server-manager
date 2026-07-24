# automation.py -- proverava i pokrece automatizovana pravila (trigger-based
# izvrsavanje skripti). Kacena na iste tacke gde se salju email notifikacije
# (monitor.py za status/metrike, executor.py/scheduler.py za neuspeh skripti).
#
# Pravilo se NIKAD ne trigeruje samo sobom -- exec_failed/scheduled_exec_failed
# provera se preskace za izvrsavanja koja je pokrenula sama automatizacija
# (trigger_source == "automation"), da se izbegne beskonacna petlja.

import logging
from datetime import datetime, timezone, timedelta
from app.database import fetch, fetchrow, execute

logger = logging.getLogger(__name__)


async def _cooldown_ok(rule_id: str, server_id: str, cooldown_minutes: int) -> bool:
    row = await fetchrow(
        "SELECT last_run_at FROM automation_last_run WHERE rule_id=$1 AND server_id=$2",
        rule_id, server_id
    )
    if not row:
        return True
    elapsed = datetime.now(timezone.utc) - row["last_run_at"]
    return elapsed >= timedelta(minutes=cooldown_minutes)


async def _mark_run(rule_id: str, server_id: str):
    await execute(
        """INSERT INTO automation_last_run (rule_id, server_id, last_run_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (rule_id, server_id) DO UPDATE SET last_run_at=NOW()""",
        rule_id, server_id
    )


async def _fire_rule(rule: dict, server: dict):
    """Pokrece skriptu vezanu za pravilo preko istog executor.run() mehanizma
    koji koristi rucno/zakazano izvrsavanje (isti SSH/WinRM auto-fallback put)."""
    from app.services.executor import run as executor_run

    script = await fetchrow("SELECT name, content FROM scripts WHERE id=$1", rule["script_id"])
    if not script:
        logger.warning(f"Automatizacija: skripta {rule['script_id']} ne postoji vise, "
                        f"pravilo '{rule['name']}' preskoceno")
        return

    try:
        await executor_run(
            tenant_id            = str(rule["tenant_id"]),
            server_ids           = [str(server["id"])],
            content              = script["content"],
            script_name          = f"[Automatizacija] {script['name']}",
            script_id            = str(rule["script_id"]),
            started_by           = str(rule["operator_id"]),
            started_by_username  = f"automatizacija: {rule['name']}",
            notify               = False,
            rule_id              = str(rule["id"]),
            trigger_source       = "automation",
        )
    except Exception as e:
        logger.warning(f"Automatizacija pravilo '{rule['name']}' nije uspela da pokrene "
                        f"skriptu na {server.get('name')}: {e}")
        return

    await _mark_run(str(rule["id"]), str(server["id"]))


async def _fire_matching_rules(rules: list, server: dict):
    for rule in rules:
        rule = dict(rule)
        if await _cooldown_ok(str(rule["id"]), str(server["id"]), rule["cooldown_minutes"]):
            await _fire_rule(rule, server)


async def check_status_trigger(server: dict, trigger_type: str):
    """trigger_type: 'offline' ili 'recovery'."""
    rules = await fetch(
        """SELECT * FROM automation_rules
           WHERE enabled=true AND trigger_type=$1 AND tenant_id=$2
             AND (server_id IS NULL OR server_id=$3)""",
        trigger_type, server["tenant_id"], server["id"]
    )
    if rules:
        await _fire_matching_rules(rules, server)


async def check_metric_triggers(server: dict, metrics: dict):
    """Proverava cpu_high / ram_high / disk_high -- nezavisno od status debounce-a,
    svaki poll ciklus, sa pragom koji se bira po pravilu."""
    checks = [
        ("cpu_high",  metrics.get("cpuPercent")),
        ("ram_high",  metrics.get("ramPercent")),
        ("disk_high", metrics.get("diskPercent")),
    ]
    for trigger_type, value in checks:
        if value is None:
            continue
        rules = await fetch(
            """SELECT * FROM automation_rules
               WHERE enabled=true AND trigger_type=$1 AND tenant_id=$2
                 AND (server_id IS NULL OR server_id=$3)
                 AND threshold_percent IS NOT NULL AND $4 >= threshold_percent""",
            trigger_type, server["tenant_id"], server["id"], value
        )
        if rules:
            await _fire_matching_rules(rules, server)


async def check_exec_failed_trigger(tenant_id: str, server_id: str, trigger_type: str):
    """trigger_type: 'exec_failed' ili 'scheduled_exec_failed'.
    Poziva se SAMO za trigger_source in ('manual','scheduled') -- automatizacija
    sebe ne trigeruje (vidi executor.py hook)."""
    rules = await fetch(
        """SELECT * FROM automation_rules
           WHERE enabled=true AND trigger_type=$1 AND tenant_id=$2
             AND (server_id IS NULL OR server_id=$3)""",
        trigger_type, tenant_id, server_id
    )
    if not rules:
        return
    server = await fetchrow("SELECT * FROM servers WHERE id=$1", server_id)
    if not server:
        return
    await _fire_matching_rules(rules, dict(server))
