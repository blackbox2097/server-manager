#!/usr/bin/env bash
# scripts/restore_db.sh — vraca bazu iz backup fajla i restartuje aplikaciju
# Poziva se preko sudo sa aplikacionog korisnika, ali radi DETACHED (u pozadini)
# jer ce ugasiti proces koji ga je pokrenuo.
# Argumenti: $1 = putanja backup fajla, $2 = aplikacioni korisnik (za pm2 komande)
set -euo pipefail

BACKUP_FILE="${1:?Nedostaje putanja backup fajla}"
APP_USER="${2:?Nedostaje aplikacioni korisnik}"
APP_DIR="/opt/servermanager"
LOG="/var/log/servermanager/restore.log"

log() { echo "$(date -Is) $*" >> "$LOG"; }

[[ -f "$BACKUP_FILE" ]] || { log "GRESKA: backup fajl ne postoji: $BACKUP_FILE"; exit 1; }

log "=== Restore pokrenut: $BACKUP_FILE ==="

# Sacekaj da HTTP odgovor stigne nazad do browsera pre nego sto ugasimo app
sleep 3

log "Zaustavljam aplikaciju..."
sudo -u "$APP_USER" pm2 stop servermanager >> "$LOG" 2>&1 || true
sleep 1

# postgres korisnik nema pravo citanja originalnog backup fajla (vlasnistvo APP_USER-a),
# pa ga prvo kopiramo u /tmp (citljivo za sve) — ovaj skript radi kao root pa to moze.
TMP_RESTORE="/tmp/$(basename "$BACKUP_FILE").restore"
cp "$BACKUP_FILE" "$TMP_RESTORE"
chmod 644 "$TMP_RESTORE"

log "Vracam bazu iz backup-a (postojeci podaci se BRISU)..."
if sudo -u postgres pg_restore --clean --if-exists --no-owner -d servermanager "$TMP_RESTORE" >> "$LOG" 2>&1; then
    log "pg_restore zavrsen uspesno"
else
    log "UPOZORENJE: pg_restore je vratio gresku (moguce da su neki objekti vec obrisani — cesto bezopasno, proveri log)"
fi
rm -f "$TMP_RESTORE"

log "Ponovo pokrecem aplikaciju..."
sudo -u "$APP_USER" pm2 start "${APP_DIR}/ecosystem.config.js" >> "$LOG" 2>&1
sudo -u "$APP_USER" pm2 save > /dev/null 2>&1 || true

log "=== Restore zavrsen ==="
