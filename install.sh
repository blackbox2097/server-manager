#!/usr/bin/env bash
# =============================================================================
# Server Manager — Instalacioni skript (Python/FastAPI verzija)
# Ubuntu 24.04 / 26.04 LTS minimalna instalacija
# Pokretanje: sudo bash install.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${CYAN}[..] $*${NC}"; }
warn() { echo -e "${YELLOW}[!!] $*${NC}"; }
die()  { echo -e "${RED}[ERR] $*${NC}" >&2; exit 1; }

# ── Konfiguracija ─────────────────────────────────────────────────────────────
APP_NAME="servermanager"
APP_USER="servermanager"
APP_DIR="/opt/servermanager"
DATA_DIR="/var/lib/servermanager"
LOG_DIR="/var/log/servermanager"
CONFIG_DIR="/etc/servermanager"
VENV_DIR="${APP_DIR}/venv"
APP_PORT=3000
DB_NAME="servermanager"
DB_USER="servermanager"
DB_PASS="${SM_DB_PASS:-}"

# ── Provjere ──────────────────────────────────────────────────────────────────
check_prerequisites() {
    info "Provjeravam preduslove..."
    [[ $EUID -eq 0 ]] || die "Pokrenuti kao root: sudo bash install.sh"
    . /etc/os-release
    [[ "$ID" == "ubuntu" ]] || die "Samo Ubuntu je podržan"
    local ver="${VERSION_ID%%.*}"
    [[ $ver -ge 24 ]] || die "Potreban Ubuntu 24.04 ili noviji (detektovano: $VERSION_ID)"
    log "Ubuntu $VERSION_ID"
    local free_kb; free_kb=$(df / --output=avail | tail -1)
    [[ $free_kb -ge 2097152 ]] || die "Nedovoljno prostora (min 2GB)"
    curl -sf --max-time 5 https://pypi.org > /dev/null || die "Nema internet konekcije"
    log "Preduslovi OK"
}

# ── Sistemski paketi ──────────────────────────────────────────────────────────
install_system_packages() {
    info "Ažuriram pakete..."
    apt-get update -qq
    info "Instaliram sistemske pakete..."
    apt-get install -y -qq \
        python3.12 python3.12-venv python3.12-dev \
        python3-pip libpq-dev gcc \
        postgresql postgresql-contrib \
        nginx ufw fail2ban logrotate \
        curl wget git unzip \
        2>/dev/null
    log "Sistemski paketi instalirani"
}

# ── PostgreSQL ────────────────────────────────────────────────────────────────
setup_postgresql() {
    info "Konfigurišem PostgreSQL..."
    systemctl enable postgresql --quiet
    systemctl start postgresql

    if [[ -z "$DB_PASS" ]]; then
        DB_PASS=$(openssl rand -base64 32 | tr -d '/+=')
        warn "Generisana DB lozinka — biće upisana u .env"
    fi

    sudo -u postgres psql -q << SQLEOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
        CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
    ELSE
        ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASS}';
    END IF;
END \$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER} ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQLEOF

    local PG_VER; PG_VER=$(psql --version | awk '{print $3}' | cut -d. -f1)
    local HBA="/etc/postgresql/${PG_VER}/main/pg_hba.conf"
    if ! grep -q "^local.*${DB_NAME}.*${DB_USER}" "$HBA" 2>/dev/null; then
        sed -i "/^local.*all.*all/i local   ${DB_NAME}   ${DB_USER}   md5" "$HBA"
        systemctl reload postgresql
    fi
    log "PostgreSQL konfigurisan"
    create_schema
}

