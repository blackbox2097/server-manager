# app/services/retention.py
# Dvoslojni raw+rollup sistem cuvanja metrika, podesivo PO SERVERU
# (isti duh kao poll_interval_sec). Zamenjuje stari globalni flat
# 7-dana cleanup (monitor.cleanup_metrics, uklonjen) koji nije mogao
# da ima razlicite pragove po tenantu/serveru.
#
# Svaki tik (retention_tick_sec):
#   1) za svaki aktivan server, raw redove u `metrics` starije od
#      server.raw_retention_hours agregira (prosek/min/max) u bucket-e
#      od server.rollup_bucket_minutes i upisuje/spaja u `metrics_rollup`
#   2) brise upravo agregirane raw redove
#   3) brise rollup redove starije od server.rollup_retention_days
#
# UPSERT koristi count-ponderisan prosek (ne naivan prosek postojeceg i
# novog) da bi ostao tacan i ako se isti bucket agregira u vise navrata
# (npr. kad je rollup_bucket_minutes veliki pa raw podaci za taj bucket
# istrure u razlicitim tik-ovima).

import logging
from datetime import datetime, timedelta, timezone
from app.database import fetch, execute
from app.services.monitor import scheduler
from app.config import get_settings

logger = logging.getLogger(__name__)


async def _rollup_server(server: dict) -> int:
    """Jedan BULK SQL upit po serveru (INSERT...SELECT...GROUP BY...ON CONFLICT)
    umesto Python petlje sa pojedinacnim execute() po bucket-u -- kriticno
    kad ima hiljade bucket-a po serveru (npr. rollup_bucket_minutes=1 preko
    vise dana istorije = i do 10000+ bucket-a). Petlja bi to radila kao
    isto toliko round-trip-ova ka bazi i bila neupotrebljivo spora."""
    sid         = server["id"]
    raw_hours   = server["raw_retention_hours"]
    bucket_min  = server["rollup_bucket_minutes"]
    rollup_days = server["rollup_retention_days"]
    bucket_sec  = bucket_min * 60

    result = await execute(
        """
        INSERT INTO metrics_rollup
            (server_id, bucket_start, bucket_minutes, sample_count,
             cpu_avg, cpu_min, cpu_max, ram_avg, ram_min, ram_max,
             disk_avg, disk_min, disk_max, net_rx_kbps_avg, net_tx_kbps_avg)
        SELECT
            $1::uuid,
            to_timestamp(floor(extract(epoch FROM collected_at) / $3) * $3),
            $2,
            COUNT(*),
            AVG(cpu_percent),  MIN(cpu_percent),  MAX(cpu_percent),
            AVG(ram_percent),  MIN(ram_percent),  MAX(ram_percent),
            AVG(disk_percent), MIN(disk_percent), MAX(disk_percent),
            AVG(net_rx_kbps),  AVG(net_tx_kbps)
        FROM metrics
        WHERE server_id = $1::uuid AND collected_at < NOW() - make_interval(hours => $4)
        GROUP BY 2
        ON CONFLICT (server_id, bucket_start, bucket_minutes) DO UPDATE SET
            cpu_avg = (metrics_rollup.cpu_avg * metrics_rollup.sample_count
                       + EXCLUDED.cpu_avg * EXCLUDED.sample_count)
                      / (metrics_rollup.sample_count + EXCLUDED.sample_count),
            ram_avg = (metrics_rollup.ram_avg * metrics_rollup.sample_count
                       + EXCLUDED.ram_avg * EXCLUDED.sample_count)
                      / (metrics_rollup.sample_count + EXCLUDED.sample_count),
            disk_avg = (metrics_rollup.disk_avg * metrics_rollup.sample_count
                       + EXCLUDED.disk_avg * EXCLUDED.sample_count)
                      / (metrics_rollup.sample_count + EXCLUDED.sample_count),
            net_rx_kbps_avg = (metrics_rollup.net_rx_kbps_avg * metrics_rollup.sample_count
                       + EXCLUDED.net_rx_kbps_avg * EXCLUDED.sample_count)
                      / (metrics_rollup.sample_count + EXCLUDED.sample_count),
            net_tx_kbps_avg = (metrics_rollup.net_tx_kbps_avg * metrics_rollup.sample_count
                       + EXCLUDED.net_tx_kbps_avg * EXCLUDED.sample_count)
                      / (metrics_rollup.sample_count + EXCLUDED.sample_count),
            cpu_min  = LEAST(metrics_rollup.cpu_min, EXCLUDED.cpu_min),
            cpu_max  = GREATEST(metrics_rollup.cpu_max, EXCLUDED.cpu_max),
            ram_min  = LEAST(metrics_rollup.ram_min, EXCLUDED.ram_min),
            ram_max  = GREATEST(metrics_rollup.ram_max, EXCLUDED.ram_max),
            disk_min = LEAST(metrics_rollup.disk_min, EXCLUDED.disk_min),
            disk_max = GREATEST(metrics_rollup.disk_max, EXCLUDED.disk_max),
            sample_count = metrics_rollup.sample_count + EXCLUDED.sample_count
        """,
        sid, bucket_min, bucket_sec, raw_hours,
    )
    # asyncpg execute() vraca npr. "INSERT 0 42" -- izvuci broj obradjenih redova
    try:
        n_buckets = int(result.split()[-1])
    except (ValueError, IndexError):
        n_buckets = 0

    if n_buckets == 0:
        return 0

    await execute(
        "DELETE FROM metrics WHERE server_id=$1 AND collected_at < NOW() - make_interval(hours => $2)",
        sid, raw_hours,
    )
    await execute(
        "DELETE FROM metrics_rollup WHERE server_id=$1 AND bucket_start < NOW() - make_interval(days => $2)",
        sid, rollup_days,
    )
    return n_buckets


