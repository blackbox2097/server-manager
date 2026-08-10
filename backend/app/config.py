# app/config.py
from pydantic_settings import BaseSettings
from pydantic import field_validator
from functools import lru_cache


class Settings(BaseSettings):
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "servermanager"
    db_user: str = "servermanager"
    db_pass: str = ""
    db_pool_min: int = 5
    db_pool_max: int = 25

    jwt_secret:     str = ""
    jwt_expires_in: str = "8h"
    encryption_key: str = ""

    app_port:  int = 3000
    node_env:  str = "production"

    monitor_interval_sec:   int = 30
    monitor_max_parallel:   int = 20
    poll_tick_sec:          int = 5   # koliko cesto scheduler proverava koji serveri su "dospeli"
    poll_watchdog_sec:      int = 120  # tvrdi limit po serveru -- sprecava da jedan zaglavljeni
                                        # poll (bez bacenog izuzetka) zamrzne ceo monitoring ciklus
    snmp_poll_tick_sec:     int = 5    # isti duh kao poll_tick_sec, za mrezne uredjaje
    snmp_poll_watchdog_sec: int = 30   # SNMP je UDP, ne treba mu 120s kao SSH -- brz timeout/retry
    snmp_max_parallel:      int = 20
    metrics_retention_days: int = 7   # NAPOMENA: vise se ne koristi za metrics cleanup
                                        # (zamenjeno per-server raw+rollup retention engine-om
                                        # u services/retention.py) -- ostavljeno zbog .env
                                        # kompatibilnosti, ne brisati bez provere .env fajlova.
    retention_tick_sec:     int = 300  # koliko cesto raw+rollup retention posao proverava
                                        # istekle metrike (per-server pragovi, ne globalni)
    log_retention_days:     int = 30
    status_debounce_polls:  int = 2

    backup_dir: str = "/var/backups/servermanager"
    pm2_user:   str = "servermanager"

    ssh_connect_timeout_ms:   int = 10000
    ssh_exec_timeout_ms:      int = 300000
    winrm_connect_timeout_ms: int = 15000
    winrm_exec_timeout_ms:    int = 300000

    # Dedicated thread pool za sve blokirajuce pozive (SSH/WinRM/ESXi, terminal
    # sesije, notify) -- Python-ov podrazumevani pool (min(32, cpu+4)) je
    # premali za monitor_max_parallel + otvorene terminal sesije istovremeno.
    executor_max_workers: int = 50

    data_dir:     str = "/var/lib/servermanager"
    log_dir:      str = "/var/log/servermanager"
    ssh_keys_dir: str = "/var/lib/servermanager/ssh-keys"

    module_monitoring:  bool = True
    module_script_exec: bool = True
    module_winrm:       bool = True
    module_ldap:        bool = False

    @field_validator("jwt_secret")
    @classmethod
    def check_jwt_secret(cls, v):
        if not v or len(v) < 32:
            raise ValueError(
                "JWT_SECRET mora biti postavljen i imati bar 32 karaktera "
                "(proveri /etc/servermanager/.env) -- kritican bezbednosni parametar."
            )
        return v

    @field_validator("encryption_key")
    @classmethod
    def check_encryption_key(cls, v):
        if not v or len(v) != 64:
            raise ValueError(
                "ENCRYPTION_KEY mora biti postavljen i imati tacno 64 hex karaktera "
                "(proveri /etc/servermanager/.env) -- kritican bezbednosni parametar."
            )
        return v

    class Config:
        env_file = "/etc/servermanager/.env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
