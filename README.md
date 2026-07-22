# Server Manager

Multi-tenant platforma za upravljanje serverima (Linux + Windows) u VPN/intranet okruženju — do 200 servera, granularne dozvole po operateru, real-time monitoring, izvršavanje skripti, i interaktivni web terminal.

## Stack

- **Backend:** Python 3.12, FastAPI, Uvicorn
- **Baza:** PostgreSQL (asyncpg)
- **SSH:** Paramiko
- **WinRM:** aiohttp + ručna SOAP implementacija
- **Frontend:** React + Vite + Tailwind CSS, xterm.js (terminal)
- **Auth:** JWT (python-jose) + bcrypt
- **Enkripcija:** AES-256-GCM za lozinke/ključeve u bazi
- **Process manager:** PM2
- **Reverse proxy:** Nginx

## Funkcionalnosti

- Multi-tenant izolacija: superadmin (pristup svemu) + operateri (granularne dozvole po tenantu)
- Linux serveri preko SSH (lozinka, ključ, ili oboje), sa opcionim sudo pristupom
- Windows serveri preko WinRM (monitoring/skripte) i SSH (interaktivni terminal, zahteva OpenSSH na Windows mašini)
- Real-time monitoring: CPU, RAM, disk, uptime, mrežni saobraćaj, broj procesa — sa live WebSocket ažuriranjem
- Lista top procesa po serveru (klik na broj procesa)
- Izvršavanje skripti paralelno na više servera, sa live output-om
- Interaktivni web terminal (xterm.js) — identičan za Linux i Windows (preko SSH)
- Audit log svih akcija

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

## Struktura projekta

```
backend/
  app/
    main.py            — FastAPI app, lifespan, registracija routera
    config.py          — pydantic-settings, čita /etc/servermanager/.env
    database.py        — asyncpg pool + inet/cidr codec
    routers/           — auth, admin, servers, monitoring, operations, terminal
    services/          — auth, crypto, ssh, winrm, monitor, executor, terminal, ws_manager

frontend/
  src/
    pages/              — servers, scripts, admin, dashboard, auth
    components/         — layout, ui, ProcessListModal
    services/           — api client, websocket
    store/              — Zustand auth store

scripts/
  setup-windows-agent.ps1 — priprema Windows mašine za monitoring/skripte/terminal

install.sh              — kompletna instalacija na čist Ubuntu server
```

## Bezbednosne napomene

- SSH lozinke, sudo lozinke i WinRM lozinke se čuvaju enkriptovane (AES-256-GCM) u bazi
- WinRM konfiguracija u ovom projektu koristi HTTP + Basic auth, što je prihvatljivo **samo** unutar zatvorene VPN/intranet mreže — ne izlagati port 5985 na internet
- Preporučuje se da servisni SSH nalozi koriste ključeve umesto lozinki gde god je moguće