def _wavg(col: str) -> str:
    """Ponderisan prosek za ON CONFLICT spajanje bucket-a, otporan na NULL
    (UPS metrike poput battery_charge/runtime mogu biti NULL)."""
    return (f"{col} = CASE WHEN r.{col} IS NULL THEN EXCLUDED.{col} "
            f"WHEN EXCLUDED.{col} IS NULL THEN r.{col} "
            f"ELSE (r.{col} * r.sample_count + EXCLUDED.{col} * EXCLUDED.sample_count) "
            f"/ (r.sample_count + EXCLUDED.sample_count) END")


_UPS_ROLLUP_SQL = f"""
    INSERT INTO ups_metrics_rollup AS r
        (ups_id, bucket_start, bucket_minutes, sample_count,
         load_avg, load_min, load_max, charge_avg, charge_min, runtime_min_sec,
         input_v_avg, input_v_min, input_v_max, output_v_avg, temp_avg, temp_max,
         on_battery_samples)
    SELECT
        $1::uuid,
        to_timestamp(floor(extract(epoch FROM collected_at) / $3) * $3),
        $2,
        COUNT(*),
        AVG(load_percent), MIN(load_percent), MAX(load_percent),
        AVG(battery_charge), MIN(battery_charge), MIN(battery_runtime_sec),
        AVG(input_voltage), MIN(input_voltage), MAX(input_voltage),
        AVG(output_voltage), AVG(temperature), MAX(temperature),
        COUNT(*) FILTER (WHERE status IN ('on_battery', 'low_battery'))
    FROM ups_metrics
    WHERE ups_id = $1::uuid AND collected_at < $4
    GROUP BY 2
    ON CONFLICT (ups_id, bucket_start, bucket_minutes) DO UPDATE SET
        {_wavg('load_avg')}, {_wavg('charge_avg')}, {_wavg('input_v_avg')},
        {_wavg('output_v_avg')}, {_wavg('temp_avg')},
        load_min = LEAST(r.load_min, EXCLUDED.load_min),
        load_max = GREATEST(r.load_max, EXCLUDED.load_max),
        charge_min = LEAST(r.charge_min, EXCLUDED.charge_min),
        runtime_min_sec = LEAST(r.runtime_min_sec, EXCLUDED.runtime_min_sec),
        input_v_min = LEAST(r.input_v_min, EXCLUDED.input_v_min),
        input_v_max = GREATEST(r.input_v_max, EXCLUDED.input_v_max),
        temp_max = GREATEST(r.temp_max, EXCLUDED.temp_max),
        on_battery_samples = r.on_battery_samples + EXCLUDED.on_battery_samples,
        sample_count = r.sample_count + EXCLUDED.sample_count
"""


