#!/usr/bin/env bash
# setup-hyperv-guest.sh
#
# Pokreni OVO NA LINUX VM-u (gostu), ne na Hyper-V hostu.
# Detektuje distribuciju, instalira Hyper-V integration daemone (KVP exchange,
# VSS, FCopy), pokrece i omogucava ih, pa na kraju ispisuje status svake
# komponente. Bezbedno za ponovno pokretanje.
#
# Upotreba:
#   sudo bash setup-hyperv-guest.sh

set -uo pipefail  # namerno BEZ -e -- hocemo da nastavimo i ako pojedinacni koraci ne uspeju

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}$1${NC}"; }

if [ "$(id -u)" -ne 0 ]; then
    echo "Pokreni sa sudo/root pravima: sudo bash $0"
    exit 1
fi

# ── 1. Detekcija distribucije ────────────────────────────────────────────────
info "== 1/4: Detekcija distribucije =="

if [ ! -f /etc/os-release ]; then
    fail "/etc/os-release ne postoji -- ne mogu da detektujem distribuciju"
    exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"
echo "  Detektovano: $PRETTY_NAME (ID=$DISTRO_ID, ID_LIKE=$DISTRO_LIKE)"

PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
elif command -v zypper >/dev/null 2>&1; then
    PKG_MANAGER="zypper"
elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
else
    fail "Nije prepoznat nijedan poznat paket menadzer (apt/dnf/yum/zypper/pacman)"
    exit 1
fi
echo "  Paket menadzer: $PKG_MANAGER"

# ── 2. Provera kernel modula ─────────────────────────────────────────────────
info ""
info "== 2/4: Provera Hyper-V kernel modula =="
if ! command -v lsmod >/dev/null 2>&1; then
    warn "lsmod nije dostupan na ovom sistemu -- preskacem proveru kernel modula"
else
    for mod in hv_vmbus hv_netvsc hv_utils hv_storvsc; do
        if lsmod | grep -q "^${mod} "; then
            ok "$mod ucitan"
        else
            warn "$mod NIJE ucitan (moguce da nije potreban za ovaj kernel/config, ili VM nije Gen2 sa odgovarajucim driverom)"
        fi
    done
fi

# ── 3. Instalacija paketa ────────────────────────────────────────────────────
info ""
info "== 3/4: Instalacija Hyper-V integration daemona =="

install_ok=false
case "$PKG_MANAGER" in
    apt)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        # Paket se zove hyperv-daemons na vecini Debian/Ubuntu verzija (9+/18.04+).
        # Na starijim/nekim izvedenim distribucijama koriste se linux-cloud-tools-* /
        # linux-tools-* umesto toga -- pokusavamo prvo standardni naziv, pa fallback.
        if apt-get install -y hyperv-daemons 2>/dev/null; then
            install_ok=true
        else
            warn "Paket 'hyperv-daemons' nije nadjen, probam linux-cloud-tools-\$(uname -r) + linux-tools-\$(uname -r)"
            KREL="$(uname -r)"
            if apt-get install -y "linux-cloud-tools-${KREL}" "linux-tools-${KREL}" 2>/dev/null; then
                install_ok=true
            else
                fail "Ni jedan poznat paket naziv nije uspeo -- proveri rucno 'apt search hyperv' na ovoj masini"
            fi
        fi
        ;;
    dnf|yum)
        "$PKG_MANAGER" install -y hyperv-daemons && install_ok=true
        ;;
    zypper)
        # SUSE naziv paketa varira izmedju verzija -- probamo par poznatih naziva.
        if zypper --non-interactive install hyper-v 2>/dev/null; then
            install_ok=true
        elif zypper --non-interactive install hyperv 2>/dev/null; then
            install_ok=true
        else
            fail "Nije nadjen poznat naziv paketa na openSUSE/SLES -- proveri rucno 'zypper search hyper' na ovoj masini"
        fi
        ;;
    pacman)
        warn "Arch/derivati obicno nemaju ovaj paket u zvanicnim repo-ima -- proveri AUR (npr. 'hyperv-daemons-git')"
        warn "Preskacem automatsku instalaciju za pacman"
        ;;
esac

if [ "$install_ok" = true ]; then
    ok "Paket(i) instalirani"
else
    warn "Instalacija nije potvrdjena kao uspesna -- nastavljam da probam da pokrenem demone (moguce da su vec instalirani)"
fi

# ── 4. Pokretanje i provera demona ──────────────────────────────────────────
info ""
info "== 4/4: Pokretanje demona + finalni status =="

DAEMONS="hv-kvp-daemon hv-vss-daemon hv-fcopy-daemon"
# Neki paketi koriste alternativne nazive servisa -- probaj oba obrasca.
ALT_DAEMONS="hypervkvpd hypervvssd hypervfcopyd"

any_active=false
for i in 1 2 3; do
    case $i in
        1) svc="hv-kvp-daemon";   alt="hypervkvpd" ;;
        2) svc="hv-vss-daemon";   alt="hypervvssd" ;;
        3) svc="hv-fcopy-daemon"; alt="hypervfcopyd" ;;
    esac

    target=""
    if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}\.service"; then
        target="$svc"
    elif systemctl list-unit-files 2>/dev/null | grep -q "^${alt}\.service"; then
        target="$alt"
    fi

    if [ -z "$target" ]; then
        fail "$svc -- servis nije pronadjen na ovom sistemu (paket verovatno nije instaliran)"
        continue
    fi

    systemctl enable --now "$target" >/dev/null 2>&1

    if systemctl is-active --quiet "$target"; then
        ok "$target -- aktivan"
        any_active=true
    else
        fail "$target -- NIJE aktivan (systemctl status $target za detalje)"
    fi
done

echo ""
if [ "$any_active" = true ]; then
    info "Gotovo. Bar jedan integration servis je aktivan."
    warn "VAZNO: KVP pool (odakle host cita OS ime) se obicno prvi put popuni tek"
    warn "posle RESTARTA ove VM. Restartuj je, sacekaj da se digne, pa proveri na"
    warn "Hyper-V hostu (PowerShell): Get-VMIntegrationService -VMName \"<ime>\""
    warn "-- 'Key-Value Pair Exchange' treba da pokazuje Enabled: True i PrimaryStatusDescription: OK."
else
    fail "Nijedan integration servis nije uspeo da se pokrene -- verovatno instalacija paketa nije uspela."
    fail "Proveri rucno koji paket ova distribucija ($PRETTY_NAME) koristi za Hyper-V integration servise."
fi
