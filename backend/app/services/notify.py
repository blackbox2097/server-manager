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
async def send_digest_emails():
    """Periodicni posao (APScheduler, svakih notification_digest_interval_sec)
    -- sakuplja sve pending_notifications redove PO TENANTU i salje JEDAN
    zbirni email po tenantu, umesto pojedinacnog mejla po dogadjaju. Resava
    "alert storm" problem (masovni istovremeni pad vise uredjaja -> bujica
    pojedinacnih mejlova)."""
    tenant_rows = await fetch("SELECT DISTINCT tenant_id FROM pending_notifications")
    for trow in tenant_rows:
        tenant_id = str(trow["tenant_id"])
        items = await fetch(
            "SELECT * FROM pending_notifications WHERE tenant_id=$1 ORDER BY occurred_at", tenant_id)
        if not items:
            continue
        ids = [i["id"] for i in items]
        recipients = await get_recipients(tenant_id)
        if not recipients:
            await execute("DELETE FROM pending_notifications WHERE id = ANY($1::bigint[])", ids)
            continue
        by_resource, order = {}, []
        for it in items:
            key = (it["resource_type"], str(it["resource_id"]))
            if key not in by_resource:
                by_resource[key] = []
                order.append(key)
            by_resource[key].append(it)
        offline_lines, warning_lines, recovery_lines = [], [], []
        for key in order:
            events = by_resource[key]
            last = events[-1]
            chain = [events[0]["old_status"]] + [e["new_status"] for e in events]
            dedup_chain = [chain[0]]
            for s in chain[1:]:
                if s != dedup_chain[-1]:
                    dedup_chain.append(s)
            flap_suffix = f" ({len(events)} promene)" if len(events) > 1 else ""
            chain_str = (" → ".join(_status_label(s) for s in dedup_chain)
                         if len(events) > 1 else _status_label(last["new_status"]))
            metrics_parts = []
            for label, field in (("CPU", "cpu_percent"), ("RAM", "ram_percent"), ("Disk", "disk_percent")):
                val = last[field]
                if val is None:
                    continue
                is_high = float(val) >= 90
                style = "color:#ef4444; font-weight:600;" if is_high else "color:#374151;"
                marker = " (prag prekoracen)" if is_high else ""
                metrics_parts.append(f'<span style="{style}">{label}: {round(float(val))}%{marker}</span>')
            metrics_html = (f'<div style="margin-top:2px; font-size:13px;">{" &nbsp;|&nbsp; ".join(metrics_parts)}</div>'
                             if metrics_parts else "")
            error_html = (f'<div style="color:#888; font-size:12px; margin-top:2px;">Greška: {last["error_message"]}</div>'
                          if last["error_message"] else "")
            line = f"""
                <div style="padding:8px 0; border-bottom:1px solid #eee;">
                  <strong>{last["resource_name"]}</strong>{flap_suffix} — {chain_str}
                  {metrics_html}
                  {error_html}
                </div>"""
            if last["new_status"] == "offline":
                offline_lines.append(line)
            elif last["new_status"] == "warning":
                warning_lines.append(line)
            elif last["new_status"] == "online":
                recovery_lines.append(line)
        if not (offline_lines or warning_lines or recovery_lines):
            await execute("DELETE FROM pending_notifications WHERE id = ANY($1::bigint[])", ids)
            continue
        subject_parts = []
        if offline_lines: subject_parts.append(f"{len(offline_lines)} offline")
        if warning_lines: subject_parts.append(f"{len(warning_lines)} upozorenja")
        if recovery_lines: subject_parts.append(f"{len(recovery_lines)} oporavka")
        subject = f"[Server Manager] Sažetak: {' · '.join(subject_parts)}"
        summary_bits = []
        if offline_lines:
            summary_bits.append(f'<span style="color:#ef4444; font-weight:600;">{len(offline_lines)} offline</span>')
        if warning_lines:
            summary_bits.append(f'<span style="color:#eab308; font-weight:600;">{len(warning_lines)} upozorenja</span>')
        if recovery_lines:
            summary_bits.append(f'<span style="color:#22c55e; font-weight:600;">{len(recovery_lines)} oporavka</span>')
        summary_html = f'<p style="font-size:14px;">{" &nbsp;·&nbsp; ".join(summary_bits)}</p>'
        sections_html = ""
        if offline_lines:
            sections_html += f'<h3 style="color:#ef4444; margin-bottom:4px;">Offline</h3>{"".join(offline_lines)}'
        if warning_lines:
            sections_html += f'<h3 style="color:#eab308; margin-bottom:4px;">Upozorenje</h3>{"".join(warning_lines)}'
        if recovery_lines:
            sections_html += f'<h3 style="color:#22c55e; margin-bottom:4px;">Oporavak</h3>{"".join(recovery_lines)}'
        body = f"""
        <div style="font-family: -apple-system, sans-serif; max-width: 560px;">
          <h2 style="color:#374151;">Sažetak promena statusa</h2>
          {summary_html}
          {sections_html}
          <p style="color:#888; font-size:12px; margin-top:20px;">Server Manager — automatska obavest (periodicni sažetak)</p>
        </div>
        """
        await send_email(recipients, subject, body)
        await execute("DELETE FROM pending_notifications WHERE id = ANY($1::bigint[])", ids)
def start():
    """Registruje periodicni digest posao -- poziva se iz main.py lifespan-a,
    isti obrazac kao monitor.start()/retention.start()/snmp.start()."""
    from app.services.monitor import scheduler
    from app.config import get_settings
    cfg = get_settings()
    scheduler.add_job(
        send_digest_emails, "interval",
        seconds=cfg.notification_digest_interval_sec, id="notify_digest",
    )
    logger.info(f"Notifikacioni digest pokrenut (interval: {cfg.notification_digest_interval_sec}s)")


