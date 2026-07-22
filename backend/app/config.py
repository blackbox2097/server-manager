# app/config.py
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "servermanager"
    db_user: str = "servermanager"
    db_pass: str = ""

    jwt_secret:     str = ""
    jwt_expires_in: str = "8h"
    encryption_key: str = ""

    app_port:  int = 3000
    node_env:  str = "production"

    monitor_interval_sec:   int = 30
    monitor_max_parallel:   int = 20
    metrics_retention_days: int = 7
    log_retention_days:     int = 30
    status_debounce_polls:  int = 2

    ssh_connect_timeout_ms:   int = 10000
    ssh_exec_timeout_ms:      int = 300000
    winrm_connect_timeout_ms: int = 15000
    winrm_exec_timeout_ms:    int = 300000

    data_dir:     str = "/var/lib/servermanager"
    log_dir:      str = "/var/log/servermanager"
    ssh_keys_dir: str = "/var/lib/servermanager/ssh-keys"

    module_monitoring:  bool = True
    module_script_exec: bool = True
    module_winrm:       bool = True
    module_ldap:        bool = False

    class Config:
        env_file = "/etc/servermanager/.env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
