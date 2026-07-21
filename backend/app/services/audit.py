# app/services/audit.py
# Centralni servis za upisivanje dogadjaja u audit_log tabelu.
# Koristi se iz svih ruta i servisa koji treba da ostave trag.

import json
import logging
from app.database import execute

logger = logging.getLogger(__name__)


async def log_event(
    action: str,
    user_id: str | None = None,
    username: str | None = None,
    tenant_id: str | None = None,
    ip_address: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: dict | None = None,
    success: bool = True,
    error_message: str | None = None,
):
    """Upisuje jedan dogadjaj u audit_log. Nikad ne baca izuzetak — logovanje
    ne sme da obori glavnu operaciju ako iz nekog razloga upis ne uspe."""
    try:
        await execute(
            """INSERT INTO audit_log
                 (user_id, username, tenant_id, ip_address, action,
                  resource_type, resource_id, details, success, error_message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)""",
            user_id, username, tenant_id, ip_address, action,
            resource_type, resource_id,
            details,
            success, error_message,
        )
    except Exception as e:
        logger.error(f"Upis u audit_log nije uspeo (action={action}): {e}")


async def cleanup_old_logs():
    from app.config import get_settings
    cfg = get_settings()
    r1 = await execute(f"DELETE FROM audit_log WHERE occurred_at < NOW() - INTERVAL '{cfg.log_retention_days} days'")
    r2 = await execute(f"DELETE FROM executions WHERE started_at < NOW() - INTERVAL '{cfg.log_retention_days} days'")
    logger.info(f"Logovi ociscen: audit_log={r1}, executions={r2}")
