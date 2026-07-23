<#
.SYNOPSIS
    Server Manager -- Windows agent setup skripta

.OPIS
    Podesava Windows masinu da bude potpuno kompatibilna sa Server Manager portalom:
      1. WinRM (Windows Remote Management) -- za monitoring metrika i izvrsavanje skripti
      2. OpenSSH Server + PowerShell kao default shell -- za interaktivni terminal u portalu

    Pokretanje (PowerShell kao Administrator):
      .\setup-windows-agent.ps1

    Napomena: WinRM konfiguracija ovde koristi Basic auth + HTTP (bez enkripcije)
    sto je prihvatljivo SAMO unutar zatvorene VPN/intranet mreze, sto je i
    predvidjeno okruzenje za Server Manager. Ne izlagati port 5985 na internet.
#>

# Provera administratorskih prava
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "GRESKA: Ova skripta mora biti pokrenuta kao Administrator." -ForegroundColor Red
    Write-Host "Desni klik na PowerShell -> 'Run as Administrator', pa ponovo pokreni skriptu." -ForegroundColor Yellow
    exit 1
}

function Write-Step($msg) { Write-Host "[..] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!!] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Server Manager -- Windows Agent Setup" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

$ErrorActionPreference = "Stop"

# =============================================================================
# 1. WinRM -- za monitoring i izvrsavanje skripti
# =============================================================================
Write-Step "Podesavam WinRM servis..."

try {
    winrm quickconfig -quiet -force | Out-Null
    Write-Ok "WinRM quickconfig zavrsen"
} catch {
    Write-Warn "WinRM quickconfig je vec konfigurisan ili je doslo do manjeg upozorenja (nastavljam)"
}

winrm set winrm/config/service/auth '@{Basic="true"}' | Out-Null
winrm set winrm/config/client/auth '@{Basic="true"}'  | Out-Null
winrm set winrm/config/service '@{AllowUnencrypted="true"}' | Out-Null
winrm set winrm/config/winrs '@{MaxMemoryPerShellMB="1024"}' | Out-Null
winrm set winrm/config '@{MaxTimeoutms="1800000"}' | Out-Null
Write-Ok "WinRM auth i limiti podeseni"

Set-Service -Name WinRM -StartupType Automatic
Start-Service WinRM -ErrorAction SilentlyContinue
Write-Ok "WinRM servis pokrenut i podesen na auto-start"

# Firewall pravilo za WinRM (port 5985 HTTP)
$winrmRule = Get-NetFirewallRule -DisplayName "ServerManager-WinRM-HTTP" -ErrorAction SilentlyContinue
if (-not $winrmRule) {
    New-NetFirewallRule -Name "ServerManager-WinRM-HTTP" `
        -DisplayName "ServerManager-WinRM-HTTP" `
        -Direction Inbound -Protocol TCP -LocalPort 5985 -Action Allow | Out-Null
    Write-Ok "Firewall pravilo za WinRM (5985) dodato"
} else {
    Write-Ok "Firewall pravilo za WinRM vec postoji"
}

# =============================================================================
# 2. OpenSSH Server -- za interaktivni terminal
# =============================================================================
Write-Step "Proveravam Windows verziju za OpenSSH instalaciju..."

$osBuild = [System.Environment]::OSVersion.Version.Build
Write-Host "  Windows build: $osBuild"

$sshInstalled = $false

function Install-OpenSSHManual {
    # Rucna instalacija Win32-OpenSSH preko GitHub-a -- koristi se kad ugradjena
    # Windows Capability instalacija ne uspe (cest slucaj u firmenim mrezama gde
    # Windows Update/WSUS ne servira opcione komponente -- greska 0x800f0954)
    Write-Step "Instaliram Win32-OpenSSH rucno (preuzimanje sa GitHub-a)..."

    $sshExisting = Get-Service sshd -ErrorAction SilentlyContinue
    if ($sshExisting) {
        Write-Ok "sshd servis vec postoji na sistemu -- preskacem instalaciju"
        return $true
    }

    $installDir  = "C:\Program Files\OpenSSH"
    $zipPath     = "$env:TEMP\OpenSSH-Win64.zip"
    $downloadUrl = "https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip"

    try {
        Write-Step "Preuzimam Win32-OpenSSH sa GitHub-a..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
        Write-Ok "Preuzimanje zavrseno"

        Write-Step "Raspakujem i instaliram..."
        Expand-Archive -Path $zipPath -DestinationPath "C:\Program Files\" -Force
        Rename-Item -Path "C:\Program Files\OpenSSH-Win64" -NewName "OpenSSH" -ErrorAction SilentlyContinue

        Push-Location $installDir
        & powershell.exe -ExecutionPolicy Bypass -File .\install-sshd.ps1
        Pop-Location

        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Write-Ok "Win32-OpenSSH instaliran"
        return $true
    } catch {
        Write-Warn "Automatsko preuzimanje nije uspelo (verovatno nema internet pristupa na ovoj masini)."
        Write-Warn "Greska: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "  RUCNA INSTALACIJA (na masini sa internet pristupom):" -ForegroundColor Yellow
        Write-Host "  1. Preuzmi: https://github.com/PowerShell/Win32-OpenSSH/releases/latest"
        Write-Host "     (fajl OpenSSH-Win64.zip)"
        Write-Host "  2. Prebaci zip na ovu masinu (USB, mrezni deljeni folder, itd.)"
        Write-Host "  3. Raspakuj u C:\Program Files\OpenSSH\"
        Write-Host "  4. Pokreni kao Administrator:"
        Write-Host "     cd 'C:\Program Files\OpenSSH'"
        Write-Host "     .\install-sshd.ps1"
        Write-Host "  5. Pokreni ovu skriptu ponovo da zavrsi podesavanje (firewall, default shell)"
        Write-Host ""
        return $false
    }
}

if ($osBuild -ge 17763) {
    # Windows Server 2019+ / Windows 10 1809+ -- pokusaj prvo ugradjenu komponentu
    Write-Step "Koristim ugradjenu Windows Capability za OpenSSH..."

    $sshCapability = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'

    if ($sshCapability -and $sshCapability.State -eq "Installed") {
        Write-Ok "OpenSSH Server je vec instaliran"
        $sshInstalled = $true
    } elseif ($sshCapability) {
        Write-Step "Instaliram OpenSSH Server (moze potrajati par minuta)..."
        try {
            Add-WindowsCapability -Online -Name $sshCapability.Name -ErrorAction Stop | Out-Null
            Write-Ok "OpenSSH Server instaliran (ugradjena komponenta)"
            $sshInstalled = $true
        } catch {
            Write-Warn "Ugradjena instalacija nije uspela: $($_.Exception.Message)"
            Write-Warn "Ovo je cest slucaj kad Windows Update / WSUS ne servira opcione komponente."
            Write-Warn "Prelazim na rucnu instalaciju..."
            $sshInstalled = Install-OpenSSHManual
        }
    } else {
        Write-Warn "OpenSSH.Server capability nije pronadjena -- prelazim na rucnu instalaciju..."
        $sshInstalled = Install-OpenSSHManual
    }
} else {
    # Windows Server 2016 / starije verzije -- nema ugradjenu komponentu uopste
    Write-Warn "Ovaj Windows build ($osBuild) nema ugradjenu OpenSSH komponentu (potreban build 17763+)."
    $sshInstalled = Install-OpenSSHManual
}

if ($sshInstalled) {
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd -ErrorAction SilentlyContinue
    Write-Ok "sshd servis pokrenut i podesen na auto-start"

    # Firewall pravilo za SSH (port 22)
    $sshRule = Get-NetFirewallRule -Name "sshd" -ErrorAction SilentlyContinue
    if (-not $sshRule) {
        New-NetFirewallRule -Name "sshd" -DisplayName "OpenSSH Server (sshd)" `
            -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
        Write-Ok "Firewall pravilo za SSH (22) dodato"
    } else {
        Write-Ok "Firewall pravilo za SSH vec postoji"
    }

    # Podesi PowerShell kao default shell za SSH sesije
    # (bez ovoga, SSH bi otvarao cmd.exe umesto PowerShell-a)
    Write-Step "Podesavam PowerShell kao default SSH shell..."
    $psPath = (Get-Command powershell.exe).Source
    New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
        -Value $psPath -PropertyType String -Force | Out-Null
    Write-Ok "Default shell podesen na: $psPath"
} else {
    Write-Warn "OpenSSH nije instaliran -- terminal funkcija nece raditi dok se ne instalira rucno (vidi uputstvo iznad)."
}

# =============================================================================
# 3. Provera / test
# =============================================================================
Write-Host ""
Write-Step "Proveravam status servisa..."

$winrmStatus = (Get-Service WinRM).Status
$sshdService = Get-Service sshd -ErrorAction SilentlyContinue
$sshdStatus  = if ($sshdService) { $sshdService.Status } else { "Nije instaliran" }

Write-Host ""
Write-Host "  WinRM servis:  $winrmStatus" -ForegroundColor $(if ($winrmStatus -eq "Running") {"Green"} else {"Red"})
Write-Host "  sshd servis:   $sshdStatus"  -ForegroundColor $(if ($sshdStatus  -eq "Running") {"Green"} else {"Red"})

Write-Host ""
Write-Step "Testiram lokalni WinRM listener..."
try {
    $listener = winrm enumerate winrm/config/listener 2>&1
    if ($listener -match "5985") {
        Write-Ok "WinRM listener aktivan na portu 5985"
    } else {
        Write-Warn "WinRM listener nije pronadjen na ocekivanom portu -- proveri rucno: winrm enumerate winrm/config/listener"
    }
} catch {
    Write-Warn "Ne mogu da testiram WinRM listener lokalno"
}

# =============================================================================
# Rezime
# =============================================================================
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" } | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  Podesavanje zavrseno!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  IP adresa ove masine: $ip"
Write-Host ""
Write-Host "  U Server Manager portalu, dodaj server sa:"
Write-Host "    OS tip:        Windows"
Write-Host "    IP adresa:     $ip"
Write-Host ""
Write-Host "    -- Za monitoring / izvrsavanje skripti (WinRM) --"
Write-Host "    WinRM port:    5985"
Write-Host "    WinRM HTTPS:   ne (HTTP)"
Write-Host "    Auth tip:      Lokalni nalog (ili Domenski ako je masina na AD-u)"
Write-Host "    Korisnik:      (lokalni ili domenski nalog sa admin pravima)"
Write-Host ""
Write-Host "    -- Za interaktivni terminal (SSH) --"
Write-Host "    SSH port:      22"
Write-Host "    Korisnik/lozinka: unesi u polje 'SSH konfiguracija' u formi servera"
Write-Host "    (Napomena: SSH i WinRM polja su ODVOJENA u portalu -- popuni oba,"
Write-Host "     mogu koristiti isti nalog ili razlicite, po zelji.)"
Write-Host ""
Write-Host "  VAZNO: Ako menjas lozinku ovog naloga, azuriraj je i u portalu." -ForegroundColor Yellow
Write-Host ""