# ── Baza — šema ───────────────────────────────────────────────────────────────
create_schema() {
    info "Kreiram šemu baze..."
    sudo -u postgres psql -d "$DB_NAME" -q << 'SCHEMA'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_versions (
    version     INTEGER      PRIMARY KEY,
    description TEXT         NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT         NOT NULL,
    slug        TEXT         NOT NULL,
    color       TEXT         NOT NULL DEFAULT '#378ADD',
    description TEXT,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    alerts_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
    alert_on_offline            BOOLEAN NOT NULL DEFAULT TRUE,
    alert_on_recovery           BOOLEAN NOT NULL DEFAULT TRUE,
    alert_on_warning            BOOLEAN NOT NULL DEFAULT FALSE,
    alert_on_execution_failure  BOOLEAN NOT NULL DEFAULT TRUE,
    alert_on_execution_report   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$')
);

CREATE TABLE IF NOT EXISTS users (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT        NOT NULL,
    password_hash   TEXT,
    full_name       TEXT,
    email           TEXT,
    role            TEXT        NOT NULL DEFAULT 'operator',
    auth_type       TEXT        NOT NULL DEFAULT 'local',
    ldap_dn         TEXT,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    last_login_ip   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT users_role_check CHECK (role IN ('superadmin', 'operator')),
    CONSTRAINT users_auth_type_check CHECK (auth_type IN ('local', 'ldap'))
);

CREATE TABLE IF NOT EXISTS operator_tenants (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    perm_view           BOOLEAN     NOT NULL DEFAULT TRUE,
    perm_scripts_run    BOOLEAN     NOT NULL DEFAULT FALSE,
    perm_scripts_manage BOOLEAN     NOT NULL DEFAULT FALSE,
    perm_servers_manage BOOLEAN     NOT NULL DEFAULT FALSE,
    perm_keys_manage    BOOLEAN     NOT NULL DEFAULT FALSE,
    assigned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT operator_tenants_unique UNIQUE (operator_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS ldap_configs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL DEFAULT 'Active Directory',
    url             TEXT        NOT NULL,
    bind_dn         TEXT        NOT NULL,
    bind_password   TEXT        NOT NULL,
    base_dn         TEXT        NOT NULL,
    user_filter     TEXT        NOT NULL DEFAULT '(sAMAccountName={{username}})',
    group_filter    TEXT,
    tls_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    tls_verify_cert BOOLEAN     NOT NULL DEFAULT TRUE,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ssh_keys (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    description     TEXT,
    public_key      TEXT,
    private_key_enc TEXT,
    key_type        TEXT        NOT NULL DEFAULT 'ed25519',
    fingerprint     TEXT,
    key_file_path   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    last_used_at    TIMESTAMPTZ,
    CONSTRAINT ssh_keys_name_tenant_unique UNIQUE (tenant_id, name),
    CONSTRAINT ssh_keys_type_check CHECK (key_type IN ('ed25519', 'rsa', 'ecdsa'))
);

CREATE TABLE IF NOT EXISTS servers (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    description     TEXT,
    hostname        TEXT,
    ip_address      TEXT        NOT NULL,
    os_type         TEXT        NOT NULL DEFAULT 'linux',
    os_name         TEXT,
    tags            TEXT[]      NOT NULL DEFAULT '{}',
    environment     TEXT        NOT NULL DEFAULT 'production',
    ssh_port        INTEGER     NOT NULL DEFAULT 22,
    ssh_user        TEXT,
    ssh_auth_type   TEXT        DEFAULT 'key',
    ssh_key_id      UUID        REFERENCES ssh_keys(id) ON DELETE SET NULL,
    ssh_password    TEXT,
    sudo_password   TEXT,
    winrm_port      INTEGER     NOT NULL DEFAULT 5985,
    winrm_https     BOOLEAN     NOT NULL DEFAULT FALSE,
    winrm_auth_type TEXT        DEFAULT 'local',
    winrm_user      TEXT,
    winrm_password  TEXT,
    status          TEXT        NOT NULL DEFAULT 'unknown',
    last_seen_at    TIMESTAMPTZ,
    last_error      TEXT,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT servers_os_type_check  CHECK (os_type IN ('linux', 'windows')),
    CONSTRAINT servers_status_check   CHECK (status IN ('online', 'offline', 'warning', 'unknown')),
    CONSTRAINT servers_env_check      CHECK (environment IN ('production', 'staging', 'dev'))
);

CREATE TABLE IF NOT EXISTS metrics (
    id              BIGSERIAL   PRIMARY KEY,
    server_id       UUID        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_percent     NUMERIC(5,2),
    ram_percent     NUMERIC(5,2),
    disk_percent    NUMERIC(5,2),
    uptime_seconds  BIGINT,
    load_avg_1m     NUMERIC(6,2),
    load_avg_5m     NUMERIC(6,2),
    load_avg_15m    NUMERIC(6,2),
    net_rx_kbps     NUMERIC(12,2),
    net_tx_kbps     NUMERIC(12,2),
    process_count   INTEGER,
    raw_data        JSONB
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_time ON metrics (server_id, collected_at DESC);

CREATE OR REPLACE FUNCTION cleanup_old_metrics() RETURNS void AS $$
BEGIN
    DELETE FROM metrics WHERE collected_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS scripts (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    description TEXT,
    os_type     TEXT        NOT NULL DEFAULT 'linux',
    content     TEXT        NOT NULL,
    is_builtin  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT scripts_os_type_check CHECK (os_type IN ('linux', 'windows', 'both')),
    CONSTRAINT scripts_name_tenant_unique UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS executions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    script_id       UUID        REFERENCES scripts(id) ON DELETE SET NULL,
    script_name     TEXT        NOT NULL,
    script_content  TEXT        NOT NULL,
    started_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'running',
    server_count    INTEGER     NOT NULL DEFAULT 0,
    success_count   INTEGER     NOT NULL DEFAULT 0,
    error_count     INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT executions_status_check CHECK (status IN ('running','done','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name               TEXT        NOT NULL,
    script_id          UUID        NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    server_ids         UUID[]      NOT NULL,
    cron_expression    TEXT        NOT NULL,
    active             BOOLEAN     NOT NULL DEFAULT TRUE,
    notify_on_failure  BOOLEAN     NOT NULL DEFAULT TRUE,
    notify_always      BOOLEAN     NOT NULL DEFAULT FALSE,
    last_run_at        TIMESTAMPTZ,
    last_execution_id  UUID        REFERENCES executions(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT scheduled_jobs_name_tenant_unique UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_tenant ON scheduled_jobs (tenant_id);

CREATE TABLE IF NOT EXISTS alert_recipients (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email      TEXT        NOT NULL,
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT alert_recipients_unique UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS smtp_settings (
    id           INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    host         TEXT,
    port         INTEGER     NOT NULL DEFAULT 587,
    username     TEXT,
    password_enc TEXT,
    from_email   TEXT,
    from_name    TEXT        NOT NULL DEFAULT 'Server Manager',
    use_tls      BOOLEAN     NOT NULL DEFAULT TRUE,
    configured   BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO smtp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


    id              BIGSERIAL   PRIMARY KEY,
    execution_id    UUID        NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    server_id       UUID        REFERENCES servers(id) ON DELETE SET NULL,
    server_name     TEXT        NOT NULL,
    server_ip       TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending',
    exit_code       INTEGER,
    stdout          TEXT,
    stderr          TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,
    CONSTRAINT exec_results_status_check CHECK (status IN ('pending','running','success','error','timeout'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL   PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
    username        TEXT,
    tenant_id       UUID        REFERENCES tenants(id) ON DELETE SET NULL,
    ip_address      TEXT,
    action          TEXT        NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    details         JSONB,
    success         BOOLEAN     NOT NULL DEFAULT TRUE,
    error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant   ON audit_log (tenant_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token   TEXT        NOT NULL UNIQUE,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_token   ON user_sessions (refresh_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions (expires_at);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['tenants','users','ldap_configs','servers','ssh_keys','scripts','scheduled_jobs']
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_updated_at ON %I;
             CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t);
    END LOOP;
END $$;

-- Parcijalni unique indeksi — ogranicenje vazi SAMO za aktivne redove,
-- tako da "obrisano" (active=false) ime/username/slug ponovo postaje slobodno.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_name_active_unique  ON tenants (name) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_active_unique  ON tenants (slug) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_active_unique ON users (username) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS servers_name_tenant_active_unique ON servers (tenant_id, name) WHERE active = true;

GRANT USAGE ON SCHEMA public TO servermanager;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO servermanager;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO servermanager;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO servermanager;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO servermanager;

INSERT INTO schema_versions (version, description)
VALUES (1, 'Inicijalna sema')
ON CONFLICT (version) DO NOTHING;
SCHEMA

    # Superadmin lozinka — generisemo hash dinamicki
    info "Kreiram superadmin korisnika..."
    local HASH
    HASH=$("${VENV_DIR}/bin/python" -c "import bcrypt; print(bcrypt.hashpw(b'ChangeMe123!', bcrypt.gensalt(12)).decode())")

    sudo -u postgres psql -d "$DB_NAME" -q << SQLEOF
INSERT INTO users (username, password_hash, full_name, role, auth_type)
VALUES ('superadmin', '${HASH}', 'Super Administrator', 'superadmin', 'local')
ON CONFLICT (username) DO NOTHING;
SQLEOF

    local TABLE_COUNT
    TABLE_COUNT=$(sudo -u postgres psql -d "$DB_NAME" -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" \
        | tr -d ' ')
    [[ $TABLE_COUNT -ge 9 ]] || die "Sema nije kompletna (${TABLE_COUNT} tabela)"
    log "Sema kreirana (${TABLE_COUNT} tabela)"
}

# ── App korisnik i direktorijumi ──────────────────────────────────────────────
setup_app_user() {
    info "Kreiram app korisnika i direktorijume..."
    if ! id "$APP_USER" &>/dev/null; then
        useradd --system --no-create-home --shell /usr/sbin/nologin \
            --home-dir "$APP_DIR" "$APP_USER"
    fi
    mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$CONFIG_DIR"
    mkdir -p "$DATA_DIR/ssh-keys" "$DATA_DIR/uploads"
    mkdir -p "$APP_DIR/backend/app/"{routers,services,models}
    mkdir -p "$APP_DIR/frontend/dist"
    mkdir -p "/var/backups/servermanager"
    chown "$APP_USER:$APP_USER" "/var/backups/servermanager"
    chmod 750 "/var/backups/servermanager"
    chmod 750 "$DATA_DIR/ssh-keys"
    log "Direktorijumi kreirani"
}

# ── Python virtualenv ─────────────────────────────────────────────────────────
setup_python() {
    info "Kreiram Python virtualenv..."
    python3.12 -m venv "$VENV_DIR"

    info "Instaliram Python pakete..."
    "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
    "${VENV_DIR}/bin/pip" install --quiet \
        fastapi==0.111.0 \
        "uvicorn[standard]==0.29.0" \
        asyncpg==0.29.0 \
        paramiko==3.4.0 \
        pydantic==2.7.1 \
        email-validator==2.1.1 \
        pydantic-settings==2.3.0 \
        "python-jose[cryptography]==3.3.0" \
        bcrypt==4.1.3 \
        python-multipart==0.0.9 \
        cryptography==42.0.8 \
        aiohttp==3.9.5 \
        apscheduler==3.10.4 \
        requests==2.31.0 \
        requests-ntlm==1.3.0

    # Provjeri
    "${VENV_DIR}/bin/python" -c "
import fastapi, uvicorn, asyncpg, paramiko, pydantic, jose, bcrypt, cryptography, aiohttp
print('  Sve zavisnosti OK')
print('  bcrypt verzija:', bcrypt.__version__)
print('  FastAPI verzija:', fastapi.__version__)
"
    chown -R "$APP_USER:$APP_USER" "$VENV_DIR"
    log "Python okruzenje spremno"
}

# ── Tajni kljucevi ────────────────────────────────────────────────────────────
generate_secrets() {
    info "Generisem tajne kljuceve..."
    JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=')
    ENCRYPTION_KEY=$(openssl rand -hex 32)
    SESSION_SECRET=$(openssl rand -base64 32 | tr -d '/+=')
    log "Kljucevi generisani"
}

# ── .env ──────────────────────────────────────────────────────────────────────
write_env() {
    info "Pisem konfiguraciju..."
    cat > "${CONFIG_DIR}/.env" << ENVEOF
NODE_ENV=production
APP_PORT=${APP_PORT}

DB_HOST=localhost
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
ENCRYPTION_KEY=${ENCRYPTION_KEY}

MONITOR_INTERVAL_SEC=30
MONITOR_MAX_PARALLEL=20
METRICS_RETENTION_DAYS=7

SSH_CONNECT_TIMEOUT_MS=10000
SSH_EXEC_TIMEOUT_MS=300000
WINRM_CONNECT_TIMEOUT_MS=15000
WINRM_EXEC_TIMEOUT_MS=300000

DATA_DIR=${DATA_DIR}
LOG_DIR=${LOG_DIR}
SSH_KEYS_DIR=${DATA_DIR}/ssh-keys

MODULE_MONITORING=true
MODULE_SCRIPT_EXEC=true
MODULE_WINRM=true
MODULE_LDAP=false

BACKUP_DIR=/var/backups/servermanager
PM2_USER=${APP_USER}
ENVEOF
    chmod 640 "${CONFIG_DIR}/.env"
    chown root:"$APP_USER" "${CONFIG_DIR}/.env"
    log ".env kreiran"
}

# ── PM2 ecosystem ─────────────────────────────────────────────────────────────
write_pm2() {
    cat > "${APP_DIR}/ecosystem.config.js" << ECOEOF
module.exports = {
  apps: [{
    name:        'servermanager',
    script:      '${VENV_DIR}/bin/uvicorn',
    args:        'app.main:app --host 127.0.0.1 --port ${APP_PORT} --workers 1',
    cwd:         '${APP_DIR}/backend',
    interpreter: 'none',
    watch:       false,
    env: {
      PYTHONPATH: '${APP_DIR}/backend',
    },
    out_file:    '${LOG_DIR}/app.log',
    error_file:  '${LOG_DIR}/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs:  true,
    max_restarts: 10,
    min_uptime:  '10s',
    restart_delay: 3000,
    kill_timeout:  8000,
    wait_ready:  false,
  }],
};
ECOEOF
    chown "$APP_USER:$APP_USER" "${APP_DIR}/ecosystem.config.js"
    log "PM2 config kreiran"
}

# ── Nginx ─────────────────────────────────────────────────────────────────────
setup_nginx() {
    info "Konfigurisem Nginx..."
    rm -f /etc/nginx/sites-enabled/default

    cat > "/etc/nginx/sites-available/${APP_NAME}" << 'NGINXEOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 80;
    listen [::]:80;
    server_name _;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    root /opt/servermanager/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|ico|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 310s;
        client_max_body_size 10m;
    }

    location /ws {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }

    location ~ /\. { deny all; }
}
NGINXEOF

    ln -sf "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
    nginx -t
    systemctl enable nginx --quiet
    systemctl restart nginx
    log "Nginx konfigurisan"
}

# ── Firewall ──────────────────────────────────────────────────────────────────
setup_firewall() {
    info "Konfigurisem firewall..."
    ufw --force reset > /dev/null 2>&1
    ufw default deny incoming > /dev/null
    ufw default allow outgoing > /dev/null
    ufw allow ssh   > /dev/null
    ufw allow http  > /dev/null
    ufw allow https > /dev/null

    echo ""
    echo -e "${YELLOW}Da li koristis neke od ovih servisa?${NC}"
    echo "  [1] Webmin (port 10000)"
    echo "  [2] Cockpit (port 9090)"
    echo "  [3] Custom portovi"
    echo "  [0] Nista"
    read -rp "Unesi brojeve odvojene razmakom (Enter za preskakanje): " EXTRA

    for choice in $EXTRA; do
        case $choice in
            1) ufw allow 10000/tcp > /dev/null && log "Webmin port 10000 otvoren" ;;
            2) ufw allow 9090/tcp  > /dev/null && log "Cockpit port 9090 otvoren" ;;
            3)
                read -rp "Unesi portove (npr: 8080 8443): " PORTS
                for p in $PORTS; do ufw allow ${p}/tcp > /dev/null && log "Port $p otvoren"; done ;;
        esac
    done

    ufw --force enable > /dev/null
    log "Firewall konfigurisan"
}

# ── Logrotate ─────────────────────────────────────────────────────────────────
setup_logrotate() {
    cat > "/etc/logrotate.d/${APP_NAME}" << LREOF
${LOG_DIR}/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 640 ${APP_USER} ${APP_USER}
}
LREOF
}

# ── Deploy backend ako postoji ────────────────────────────────────────────────
deploy_if_present() {
    local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ ! -d "${SCRIPT_DIR}/backend" ]]; then
        warn "backend/ nije pronadjen — kopiraj ga rucno u ${APP_DIR}/backend/"
        return
    fi
    info "Kopiram backend..."
    cp -r "${SCRIPT_DIR}/backend/." "${APP_DIR}/backend/"
    chown -R "$APP_USER:$APP_USER" "${APP_DIR}/backend"

    if [[ -d "${SCRIPT_DIR}/frontend/dist" ]]; then
        info "Kopiram frontend..."
        cp -r "${SCRIPT_DIR}/frontend/dist/." "${APP_DIR}/frontend/dist/"
        chown -R "$APP_USER:$APP_USER" "${APP_DIR}/frontend"
    fi

    if [[ -d "${SCRIPT_DIR}/scripts" ]]; then
        info "Instaliram backup/restore skripte..."
        mkdir -p "${APP_DIR}/scripts"
        cp "${SCRIPT_DIR}/scripts/backup_db.sh"  "${APP_DIR}/scripts/" 2>/dev/null || true
        cp "${SCRIPT_DIR}/scripts/restore_db.sh" "${APP_DIR}/scripts/" 2>/dev/null || true
        chown root:root "${APP_DIR}/scripts/backup_db.sh" "${APP_DIR}/scripts/restore_db.sh" 2>/dev/null || true
        chmod 700 "${APP_DIR}/scripts/backup_db.sh" "${APP_DIR}/scripts/restore_db.sh" 2>/dev/null || true

        # Usko ograniceno sudo pravilo — app korisnik sme da pokrene SAMO ova dva
        # konkretna skripta kao root, nista drugo. Neophodno da bi dugmici za
        # backup/restore u UI-ju mogli da funkcionisu.
        cat > /tmp/servermanager-backup-sudoers << SUDOEOF
${APP_USER} ALL=(root) NOPASSWD: ${APP_DIR}/scripts/backup_db.sh, ${APP_DIR}/scripts/restore_db.sh
SUDOEOF
        if visudo -c -f /tmp/servermanager-backup-sudoers &>/dev/null; then
            cp /tmp/servermanager-backup-sudoers /etc/sudoers.d/servermanager-backup
            chmod 440 /etc/sudoers.d/servermanager-backup
            log "Sudo pravilo za backup/restore instalirano"
        else
            warn "Sudo pravilo nije validno — backup/restore dugmici u UI-ju nece raditi. Proveri rucno."
        fi
        rm -f /tmp/servermanager-backup-sudoers
    fi

    chown -R "$APP_USER:$APP_USER" "${APP_DIR}"
    chmod 640 "${CONFIG_DIR}/.env"
    chown root:"$APP_USER" "${CONFIG_DIR}/.env"

    info "Pokrecem aplikaciju..."
    sudo -u "$APP_USER" pm2 delete servermanager 2>/dev/null || true
    sleep 1
    fuser -k ${APP_PORT}/tcp 2>/dev/null || true
    sleep 1
    sudo -u "$APP_USER" pm2 start "${APP_DIR}/ecosystem.config.js"
    sudo -u "$APP_USER" pm2 save > /dev/null 2>&1
    sleep 3

    info "Podesavam PM2 da automatski startuje aplikaciju pri boot-u sistema..."
    env PATH=$PATH:/usr/bin pm2 startup systemd -u "$APP_USER" --hp "$APP_DIR" > /tmp/pm2-startup.log 2>&1 || true
    sudo -u "$APP_USER" pm2 save > /dev/null 2>&1
    if systemctl is-enabled "pm2-${APP_USER}" &>/dev/null; then
        log "PM2 startup servis instaliran (pm2-${APP_USER}.service) — aplikacija ce se sama podici posle restarta"
    else
        warn "Automatska PM2 startup konfiguracija nije potvrdjena — proveri rucno: sudo -u ${APP_USER} pm2 startup"
    fi

    # Health check
    local HEALTH
    HEALTH=$(curl -sf http://localhost:${APP_PORT}/health 2>/dev/null || echo "")
    if echo "$HEALTH" | grep -q "ok"; then
        log "Aplikacija pokrenuta i radi"
    else
        warn "Aplikacija nije odmah odgovorila — provjerite: sudo -u ${APP_USER} pm2 logs servermanager"
    fi
}

# ── Zavrsni ispis ─────────────────────────────────────────────────────────────
print_summary() {
    local IP; IP=$(hostname -I | awk '{print $1}')
    echo ""
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Server Manager — Instalacija zavrsena!${NC}"
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}Aplikacija:${NC}    http://${IP}"
    echo -e "  ${CYAN}Konfiguracija:${NC} ${CONFIG_DIR}/.env"
    echo -e "  ${CYAN}Logovi:${NC}        ${LOG_DIR}/"
    echo ""
    echo -e "  ${YELLOW}Login:${NC} superadmin / ChangeMe123!"
    echo -e "  ${RED}OBAVEZNO promijeniti lozinku pri prvom loginu!${NC}"
    echo ""
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${NC}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
    echo -e "${BOLD}${CYAN}"
    echo "  ╔═══════════════════════════════════════╗"
    echo "  ║   Server Manager — Python/FastAPI     ║"
    echo "  ║   Ubuntu 24.04 / 26.04 LTS            ║"
    echo "  ╚═══════════════════════════════════════╝"
    echo -e "${NC}"

    check_prerequisites
    install_system_packages
    setup_app_user
    generate_secrets
    setup_python          # virtualenv mora biti spreman prije hash generisanja
    setup_postgresql      # kreira semu i superadmina (koristi virtualenv bcrypt)
    write_env
    write_pm2
    setup_nginx
    setup_firewall
    setup_logrotate
    deploy_if_present
    print_summary
}

main "$@"
