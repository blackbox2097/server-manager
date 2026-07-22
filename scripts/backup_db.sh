#!/usr/bin/env bash
# scripts/backup_db.sh — pravi backup baze
# Poziva se SAMO preko sudo sa aplikacionog korisnika (vidi sudoers pravilo).
# Argumenti: $1 = putanja izlaznog fajla, $2 = aplikacioni korisnik (vlasnik fajla posle)
set -euo pipefail

OUT="${1:?Nedostaje putanja izlaznog fajla}"
APP_USER="${2:?Nedostaje aplikacioni korisnik}"

# postgres korisnik nema pravo pisanja u backup direktorijum (vlasnistvo APP_USER-a),
# pa prvo pravimo dump u /tmp (gde postgres uvek ima pristup), pa ga OVAJ skript
# (koji radi kao root) premesta i menja vlasnistvo na finalnoj lokaciji.
TMP_OUT="/tmp/$(basename "$OUT").tmp"
sudo -u postgres pg_dump -Fc -d servermanager -f "$TMP_OUT"
mv "$TMP_OUT" "$OUT"
chown "$APP_USER:$APP_USER" "$OUT"
chmod 640 "$OUT"
echo "OK"
