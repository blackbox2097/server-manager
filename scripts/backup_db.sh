#!/usr/bin/env bash
# scripts/backup_db.sh — pravi backup baze
# Poziva se SAMO preko sudo sa aplikacionog korisnika (vidi sudoers pravilo).
# Argumenti: $1 = putanja izlaznog fajla, $2 = aplikacioni korisnik (vlasnik fajla posle)
set -euo pipefail

OUT="${1:?Nedostaje putanja izlaznog fajla}"
APP_USER="${2:?Nedostaje aplikacioni korisnik}"

sudo -u postgres pg_dump -Fc -d servermanager -f "$OUT"
chown "$APP_USER:$APP_USER" "$OUT"
chmod 640 "$OUT"
echo "OK"