async def _rollup_ups(ups: dict) -> int:
    """Raw ups_metrics stariji od raw_retention_hours -> ups_metrics_rollup,
    pa brisanje. Cutoff se racuna JEDNOM (isti za INSERT i DELETE)."""
    uid        = ups["id"]
    bucket_min = ups["rollup_bucket_minutes"]
    cutoff     = datetime.now(timezone.utc) - timedelta(hours=ups["raw_retention_hours"])
    rollup_cut = datetime.now(timezone.utc) - timedelta(days=ups["rollup_retention_days"])

    result = await execute(_UPS_ROLLUP_SQL, uid, bucket_min, bucket_min * 60, cutoff)
    try:
        n_buckets = int(result.split()[-1])
    except (ValueError, IndexError):
        n_buckets = 0

    if n_buckets:
        await execute("DELETE FROM ups_metrics WHERE ups_id=$1 AND collected_at < $2", uid, cutoff)
    await execute("DELETE FROM ups_metrics_rollup WHERE ups_id=$1 AND bucket_start < $2", uid, rollup_cut)
    return n_buckets


async def _rollup_network_device(device: dict) -> int:
    """Isto kao _rollup_server, ali za interface metrike mreznog uredjaja
    (preko svih njegovih interfejsa). in/out_errors i discards su DELTE
    (snmp._poll racuna razliku izmedju dva poll-a), pa je rollup SUM.
    Cutoff se racuna JEDNOM i ista vrednost ide u INSERT i DELETE -- nema
    prozora u kome red predje granicu izmedju dva NOW() poziva."""
    did         = device["id"]
    bucket_min  = device["rollup_bucket_minutes"]
    bucket_sec  = bucket_min * 60
    cutoff      = datetime.now(timezone.utc) - timedelta(hours=device["raw_retention_hours"])
    rollup_cut  = datetime.now(timezone.utc) - timedelta(days=device["rollup_retention_days"])

    result = await execute(
        """
        INSERT INTO network_device_interface_metrics_rollup
            (interface_id, bucket_start, bucket_minutes, sample_count,
             in_kbps_avg, in_kbps_min, in_kbps_max,
             out_kbps_avg, out_kbps_min, out_kbps_max,
             in_errors_sum, out_errors_sum, in_discards_sum, out_discards_sum)
        SELECT
            m.interface_id,
            to_timestamp(floor(extract(epoch FROM m.collected_at) / $3) * $3),
            $2,
            COUNT(*),
            AVG(m.in_kbps),  MIN(m.in_kbps),  MAX(m.in_kbps),
            AVG(m.out_kbps), MIN(m.out_kbps), MAX(m.out_kbps),
            SUM(m.in_errors), SUM(m.out_errors), SUM(m.in_discards), SUM(m.out_discards)
        FROM network_device_interface_metrics m
        JOIN network_device_interfaces i ON i.id = m.interface_id
        WHERE i.device_id = $1::uuid AND m.collected_at < $4
        GROUP BY 1, 2
        ON CONFLICT (interface_id, bucket_start, bucket_minutes) DO UPDATE SET
            in_kbps_avg = (r.in_kbps_avg * r.sample_count + EXCLUDED.in_kbps_avg * EXCLUDED.sample_count)
                          / (r.sample_count + EXCLUDED.sample_count),
            out_kbps_avg = (r.out_kbps_avg * r.sample_count + EXCLUDED.out_kbps_avg * EXCLUDED.sample_count)
                          / (r.sample_count + EXCLUDED.sample_count),
            in_kbps_min  = LEAST(r.in_kbps_min, EXCLUDED.in_kbps_min),
            in_kbps_max  = GREATEST(r.in_kbps_max, EXCLUDED.in_kbps_max),
            out_kbps_min = LEAST(r.out_kbps_min, EXCLUDED.out_kbps_min),
            out_kbps_max = GREATEST(r.out_kbps_max, EXCLUDED.out_kbps_max),
            in_errors_sum    = COALESCE(r.in_errors_sum, 0)    + COALESCE(EXCLUDED.in_errors_sum, 0),
            out_errors_sum   = COALESCE(r.out_errors_sum, 0)   + COALESCE(EXCLUDED.out_errors_sum, 0),
            in_discards_sum  = COALESCE(r.in_discards_sum, 0)  + COALESCE(EXCLUDED.in_discards_sum, 0),
            out_discards_sum = COALESCE(r.out_discards_sum, 0) + COALESCE(EXCLUDED.out_discards_sum, 0),
            sample_count = r.sample_count + EXCLUDED.sample_count
        """.replace("ON CONFLICT", "ON CONFLICT").replace(
            "INSERT INTO network_device_interface_metrics_rollup",
            "INSERT INTO network_device_interface_metrics_rollup AS r"),
        did, bucket_min, bucket_sec, cutoff,
    )
    try:
        n_buckets = int(result.split()[-1])
    except (ValueError, IndexError):
        n_buckets = 0

    if n_buckets:
        await execute(
            """DELETE FROM network_device_interface_metrics m
               USING network_device_interfaces i
               WHERE m.interface_id = i.id AND i.device_id = $1::uuid AND m.collected_at < $2""",
            did, cutoff,
        )
    await execute(
        """DELETE FROM network_device_interface_metrics_rollup r
           USING network_device_interfaces i
           WHERE r.interface_id = i.id AND i.device_id = $1::uuid AND r.bucket_start < $2""",
        did, rollup_cut,
    )
    return n_buckets