def _status_label(s: str) -> str:
    return {"online": "ONLINE", "offline": "OFFLINE", "warning": "UPOZORENJE", "unknown": "NEPOZNATO"}.get(s, s)


async def notify_server_status(server: dict, old_status: str, new_status: str, metrics: dict | None = None):
    """Poziva se iz monitor.py pri promeni statusa servera."""
    if old_status == new_status:
        return

    tenant = await fetchrow(
        "SELECT alerts_enabled, alert_on_offline, alert_on_recovery, alert_on_warning FROM tenants WHERE id=$1",
        server["tenant_id"]
    )
    if not tenant or not tenant["alerts_enabled"]:
        return

    is_recovery = new_status == "online" and old_status in ("offline", "warning")
    is_offline  = new_status == "offline"
    is_warning  = new_status == "warning" and old_status != "offline"

    should_send = (
        (is_offline  and tenant["alert_on_offline"]) or
        (is_recovery and tenant["alert_on_recovery"]) or
        (is_warning  and tenant["alert_on_warning"])
    )
    if not should_send:
        return

    cpu = metrics.get("cpuPercent") if metrics else None
    ram = metrics.get("ramPercent") if metrics else None
    disk = metrics.get("diskPercent") if metrics else None
    await execute(
        """INSERT INTO pending_notifications
             (tenant_id, resource_type, resource_id, resource_name, old_status, new_status,
              error_message, cpu_percent, ram_percent, disk_percent)
           VALUES ($1,'server',$2,$3,$4,$5,$6,$7,$8,$9)""",
        server["tenant_id"], server["id"], server["name"], old_status, new_status,
        (server.get("last_error")[:300] if is_offline and server.get("last_error") else None),
        cpu, ram, disk,
    )
    return


async def notify_network_device_status(device: dict, old_status: str, new_status: str):
    """Poziva se iz snmp.py pri potvrdjenoj promeni statusa mreznog uredjaja.
    Ogledalo notify_server_status, ali koristi ODVOJENE tenant toggle-e
    (alert_network_offline/recovery/warning), ne alert_on_offline/recovery/warning
    koji vaze za servere -- svesna odluka od 11.8.2026 da se alarmi mogu
    nezavisno ukljuciti/iskljuciti po tipu (server vs. mrezni uredjaj)."""
    if old_status == new_status:
        return

    tenant = await fetchrow(
        "SELECT alerts_enabled, alert_network_offline, alert_network_recovery, alert_network_warning "
        "FROM tenants WHERE id=$1",
        device["tenant_id"]
    )
    if not tenant or not tenant["alerts_enabled"]:
        return

    is_recovery = new_status == "online" and old_status in ("offline", "warning")
    is_offline  = new_status == "offline"
    is_warning  = new_status == "warning" and old_status != "offline"

    should_send = (
        (is_offline  and tenant["alert_network_offline"]) or
        (is_recovery and tenant["alert_network_recovery"]) or
        (is_warning  and tenant["alert_network_warning"])
    )
    if not should_send:
        return

    await execute(
        """INSERT INTO pending_notifications
             (tenant_id, resource_type, resource_id, resource_name, old_status, new_status,
              error_message, cpu_percent, ram_percent, disk_percent)
           VALUES ($1,'network_device',$2,$3,$4,$5,$6,NULL,NULL,NULL)""",
        device["tenant_id"], device["id"], device["name"], old_status, new_status,
        (device.get("last_error")[:300] if is_offline and device.get("last_error") else None),
    )
    return


async def notify_execution(execution_id: str):
    """Poziva se nakon svakog rucno pokrenutog izvrsavanja skripte (Execute stranica).
    Zakazani poslovi imaju SOPSTVENU logiku (notify_scheduled_execution) — ne prolaze ovuda."""
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

    await send_execution_email(exec_row, recipients)


async def notify_scheduled_execution(execution_id: str, tenant_id: str,
                                      notify_on_failure: bool, notify_always: bool):
    """Zasebna logika za zakazane poslove — koristi PODESAVANJA TOG KONKRETNOG POSLA,
    ne opsta tenant podesavanja za rucna izvrsavanja. Master prekidac (alerts_enabled)
    i lista primalaca i dalje dolaze sa nivoa tenanta."""
    tenant = await fetchrow("SELECT alerts_enabled FROM tenants WHERE id=$1", tenant_id)
    if not tenant or not tenant["alerts_enabled"]:
        return

    exec_row = await fetchrow("SELECT * FROM executions WHERE id=$1", execution_id)
    if not exec_row:
        return

    has_failures = exec_row["error_count"] > 0
    should_send = (has_failures and notify_on_failure) or notify_always
    if not should_send:
        return

    recipients = await get_recipients(tenant_id)
    if not recipients:
        return

    await send_execution_email(exec_row, recipients)


async def send_execution_report(execution_id: str, tenant_id: str, override_recipients: list[str] | None = None):
    """Rucno pokrenuto slanje izvestaja (dugme u UI) — zaobilazi sve toggle provere."""
    exec_row = await fetchrow("SELECT * FROM executions WHERE id=$1 AND tenant_id=$2", execution_id, tenant_id)
    if not exec_row:
        raise ValueError("Execution nije pronadjen")

    recipients = override_recipients or await get_recipients(tenant_id)
    if not recipients:
        raise ValueError("Nema definisanih primalaca za ovaj tenant")

    await send_execution_email(exec_row, recipients)


async def send_execution_email(exec_row, recipients: list[str]):
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
