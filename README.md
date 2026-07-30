# Server Manager

Multi-tenant platforma za upravljanje serverima i hipervizorima (Linux, Windows, Proxmox, Hyper-V, ESXi) u VPN/intranet okruženju — do 200 servera, granularne dozvole po operateru, real-time monitoring, izvršavanje skripti, automatizacija na osnovu okidača, i interaktivni web terminal.

## Stack

- **Backend:** Python 3.12, FastAPI, Uvicorn
- **Baza:** PostgreSQL (asyncpg)
- **SSH:** Paramiko
- **WinRM:** aiohttp + ručna SOAP implementacija
- **Proxmox:** REST API (httpx) preko API tokena
- **ESXi:** pyVmomi (VMware SDK za Python)
- **Frontend:** React + Vite + Tailwind CSS, xterm.js (terminal)
- **Auth:** JWT (python-jose) + bcrypt
- **Enkripcija:** AES-256-GCM za lozinke/ključeve/API tokene u bazi
- **Process manager:** PM2
- **Reverse proxy:** Nginx

## Funkcionalnosti

**Serveri (Linux/Windows)**
- Multi-tenant izolacija: superadmin (pristup svemu) + operateri (granularne dozvole po tenantu)
- Linux serveri preko SSH (lozinka, ključ, ili oboje), sa opcionim sudo pristupom
- Windows serveri preko WinRM (monitoring/skripte) i SSH (interaktivni terminal, zahteva OpenSSH na Windows mašini)
- SSH/WinRM fallback arhitektura — automatski prelazi na alternativnu metodu konekcije ako primarna ne uspe
- Real-time monitoring: CPU, RAM, disk (višediskovni), uptime, mrežni saobraćaj, broj procesa — sa live WebSocket ažuriranjem
- Lista top procesa po serveru (klik na broj procesa)
- Izvršavanje skripti paralelno na više servera, sa live output-om
- Zakazano izvršavanje skripti (cron-like scheduler)
- Interaktivni web terminal (xterm.js) — identičan za Linux i Windows (preko SSH)
- Upravljanje SSH ključevima po tenantu

**Hipervizori (Proxmox, Hyper-V, ESXi)**
- Host-nivo monitoring: CPU, RAM, disk, uptime
- Automatska sinhronizacija VM/kontejner inventara (svakih 5 minuta)
- Odvojen prikaz virtuelnih mašina i LXC kontejnera (Proxmox)
- Detekcija guest OS-a: ESXi i Proxmox iz API-ja, Hyper-V preko KVP Exchange podataka (zahteva Integration Services u Linux gostima — vidi `scripts/setup-hyperv-guest.sh`)
- IP adrese VM-ova (zahteva guest agent/integration services u gostu)
- "Dodaj kao server" — direktno kreiranje server unosa iz VM inventara, sa prefilovanim imenom/IP/OS tipom
- "Manage" dugme za Proxmox/ESXi — otvara hipervizor web konzolu u novom tabu

**Dashboard**
- Cross-tenant pregled — prikazuje samo servere sa aktivnim upozorenjem ili offline statusom, preko svih tenanta na koje ulogovani operater ima pristup, grupisano po tenantu
- Per-operator "dismiss" mehanizam — sakrivanje problema važi dok se ne desi sledeća status tranzicija za taj server
- Poslednja izvršavanja skripti i poslednje aktivnosti (audit log), takođe cross-tenant

**Automatizacija i notifikacije**
- Trigger-bazirana automatizacija (pravila na osnovu statusa/metrika, cooldown, istorija)
- Email notifikacije pri promeni statusa, sa označenim metrikama koje su prešle prag
- Slanje izveštaja o izvršavanju skripti mejlom

**Ostalo**
- Audit log svih akcija, sa čitljivim proširenim prikazom i CSV exportom
- Backup/restore baze
- Status debounce (višestruki uzastopni poll pre potvrde promene) — sprečava lažne alarme

## Instalacija

Zahteva Ubuntu 24.04 ili 26.04 LTS.

```bash
git clone https://github.com/<username>/server-manager.git
cd server-manager

# Buildaj frontend
cd frontend
npm install
npm run build
cd ..

# Instaliraj i pokreni
sudo bash install.sh
```

Instalacioni skript podešava: PostgreSQL bazu i šemu, Python virtualenv, PM2, Nginx, UFW firewall, i pokreće aplikaciju.

Default login nakon instalacije: `superadmin` / `ChangeMe123!` — **obavezno promeniti odmah nakon prvog logina**.

## Windows serveri

Za monitoring/izvršavanje skripti na Windows mašini, pokreni na njoj (kao Administrator):

```powershell
scripts\setup-windows-agent.ps1
```

Ova skripta podešava WinRM (za monitoring/skripte) i OpenSSH Server (za interaktivni terminal). Radi na Windows Server 2019+ / Windows 10 1809+ ugrađeno; za Server 2016 automatski instalira Win32-OpenSSH.

## Linux VM-ovi na Hyper-V

Da bi host mogao da pročita IP adresu i OS ime Linux VM-a preko Hyper-V integration servisa, na samoj VM (gostu) pokreni:

```bash
sudo bash scripts/setup-hyperv-guest.sh
```

Detektuje distribuciju, instalira i pokreće potrebne integration daemone (KVP exchange, VSS, FCopy). Restart VM-a je obično potreban da bi se podaci prvi put popunili.

## Struktura projekta

```
backend/
  app/
    main.py            — FastAPI app, lifespan, registracija routera
    config.py          — pydantic-settings, čita /etc/servermanager/.env
    database.py        — asyncpg pool + inet/cidr codec
    routers/           — auth, admin, servers, monitoring, operations, terminal,
                          schedules, alerts, logs, backup, automation, dashboard
    services/           — auth, crypto, ssh, winrm, proxmox, esxi, monitor, executor,
                          terminal, ws_manager, audit, audit_query, automation,
                          backup, notify, scheduler, conn_dispatch

frontend/
  src/
    pages/
      servers/          — Servers, VmList, Terminal, SshKeys, Alerts, Logs
      scripts/           — Scripts, Schedules, Execute
      dashboard/         — Dashboard (cross-tenant problemi), Monitoring
      automation/        — Automation (trigger pravila)
      admin/              — Tenants, Users, SmtpSettings, AdminLogs, Backup
      auth/               — Login
    components/          — layout (Layout, tenant selektor), ui, ProcessListModal
    services/            — api client, websocket
    store/                — Zustand auth store

scripts/
  setup-windows-agent.ps1 — priprema Windows mašine za monitoring/skripte/terminal
  setup-hyperv-guest.sh   — priprema Linux gosta na Hyper-V za IP/OS detekciju
  backup_db.sh            — backup PostgreSQL baze
  restore_db.sh           — restore PostgreSQL baze

install.sh              — kompletna instalacija na čist Ubuntu server
```

## Bezbednosne napomene

- SSH lozinke, sudo lozinke, WinRM lozinke i hipervizor API tokeni/lozinke se čuvaju enkriptovane (AES-256-GCM) u bazi
- WinRM konfiguracija u ovom projektu koristi HTTP + Basic auth, što je prihvatljivo **samo** unutar zatvorene VPN/intranet mreže — ne izlagati port 5985 na internet
- Preporučuje se da servisni SSH nalozi koriste ključeve umesto lozinki gde god je moguće
- Za Proxmox se preporučuje API token (Datacenter → Permissions → API Tokens) umesto lozinke