async def run_retention():
    """Scheduler tik -- agregira istekle raw metrike u rollup i cisti stare
    redove, PO SERVERU (svaki server ima svoj raw_retention_hours /
    rollup_bucket_minutes / rollup_retention_days)."""
    try:
        servers = await fetch(
            "SELECT id, raw_retention_hours, rollup_bucket_minutes, rollup_retention_days "
            "FROM servers WHERE active=true"
        )
    except Exception as e:
        logger.error(f"Retention: greska dohvatanja servera: {e}")
        return

    total_buckets = 0
    for s in servers:
        try:
            total_buckets += await _rollup_server(dict(s))
        except Exception as e:
            logger.error(f"Retention: greska za server {s['id']}: {e}")

    if total_buckets:
        logger.info(f"Retention: agregirano {total_buckets} bucket-a preko {len(servers)} servera")

    # --- UPS uredjaji -- PRE mreznih (mrezni blok ima return na gresku) ---
    try:
        ups_rows = await fetch(
            "SELECT id, raw_retention_hours, rollup_bucket_minutes, rollup_retention_days "
            "FROM ups_devices"
        )
    except Exception as e:
        logger.error(f"Retention: greska dohvatanja UPS uredjaja: {e}")
        ups_rows = []
    ups_buckets = 0
    for u in ups_rows:
        try:
            ups_buckets += await _rollup_ups(dict(u))
        except Exception as e:
            logger.error(f"Retention: greska za UPS {u['id']}: {e}")
    if ups_buckets:
        logger.info(f"Retention: agregirano {ups_buckets} UPS bucket-a preko {len(ups_rows)} UPS uredjaja")

    # --- mrezni uredjaji (interface metrike) -- svi, i neaktivni, da im podaci ne ostaju zauvek ---
    try:
        devices = await fetch(
            "SELECT id, raw_retention_hours, rollup_bucket_minutes, rollup_retention_days "
            "FROM network_devices"
        )
    except Exception as e:
        logger.error(f"Retention: greska dohvatanja mreznih uredjaja: {e}")
        return

    net_buckets = 0
    for d in devices:
        try:
            net_buckets += await _rollup_network_device(dict(d))
        except Exception as e:
            logger.error(f"Retention: greska za mrezni uredjaj {d['id']}: {e}")

    if net_buckets:
        logger.info(f"Retention: agregirano {net_buckets} interface bucket-a preko {len(devices)} mreznih uredjaja")


def start():
    cfg = get_settings()
    scheduler.add_job(run_retention, "interval", seconds=cfg.retention_tick_sec, id="retention")
    logger.info(f"Retention engine pokrenut (tick: {cfg.retention_tick_sec}s)")
