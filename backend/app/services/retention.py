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


def start():
    cfg = get_settings()
    scheduler.add_job(run_retention, "interval", seconds=cfg.retention_tick_sec, id="retention")
    logger.info(f"Retention engine pokrenut (tick: {cfg.retention_tick_sec}s)")
