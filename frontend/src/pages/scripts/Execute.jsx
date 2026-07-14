// src/pages/scripts/Execute.jsx
import React, { useState, useEffect, useRef } from 'react';
import { Play, CheckCircle, XCircle, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { Spinner, Alert, formatUptime } from '../../components/ui';
import clsx from 'clsx';

const BUILTIN_SCRIPTS = {
  linux: [
    {
      name: 'Sistemski update (apt)',
      content: `#!/bin/bash
set -e
echo "=== APT UPDATE === $(date)"
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get autoremove -y
echo "=== GOTOVO: $(date) ==="`,
    },
    {
      name: 'Status servisa (systemd)',
      content: `#!/bin/bash
systemctl list-units --type=service --state=running --no-pager`,
    },
    {
      name: 'Disk upotreba',
      content: `#!/bin/bash
df -h
echo ""
sudo du -sh /var/log /var/cache /tmp 2>/dev/null || du -sh /var/log /var/cache /tmp 2>/dev/null`,
    },
    {
      name: 'Aktivne konekcije',
      content: `#!/bin/bash
ss -tulnp
echo ""
ss -s`,
    },
    {
      name: 'Poslednje greške (journal)',
      content: `#!/bin/bash
sudo journalctl -n 50 --no-pager -p err`,
    },
    {
      name: 'Restart Nginx',
      content: `#!/bin/bash
sudo systemctl restart nginx
echo "Nginx restartan: $(date)"
sudo systemctl status nginx --no-pager | head -10`,
    },
    {
      name: 'Restart Apache',
      content: `#!/bin/bash
sudo systemctl restart apache2
echo "Apache restartan: $(date)"
sudo systemctl status apache2 --no-pager | head -10`,
    },
    {
      name: 'Pregled memorije',
      content: `#!/bin/bash
echo "=== Memorija ==="
free -h
echo ""
echo "=== Top 10 procesa po RAM ==="
ps aux --sort=-%mem | head -11`,
    },
  ],
  windows: [
    {
      name: 'Sistemski update (PowerShell)',
      content: `Install-Module PSWindowsUpdate -Force -ErrorAction SilentlyContinue
Get-WindowsUpdate -Install -AutoReboot:$false -Confirm:$false`,
    },
    {
      name: 'Status servisa',
      content: `Get-Service | Where-Object {$_.Status -eq "Running"} | Sort-Object DisplayName | Format-Table -AutoSize`,
    },
    {
      name: 'Disk upotreba',
      content: `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,
  @{N="Size(GB)";E={[math]::Round($_.Size/1GB,1)}},
  @{N="Free(GB)";E={[math]::Round($_.FreeSpace/1GB,1)}},
  @{N="Used%";E={[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100,0)}} | Format-Table -AutoSize`,
    },
    {
      name: 'Event log greške (24h)',
      content: `Get-EventLog -LogName System -EntryType Error -Newest 20 | Select-Object TimeGenerated,Source,Message | Format-List`,
    },
    {
      name: 'Restart IIS',
      content: `iisreset /restart
Write-Output "IIS restartan: $(Get-Date)"`,
    },
    {
      name: 'Pregled memorije',
      content: [
        '$os = Get-CimInstance Win32_OperatingSystem',
        '$total = [math]::Round($os.TotalVisibleMemorySize/1MB, 2)',
        '$free  = [math]::Round($os.FreePhysicalMemory/1MB, 2)',
        '$used  = [math]::Round($total - $free, 2)',
        'Write-Output "Ukupno: $($total)GB | Zauzeto: $($used)GB | Slobodno: $($free)GB"',
        'Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10 Name,@{N="RAM(MB)";E={[math]::Round($_.WorkingSet/1MB,1)}} | Format-Table -AutoSize',
      ].join('\n'),
    },
  ],
};

function ResultRow({ result }) {
  const [open, setOpen] = useState(false);
  const hasOutput = result.stdout || result.stderr;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div
        className={clsx('flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-800/50 transition-colors',
          hasOutput && 'cursor-pointer')}
        onClick={() => hasOutput && setOpen(o => !o)}>
        {result.status === 'success' ? <CheckCircle size={15} className="text-green-500 flex-shrink-0" />
         : result.status === 'error'  ? <XCircle size={15} className="text-red-500 flex-shrink-0" />
         : result.status === 'running'? <Spinner size={15} className="text-brand-500 flex-shrink-0" />
         : <Clock size={15} className="text-gray-600 flex-shrink-0" />}

        <span className="text-sm font-medium text-gray-200 flex-1">{result.serverName}</span>
        <span className="text-xs text-gray-600">{result.serverIp}</span>
        {result.durationMs && <span className="text-xs text-gray-600">{(result.durationMs / 1000).toFixed(1)}s</span>}
        {result.exitCode !== null && result.exitCode !== undefined && (
          <span className={clsx('text-xs px-1.5 py-0.5 rounded', result.exitCode === 0 ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400')}>
            exit {result.exitCode}
          </span>
        )}
        {hasOutput && (open ? <ChevronDown size={14} className="text-gray-600" /> : <ChevronRight size={14} className="text-gray-600" />)}
      </div>

      {open && hasOutput && (
        <div className="border-t border-gray-800 bg-gray-950">
          {result.stdout && (
            <pre className="text-xs text-green-300 p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="text-xs text-red-300 p-3 border-t border-gray-800 overflow-x-auto whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function Execute() {
  const { activeTenant, hasPerm, accessToken } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canRun    = hasPerm('perm_scripts_run');

  const [servers,  setServers]  = useState([]);
  const [scripts,  setScripts]  = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [osFilter, setOsFilter] = useState('all');
  const [content,  setContent]  = useState('');
  const [scriptName, setScriptName] = useState('Ad-hoc skripta');
  const [running,  setRunning]  = useState(false);
  const [execId,   setExecId]   = useState(null);
  const [results,  setResults]  = useState({});
  const [error,    setError]    = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    if (!tenantId) return;
    Promise.all([
      api.get(`/tenants/${tenantId}/servers`),
      api.get(`/tenants/${tenantId}/scripts`),
    ]).then(([s, sc]) => {
      setServers(s.data);
      setScripts(sc.data);
    });
    if (accessToken) ws.connect(accessToken);
  }, [tenantId]);

  // Live WS rezultati
  useEffect(() => {
    const unsubStart = ws.on('exec_server_start', data => {
      if (data.executionId !== execId) return;
      setResults(prev => ({
        ...prev,
        [data.serverId]: { ...prev[data.serverId], serverName: data.serverName, status: 'running' }
      }));
    });

    const unsubDone = ws.on('exec_server_done', data => {
      if (data.executionId !== execId) return;
      setResults(prev => ({
        ...prev,
        [data.serverId]: {
          serverName: data.serverName, serverIp: prev[data.serverId]?.serverIp,
          status: data.status, exitCode: data.exitCode,
          stdout: data.stdout, stderr: data.stderr, durationMs: data.durationMs,
        }
      }));
      setProgress(p => ({ ...p, done: p.done + 1 }));
    });

    const unsubFinish = ws.on('exec_finished', data => {
      if (data.executionId !== execId) return;
      setRunning(false);
    });

    return () => { unsubStart(); unsubDone(); unsubFinish(); };
  }, [execId]);

  const toggleServer = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const filtered = servers.filter(s => osFilter === 'all' || s.os_type === osFilter);
    setSelected(new Set(filtered.map(s => s.id)));
  };
  const clearAll = () => setSelected(new Set());

  const handleRun = async () => {
    if (!content.trim()) { setError('Skripta je prazna'); return; }
    if (!selected.size)  { setError('Odaberi bar jedan server'); return; }
    setError(''); setRunning(true);

    // Inicijalizuj rezultate
    const initResults = {};
    servers.filter(s => selected.has(s.id)).forEach(s => {
      initResults[s.id] = { serverName: s.name, serverIp: s.ip_address, status: 'pending' };
    });
    setResults(initResults);
    setProgress({ done: 0, total: selected.size });

    try {
      const { data } = await api.post(`/tenants/${tenantId}/execute`, {
        serverIds:     [...selected],
        scriptContent: content,
        scriptName,
      });
      setExecId(data.executionId);
    } catch (err) {
      setError(err.response?.data?.error || 'Greška pri pokretanju');
      setRunning(false);
    }
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (!canRun)   return <div className="text-gray-500 text-sm p-4">Nemaš dozvolu za pokretanje skripti.</div>;

  const filteredServers = servers.filter(s => osFilter === 'all' || s.os_type === osFilter);
  const resultList      = Object.entries(results).map(([id, r]) => ({ id, ...r }));
  const successCount    = resultList.filter(r => r.status === 'success').length;
  const errorCount      = resultList.filter(r => r.status === 'error').length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">Izvršavanje skripti</h1>
        <p className="text-sm text-gray-500">Pokreni skriptu na više servera istovremeno</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Levo: skripta */}
        <div className="space-y-3">
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <label className="label mb-0">Naziv skripte</label>
            </div>
            <input className="input" value={scriptName} onChange={e => setScriptName(e.target.value)} />

            {scripts.length > 0 && (
              <div>
                <label className="label">Učitaj predložak</label>
                <select className="input" onChange={e => {
                  const s = scripts.find(sc => sc.id === e.target.value);
                  if (s) { setContent(s.content); setScriptName(s.name); }
                  e.target.value = '';
                }}>
                  <option value="">— Odaberi predložak —</option>
                  {scripts.map(s => <option key={s.id} value={s.id}>{s.name} ({s.os_type})</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="label">Brzi predlošci</label>
              <div className="flex flex-wrap gap-1.5">
                {[...BUILTIN_SCRIPTS.linux, ...BUILTIN_SCRIPTS.windows].map(s => (
                  <button key={s.name} className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-100 transition-colors"
                    onClick={() => { setContent(s.content); setScriptName(s.name); }}>
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="label">Sadržaj skripte</label>
              <textarea className="input font-mono text-xs h-48 resize-y"
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="#!/bin/bash&#10;echo 'Hello from $(hostname)'" />
            </div>
          </div>

          {error && <Alert type="error" message={error} onClose={() => setError('')} />}

          <button className="btn-primary w-full justify-center py-2.5" onClick={handleRun} disabled={running || !selected.size}>
            {running ? <><Spinner size={16} /> Izvršavam ({progress.done}/{progress.total})...</>
                     : <><Play size={16} /> Pokreni na {selected.size} server{selected.size !== 1 ? 'a' : ''}</>}
          </button>
        </div>

        {/* Desno: odabir servera */}
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-300">Odaberi servere</p>
            <div className="flex gap-1.5">
              <button className="text-xs text-brand-400 hover:text-brand-300" onClick={selectAll}>Sve</button>
              <span className="text-gray-700">·</span>
              <button className="text-xs text-gray-500 hover:text-gray-300" onClick={clearAll}>Ništa</button>
            </div>
          </div>

          <div className="flex gap-1.5">
            {['all','linux','windows'].map(f => (
              <button key={f}
                className={clsx('text-xs px-2.5 py-1 rounded transition-colors', osFilter === f ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700')}
                onClick={() => setOsFilter(f)}>
                {f === 'all' ? 'Svi' : f === 'linux' ? '🐧 Linux' : '🪟 Windows'}
              </button>
            ))}
          </div>

          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {filteredServers.map(s => (
              <label key={s.id}
                className={clsx('flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                  selected.has(s.id) ? 'bg-brand-900/40 border border-brand-700' : 'bg-gray-800/50 border border-transparent hover:bg-gray-800')}>
                <input type="checkbox" className="accent-brand-500"
                  checked={selected.has(s.id)}
                  onChange={() => toggleServer(s.id)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-200">{s.name}</div>
                  <div className="text-xs text-gray-600">{s.ip_address}</div>
                </div>
                <span className={clsx('w-2 h-2 rounded-full flex-shrink-0',
                  s.status === 'online' ? 'bg-green-500' : s.status === 'offline' ? 'bg-red-500' : 'bg-yellow-500')} />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Rezultati */}
      {resultList.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Rezultati izvršavanja</h2>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              {successCount > 0 && <span className="text-green-400">✓ {successCount} uspešno</span>}
              {errorCount   > 0 && <span className="text-red-400">✗ {errorCount} greška</span>}
              {running && <span className="text-brand-400"><Spinner size={12} className="inline mr-1" />U toku...</span>}
            </div>
          </div>

          {running && (
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-brand-500 rounded-full transition-all duration-300"
                   style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          )}

          <div className="space-y-2">
            {resultList.map(r => <ResultRow key={r.id} result={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}
