# app/services/notify.py
import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.database import fetchrow, fetch, execute
from app.services.crypto import encrypt, decrypt

logger = logging.getLogger(__name__)


async def get_smtp_config() -> dict | None:
    row = await fetchrow("SELECT * FROM smtp_settings WHERE id = 1")
    if not row or not row["configured"]:
        return None
    cfg = dict(row)
    if cfg.get("password_enc"):
        cfg["password"] = decrypt(cfg["password_enc"])
    return cfg


def _send_sync(cfg: dict, to: list[str], subject: str, html_body: str):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f'{cfg["from_name"]} <{cfg["from_email"]}>'
    msg["To"] = ", ".join(to)
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    if cfg["port"] == 465:
        server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15)
    else:
        server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=15)
        if cfg.get("use_tls"):
            server.starttls()

    try:
        if cfg.get("username"):
            server.login(cfg["username"], cfg.get("password") or "")
        server.sendmail(cfg["from_email"], to, msg.as_string())
    finally:
        server.quit()


async def send_email(to: list[str], subject: str, html_body: str) -> bool:
    if not to:
        return False
    cfg = await get_smtp_config()
    if not cfg:
        logger.warning("SMTP nije konfigurisan — email nije poslat")
        return False
    try:
        await asyncio.get_event_loop().run_in_executor(None, _send_sync, cfg, to, subject, html_body)
        logger.info(f"Email poslat: '{subject}' -> {', '.join(to)}")
        return True
    except Exception as e:
        logger.error(f"Slanje email-a nije uspelo: {e}")
        return False


async def get_recipients(tenant_id: str) -> list[str]:
    rows = await fetch(
        "SELECT email FROM alert_recipients WHERE tenant_id=$1 AND active=true", tenant_id
    )
    return [r["email"] for r in rows]


def _status_label(s: str) -> str:
    return {"online": "ONLINE", "offline": "OFFLINE", "warning": "UPOZORENJE", "unknown": "NEPOZNATO"}.get(s, s)


async def notify_server_status(server: dict, old_status: str, new_status: str):
    """Poziva se iz monitor.py pri promeni statusa servera."""
    if old_status == new_status:
        return

    tenant = await fetchrow(
        "SELECT alerts_enabled, alert_on_offline, alert_on_recovery, alert_on_warning FROM tenants WHERE id=$1",
        server["tenant_id"]
    )
    if not tenant or not tenant["alerts_enabled"]:
        return

    is_recovery = old_status == "offline" and new_status in ("online", "warning")
    is_offline  = new_status == "offline"
    is_warning  = new_status == "warning" and old_status not in ("offline",)

    should_send = (
        (is_offline  and tenant["alert_on_offline"]) or
        (is_recovery and tenant["alert_on_recovery"]) or
        (is_warning  and tenant["alert_on_warning"])
    )
    if not should_send:
        return

    recipients = await get_recipients(str(server["tenant_id"]))
    if not recipients:
        return

    kind = "OFFLINE" if is_offline else ("OPORAVAK" if is_recovery else "UPOZORENJE")
    color = "#ef4444" if is_offline else ("#22c55e" if is_recovery else "#eab308")

    subject = f"[Server Manager] {kind}: {server['name']}"
    body = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 500px;">
      <h2 style="color:{color};">{kind}: {server['name']}</h2>
      <p><strong>Server:</strong> {server['name']} ({server['ip_address']})</p>
      <p><strong>Status:</strong> {_status_label(old_status)} → {_status_label(new_status)}</p>
      {f"<p><strong>Greška:</strong> {server.get('last_error', '')[:300]}</p>" if is_offline and server.get('last_error') else ""}
      <p style="color:#888; font-size:12px; margin-top:20px;">Server Manager — automatska obavest</p>
    </div>
    """
    asyncio.create_task(send_email(recipients, subject, body))


async def notify_execution(execution_id: str):
    """Poziva se nakon svakog zavrsenog izvrsavanja skripte (rucnog ili zakazanog)."""
    exec_row = await fetchrow("SELECT * FROM executions WHERE id=$1", execution_id)
    if not exec_row:
        return

    tenant = await fetchrow(
        """SELECT alerts_enabled, alert_on_execution_failure, alert_on_execution_report
           FROM tenants WHERE id=$1""",
        exec_row["tenant_id"]
    )
    if not tenant or not tenant["alerts_enabled"]:
        return

    has_failures = exec_row["error_count"] > 0
    should_send = (
        (has_failures and tenant["alert_on_execution_failure"]) or
        tenant["alert_on_execution_report"]
    )
    if not should_send:
        return

    recipients = await get_recipients(str(exec_row["tenant_id"]))
    if not recipients:
        return

    await _send_execution_email(exec_row, recipients)


async def send_execution_report(execution_id: str, tenant_id: str, override_recipients: list[str] | None = None):
    """Rucno pokrenuto slanje izvestaja (dugme u UI) — zaobilazi tenant toggle podesavanja."""
    exec_row = await fetchrow("SELECT * FROM executions WHERE id=$1 AND tenant_id=$2", execution_id, tenant_id)
    if not exec_row:
        raise ValueError("Execution nije pronadjen")

    recipients = override_recipients or await get_recipients(tenant_id)
    if not recipients:
        raise ValueError("Nema definisanih primalaca za ovaj tenant")

    await _send_execution_email(exec_row, recipients)


async def _send_execution_email(exec_row, recipients: list[str]):
    results = await fetch(
        "SELECT server_name, status, exit_code, duration_ms FROM execution_results WHERE execution_id=$1 ORDER BY server_name",
        exec_row["id"]
    )
    status_color = "#22c55e" if exec_row["status"] == "done" and exec_row["error_count"] == 0 else \
                   ("#eab308" if exec_row["error_count"] > 0 and exec_row["success_count"] > 0 else "#ef4444")

    rows_html = "".join(
        f"""<tr>
              <td style="padding:4px 8px; border-bottom:1px solid #333;">{r['server_name']}</td>
              <td style="padding:4px 8px; border-bottom:1px solid #333; color:{'#22c55e' if r['status']=='success' else '#ef4444'};">{r['status']}</td>
              <td style="padding:4px 8px; border-bottom:1px solid #333;">{r['exit_code']}</td>
              <td style="padding:4px 8px; border-bottom:1px solid #333;">{r['duration_ms'] or 0}ms</td>
            </tr>"""
        for r in results
    )

    subject = f"[Server Manager] Izveštaj: {exec_row['script_name']} ({exec_row['success_count']}✓ {exec_row['error_count']}✗)"
    body = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 600px;">
      <h2 style="color:{status_color};">Izveštaj izvršavanja: {exec_row['script_name']}</h2>
      <p><strong>Status:</strong> {exec_row['status']} | <strong>Uspešno:</strong> {exec_row['success_count']} |
         <strong>Greške:</strong> {exec_row['error_count']} | <strong>Ukupno servera:</strong> {exec_row['server_count']}</p>
      <table style="border-collapse:collapse; width:100%; font-size:13px; margin-top:12px;">
        <thead>
          <tr style="text-align:left; color:#888;">
            <th style="padding:4px 8px;">Server</th><th style="padding:4px 8px;">Status</th>
            <th style="padding:4px 8px;">Exit kod</th><th style="padding:4px 8px;">Trajanje</th>
          </tr>
        </thead>
        <tbody>{rows_html}</tbody>
      </table>
      <p style="color:#888; font-size:12px; margin-top:20px;">Server Manager — automatski izveštaj</p>
    </div>
    """
    await send_email(recipients, subject, body)
