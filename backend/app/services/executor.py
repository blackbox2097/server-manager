# app/services/executor.py
import asyncio, logging, uuid
from app.config import get_settings
from app.database import fetch, fetchrow, execute
from app.services.crypto import decrypt
from app.services.ws_manager import ws_manager

logger = logging.getLogger(__name__)


async def _run_one(exec_id: str, server: dict, content: str, tenant_id: str) -> str:
    row = await fetchrow(
        """INSERT INTO execution_results
             (execution_id, server_id, server_name, server_ip, status, started_at)
           VALUES ($1,$2,$3,$4,'running',NOW()) RETURNING id""",
        exec_id, server["id"], server["name"], str(server["ip_address"])
    )
    rid = row["id"]
    await ws_manager.broadcast("exec_server_start",
        {"executionId": exec_id, "serverId": str(server["id"]), "serverName": server["name"]},
        tenant_id=tenant_id)

    srv = dict(server)
    if srv.get("private_key_enc"): srv["_private_key"]    = decrypt(srv["private_key_enc"])
    if srv.get("ssh_password"):    srv["_ssh_password"]   = decrypt(srv["ssh_password"])
    if srv.get("sudo_password"):   srv["_sudo_password"]  = decrypt(srv["sudo_password"])
    if srv.get("winrm_password"):  srv["_winrm_password"] = decrypt(srv["winrm_password"])

    try:
        if srv["os_type"] == "windows":
            from app.services.winrm import execute_script
        else:
            from app.services.ssh import execute_script
        result = await execute_script(srv, content)
        status = "success" if result["exitCode"] == 0 else "error"
    except Exception as e:
        result = {"exitCode": -1, "stdout": "", "stderr": str(e), "durationMs": 0}
        status = "error"

    await execute(
        """UPDATE execution_results
           SET status=$1, exit_code=$2, stdout=$3, stderr=$4, finished_at=NOW(), duration_ms=$5
           WHERE id=$6""",
        status, result["exitCode"],
        result["stdout"][:50000], result["stderr"][:10000],
        result["durationMs"], rid
    )
    await ws_manager.broadcast("exec_server_done", {
        "executionId": exec_id, "serverId": str(server["id"]),
        "serverName": server["name"], "status": status,
        "exitCode": result["exitCode"],
        "stdout": result["stdout"], "stderr": result["stderr"],
        "durationMs": result["durationMs"],
    }, tenant_id=tenant_id)
    return status


async def run(tenant_id: str, server_ids: list, content: str,
              script_name: str = "Ad-hoc", script_id=None, started_by=None,
              notify: bool = True, on_complete=None, started_by_username: str | None = None) -> str:
    cfg = get_settings()
    ph  = ", ".join(f"${i+2}" for i in range(len(server_ids)))
    servers = await fetch(
        f"""SELECT s.*, sk.private_key_enc, sk.key_file_path
            FROM servers s LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
            WHERE s.tenant_id=$1 AND s.id IN ({ph}) AND s.active=true""",
        tenant_id, *server_ids
    )
    if not servers:
        raise ValueError("Nijedan server nije dostupan")

    eid = str(uuid.uuid4())
    await execute(
        """INSERT INTO executions
             (id, tenant_id, script_id, script_name, script_content, started_by, status, server_count)
           VALUES ($1,$2,$3,$4,$5,$6,'running',$7)""",
        eid, tenant_id, script_id, script_name, content, started_by, len(servers)
    )
    await ws_manager.broadcast("exec_created",
        {"executionId": eid, "tenantId": tenant_id,
         "serverCount": len(servers), "scriptName": script_name},
        tenant_id=tenant_id)

    async def _all():
        ok = err = 0
        mp = cfg.monitor_max_parallel
        for i in range(0, len(servers), mp):
            results = await asyncio.gather(
                *[_run_one(eid, dict(s), content, tenant_id) for s in servers[i:i+mp]],
                return_exceptions=True
            )
            for r in results:
                if isinstance(r, Exception) or r == "error": err += 1
                else: ok += 1
        final = "done" if err == 0 else ("failed" if ok == 0 else "done")
        await execute(
            "UPDATE executions SET status=$1, finished_at=NOW(), success_count=$2, error_count=$3 WHERE id=$4",
            final, ok, err, eid
        )
        await ws_manager.broadcast("exec_finished",
            {"executionId": eid, "tenantId": tenant_id,
             "status": final, "successCount": ok, "errorCount": err},
            tenant_id=tenant_id)
        logger.info(f"Execution {eid}: {final} ok={ok} err={err}")

        from app.services.audit import log_event
        asyncio.create_task(log_event(
            "script.execute",
            user_id=started_by, username=started_by_username, tenant_id=tenant_id,
            resource_type="execution", resource_id=eid,
            details={
                "scriptName": script_name,
                "serverNames": [s["name"] for s in servers],
                "contentPreview": content[:200] + ("..." if len(content) > 200 else ""),
                "successCount": ok, "errorCount": err, "status": final,
            },
            success=(err == 0)
        ))

        from app.services.notify import notify_execution
        if notify:
            asyncio.create_task(notify_execution(eid))
        if on_complete:
            asyncio.create_task(on_complete(eid))

    asyncio.create_task(_all())
    return eid


async def list_execs(tenant_id: str, limit=20, offset=0) -> list:
    rows = await fetch(
        """SELECT e.id, e.script_name, e.status, e.server_count,
                  e.success_count, e.error_count, e.started_at, e.finished_at,
                  u.username AS started_by_name
           FROM executions e LEFT JOIN users u ON u.id=e.started_by
           WHERE e.tenant_id=$1 ORDER BY e.started_at DESC LIMIT $2 OFFSET $3""",
        tenant_id, min(limit, 100), offset)
    return [dict(r) for r in rows]


async def get_exec(exec_id: str, tenant_id: str) -> dict | None:
    e = await fetchrow(
        """SELECT e.*, u.username AS started_by_name
           FROM executions e LEFT JOIN users u ON u.id=e.started_by
           WHERE e.id=$1 AND e.tenant_id=$2""", exec_id, tenant_id)
    if not e:
        return None
    results = await fetch(
        "SELECT * FROM execution_results WHERE execution_id=$1 ORDER BY server_name", exec_id)
    return dict(e) | {"results": [dict(r) for r in results]}
