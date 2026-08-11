// src/pages/dashboard/Dashboard.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server, Wifi, WifiOff, AlertTriangle, PlayCircle, CheckCircle2,
  XCircle, Loader2, Terminal as TerminalIcon, Mail, FileText, X, Router
} from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { MeterBar, DiskCell, Spinner, formatUptime } from '../../components/ui';
import { LogRow } from '../servers/Logs';

function HostStatusBar() {
  const [now, setNow] = useState(new Date());
  const [host, setHost] = useState(null);

  useEffect(() => {
    const clockTimer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    const fetchHost = () => api.get('/dashboard/host-status').then(r => setHost(r.data)).catch(() => {});
    fetchHost();
    const t = setInterval(fetchHost, 5000);
    return () => clearInterval(t);
  }, []);

  const timeStr = now.toLocaleTimeString('sr-RS');
  const dateStr = now.toLocaleDateString('sr-RS', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="card flex items-center justify-between flex-wrap gap-4 py-3">
      <div>
        <p className="text-2xl font-semibold text-gray-100 tabular-nums">{timeStr}</p>
        <p className="text-xs text-gray-500 capitalize">{dateStr}</p>
      </div>
      {host && (
        <div className="flex items-center gap-4">
          <div className="w-28">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>CPU (app server)</span><span>{Math.round(host.cpuPercent)}%</span>
            </div>
            <MeterBar value={host.cpuPercent} />
          </div>
          <div className="w-28">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>RAM (app server)</span><span>{Math.round(host.ramPercent)}%</span>
            </div>
            <MeterBar value={host.ramPercent} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color = 'text-gray-100' }) {
  return (
    <div className="card flex items-center gap-4">
      <div className="p-2.5 bg-gray-800 rounded-lg">
        <Icon size={20} className={color} />
      </div>
      <div>
        <p className="text-2xl font-semibold text-gray-100">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function ExecStatusBadge({ status }) {
  const map = {
    running:   { cls: 'badge-yellow', label: 'U toku',   Icon: Loader2 },
    done:      { cls: 'badge-green',  label: 'Zavrseno', Icon: CheckCircle2 },
    failed:    { cls: 'badge-red',    label: 'Neuspesno',Icon: XCircle },
    cancelled: { cls: 'badge-gray',   label: 'Otkazano', Icon: XCircle },
  };
  const { cls, label, Icon } = map[status] || map.done;
  return (
    <span className={cls}>
      <Icon size={11} className={`inline-block mr-1 ${status === 'running' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return `pre ${diff}s`;
  if (diff < 3600) return `pre ${Math.floor(diff / 60)}m`;
  if (diff < 86400)return `pre ${Math.floor(diff / 3600)}h`;
  return `pre ${Math.floor(diff / 86400)}d`;
}

export default function Dashboard() {
  const { accessToken, user, hasPerm } = useAuthStore();
  const navigate = useNavigate();

  const [stats,       setStats]       = useState({ total: 0, online: 0, warning: 0, offline: 0, envCounts: {}, osCounts: {} });
  const [problems,    setProblems]    = useState([]);
  const [networkStats,    setNetworkStats]    = useState({ total: 0, online: 0, warning: 0, offline: 0 });
  const [networkProblems, setNetworkProblems] = useState([]);
  const [executions,  setExecutions]  = useState([]);
  const [recentLogs,  setRecentLogs]  = useState([]);
  const [sendingReport, setSendingReport] = useState(null);
  const [dismissing,  setDismissing]  = useState(null);
  const [dismissingDevice, setDismissingDevice] = useState(null);
  const [loading,     setLoading]     = useState(true);

  const canRunScripts = hasPerm('perm_scripts_run');

  const fetchProblems = useCallback(async () => {
    try {
      const { data } = await api.get('/dashboard/problems');
      setProblems(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  const fetchNetworkProblems = useCallback(async () => {
    try {
      const { data } = await api.get('/dashboard/network-problems');
      setNetworkProblems(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [statsRes, probRes, netStatsRes, netProbRes, execRes, logRes] = await Promise.all([
        api.get('/dashboard/stats').catch(() => ({ data: null })),
        api.get('/dashboard/problems').catch(() => ({ data: [] })),
        api.get('/dashboard/network-stats').catch(() => ({ data: null })),
        api.get('/dashboard/network-problems').catch(() => ({ data: [] })),
        api.get('/dashboard/executions?limit=5').catch(() => ({ data: [] })),
        api.get('/dashboard/logs?limit=6').catch(() => ({ data: [] })),
      ]);
      if (statsRes.data) setStats(statsRes.data);
      setProblems(Array.isArray(probRes.data) ? probRes.data : []);
      if (netStatsRes.data) setNetworkStats(netStatsRes.data);
      setNetworkProblems(Array.isArray(netProbRes.data) ? netProbRes.data : []);
      setExecutions(Array.isArray(execRes.data) ? execRes.data : []);
      setRecentLogs(Array.isArray(logRes.data) ? logRes.data : []);
    } catch {}
    setLoading(false);
  }, []);

  const handleDismiss = async (serverId) => {
    setDismissing(serverId);
    const prevProblems = problems;
    setProblems(prev => prev.filter(p => p.id !== serverId)); // optimisticno
    try {
      await api.post(`/dashboard/dismiss/${serverId}`);
    } catch {
      setProblems(prevProblems); // vrati ako je dismiss neuspesan
    } finally {
      setDismissing(null);
    }
  };

  const handleDismissDevice = async (deviceId) => {
    setDismissingDevice(deviceId);
    const prevProblems = networkProblems;
    setNetworkProblems(prev => prev.filter(p => p.id !== deviceId)); // optimisticno
    try {
      await api.post(`/dashboard/dismiss-device/${deviceId}`);
    } catch {
      setNetworkProblems(prevProblems);
    } finally {
      setDismissingDevice(null);
    }
  };

  const handleSendReport = async (execId, tenantId) => {
    setSendingReport(execId);
    try {
      await api.post(`/tenants/${tenantId}/executions/${execId}/send-report`);
    } catch (err) {
      alert(err.response?.data?.detail || 'Slanje izveštaja nije uspelo — proveri da li su podešeni primaoci u sekciji Alarmi');
    } finally {
      setSendingReport(null);
    }
  };

  useEffect(() => {
    fetchAll();

    const unsub = ws.on('metrics', (data) => {
      setProblems(prev => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex(p => p.id === data.serverId);
        if (data.status === 'online') {
          // oporavak — vise nije problem, ukloni ako je bio prikazan
          return idx === -1 ? list : list.filter(p => p.id !== data.serverId);
        }
        if (data.status === 'warning' || data.status === 'offline') {
          if (idx === -1) {
            // nov problem koji lista jos nema (treba nam ime/tenant/itd.) — dovuci ceo spisak
            fetchProblems();
            return list;
          }
          const next = [...list];
          next[idx] = {
            ...next[idx], status: data.status, last_error: data.error || null,
            cpu_percent: data.metrics?.cpu ?? next[idx].cpu_percent,
            ram_percent: data.metrics?.ram ?? next[idx].ram_percent,
            disk_percent: data.metrics?.disk ?? next[idx].disk_percent,
            disks: data.metrics?.disks ?? next[idx].disks,
            uptime_seconds: data.metrics?.uptime ?? next[idx].uptime_seconds,
          };
          return next;
        }
        return list;
      });
    });

    const unsubExec = ws.on('exec_finished', () => {
      api.get('/dashboard/executions?limit=5').then(r => setExecutions(r.data)).catch(() => {});
    });

    const unsubNet = ws.on('network_status', (data) => {
      setNetworkProblems(prev => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex(p => p.id === data.deviceId);
        if (data.status === 'online') {
          return idx === -1 ? list : list.filter(p => p.id !== data.deviceId);
        }
        if (data.status === 'warning' || data.status === 'offline') {
          if (idx === -1) {
            fetchNetworkProblems();
            return list;
          }
          const next = [...list];
          next[idx] = { ...next[idx], status: data.status, last_error: data.error || null };
          return next;
        }
        return list;
      });
    });

    if (accessToken) ws.connect(accessToken);

    return () => { unsub(); unsubExec(); unsubNet(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner size={32} className="text-brand-500" />
    </div>
  );

  if (!user) return null;

  // Grupisanje problema po tenantu, ocuvavajuci redosled sa backend-a
  const groups = [];
  const groupIndex = new Map();
  for (const p of problems) {
    if (!groupIndex.has(p.tenant_id)) {
      groupIndex.set(p.tenant_id, groups.length);
      groups.push({ tenantId: p.tenant_id, tenantName: p.tenant_name, items: [] });
    }
    groups[groupIndex.get(p.tenant_id)].items.push(p);
  }

  // Isto grupisanje za mrezne uredjaje
  const networkGroups = [];
  const networkGroupIndex = new Map();
  for (const p of networkProblems) {
    if (!networkGroupIndex.has(p.tenant_id)) {
      networkGroupIndex.set(p.tenant_id, networkGroups.length);
      networkGroups.push({ tenantId: p.tenant_id, tenantName: p.tenant_name, items: [] });
    }
    networkGroups[networkGroupIndex.get(p.tenant_id)].items.push(p);
  }

  const DEVICE_TYPE_LABELS = { router: 'Ruter', switch: 'Svič', ap: 'Access Point', ups: 'UPS', other: 'Uređaj' };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Pregled infrastrukture — svi tenanti</p>
      </div>

      <HostStatusBar />

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Server}        label="Ukupno servera"  value={stats.total}   />
        <StatCard icon={Wifi}          label="Online"          value={stats.online}   color="text-green-400" />
        <StatCard icon={AlertTriangle} label="Upozorenje"      value={stats.warning}  color="text-yellow-400" />
        <StatCard icon={WifiOff}       label="Offline"         value={stats.offline}  color="text-red-400" />
      </div>

      {/* Okruzenje / OS pregled */}
      {stats.total > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.envCounts).map(([env, count]) => (
            <span key={env} className="badge-gray">
              {env === 'production' ? 'Production' : env === 'staging' ? 'Staging' : 'Dev'}: {count}
            </span>
          ))}
          {Object.entries(stats.osCounts).map(([os, count]) => (
            <span key={os} className="badge-gray">
              {os === 'windows' ? '🪟 Windows' : os === 'proxmox' ? '🖥️ Proxmox' : os === 'hyperv' ? '🖥️ Hyper-V' : os === 'esxi' ? '🖥️ ESXi' : '🐧 Linux'}: {count}
            </span>
          ))}
        </div>
      )}

      {/* Mrezni uredjaji — semafor (isti obrazac kao za servere) */}
      {networkStats.total > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={Router}   label="Ukupno mrežnih uređaja" value={networkStats.total} />
          <StatCard icon={Wifi}     label="Online"     value={networkStats.online}  color="text-green-400" />
          <StatCard icon={AlertTriangle} label="Upozorenje" value={networkStats.warning} color="text-yellow-400" />
          <StatCard icon={WifiOff}  label="Offline"    value={networkStats.offline} color="text-red-400" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Problematicni serveri + Problematicni mrezni uredjaji — jedna ispod druge,
            svaka ogranicene visine sa internim skrolom (deljen prostor umesto da
            server panel raste bez granice) */}
        <div className="lg:col-span-2 space-y-4">
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-medium text-gray-300">Problematični serveri</h2>
          </div>
          {groups.length === 0 ? (
            <div className="py-8 text-center text-gray-600 text-sm flex flex-col items-center gap-2">
              <CheckCircle2 size={24} className="text-green-600" />
              Sve je u redu — nema aktivnih problema
            </div>
          ) : (
            <div className="h-72 overflow-y-auto">
              {groups.map(group => (
                <div key={group.tenantId}>
                  <div className="px-4 py-1.5 bg-gray-900/50 text-[11px] font-medium text-gray-500 uppercase tracking-wider sticky top-0">
                    {group.tenantName}
                  </div>
                  <div className="divide-y divide-gray-800/50">
                    {group.items.map(server => (
                      <div key={server.id} className="flex items-center gap-4 px-4 py-3 hover:bg-gray-800/30 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-200 truncate">{server.name}</span>
                            <span className="text-xs text-gray-600">{server.ip_address}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={server.status === 'offline' ? 'badge-red' : 'badge-yellow'}>
                              <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1" />
                              {server.status === 'offline' ? 'Offline' : 'Upozorenje'}
                            </span>
                            <span className="text-xs text-gray-600">{server.os_type === 'windows' ? '🪟 Windows' : '🐧 Linux'}</span>
                            {server.uptime_seconds != null && server.status !== 'offline' && (
                              <span className="text-xs text-gray-600">↑ {formatUptime(server.uptime_seconds)}</span>
                            )}
                          </div>
                        </div>
                        {server.status !== 'offline' ? (
                          <div className="hidden sm:flex items-center gap-4">
                            {[['CPU', server.cpu_percent], ['RAM', server.ram_percent]].map(([lbl, val]) => (
                              <div key={lbl} className="w-20">
                                <div className="flex justify-between text-xs text-gray-500 mb-1">
                                  <span>{lbl}</span><span>{Math.round(val || 0)}%</span>
                                </div>
                                <MeterBar value={val} />
                              </div>
                            ))}
                            <div className="w-20">
                              <DiskCell value={server.disk_percent} disks={server.disks} />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-600 max-w-[220px] truncate">
                            {server.last_error?.slice(0, 40) || 'Nedostupan'}
                          </span>
                        )}
                        <button
                          className="btn-ghost py-1.5 px-1.5 text-gray-600 hover:text-gray-300 flex-shrink-0"
                          disabled={dismissing === server.id}
                          onClick={() => handleDismiss(server.id)}
                          title="Sakrij (ponovo se pojavljuje pri sledecoj promeni statusa)">
                          {dismissing === server.id ? <Spinner size={14} /> : <X size={14} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-medium text-gray-300">Problematični mrežni uređaji</h2>
          </div>
          {networkGroups.length === 0 ? (
            <div className="py-8 text-center text-gray-600 text-sm flex flex-col items-center gap-2">
              <CheckCircle2 size={24} className="text-green-600" />
              Sve je u redu — nema aktivnih problema
            </div>
          ) : (
            <div className="h-72 overflow-y-auto">
              {networkGroups.map(group => (
                <div key={group.tenantId}>
                  <div className="px-4 py-1.5 bg-gray-900/50 text-[11px] font-medium text-gray-500 uppercase tracking-wider sticky top-0">
                    {group.tenantName}
                  </div>
                  <div className="divide-y divide-gray-800/50">
                    {group.items.map(device => (
                      <div key={device.id} className="flex items-center gap-4 px-4 py-3 hover:bg-gray-800/30 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-200 truncate">{device.name}</span>
                            <span className="text-xs text-gray-600">{device.ip_address}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={device.status === 'offline' ? 'badge-red' : 'badge-yellow'}>
                              <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1" />
                              {device.status === 'offline' ? 'Offline' : 'Upozorenje'}
                            </span>
                            <span className="text-xs text-gray-600">
                              <Router size={10} className="inline -mt-0.5 mr-0.5" />
                              {DEVICE_TYPE_LABELS[device.device_type] || device.device_type}
                            </span>
                            {device.location && <span className="text-xs text-gray-600">📍 {device.location}</span>}
                          </div>
                        </div>
                        <span className="text-xs text-gray-600 max-w-[220px] truncate">
                          {device.last_error?.slice(0, 40) || (device.vendor ? `${device.vendor}${device.model ? ' ' + device.model : ''}` : 'Nedostupan')}
                        </span>
                        <button
                          className="btn-ghost py-1.5 px-1.5 text-gray-600 hover:text-gray-300 flex-shrink-0"
                          disabled={dismissingDevice === device.id}
                          onClick={() => handleDismissDevice(device.id)}
                          title="Sakrij (ponovo se pojavljuje pri sledecoj promeni statusa)">
                          {dismissingDevice === device.id ? <Spinner size={14} /> : <X size={14} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>

        {/* Poslednja izvrsavanja + Poslednje aktivnosti — cross-tenant */}
        <div className="space-y-4">
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
              <TerminalIcon size={14} /> Poslednja izvršavanja
            </h2>
            {canRunScripts && (
              <button className="text-xs text-brand-400 hover:text-brand-300" onClick={() => navigate('/execute')}>
                Pokreni skriptu
              </button>
            )}
          </div>
          {executions.length === 0 ? (
            <div className="py-10 text-center text-gray-600 text-sm px-4">
              <PlayCircle size={24} className="mx-auto mb-2 text-gray-700" />
              Još nema izvršavanja skripti
            </div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {executions.map(exec => (
                <div key={exec.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-200 truncate">{exec.script_name}</span>
                    <ExecStatusBadge status={exec.status} />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="badge-gray text-xs">{exec.tenant_name}</span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-gray-600">
                      {exec.server_count} server{exec.server_count === 1 ? '' : 'a'}
                      {exec.status !== 'running' && (
                        <> · <span className="text-green-500">{exec.success_count} ok</span>
                        {exec.error_count > 0 && <> · <span className="text-red-500">{exec.error_count} greška</span></>}</>
                      )}
                    </span>
                    <span className="text-xs text-gray-600">{timeAgo(exec.started_at)}</span>
                  </div>
                  {exec.started_by_name && (
                    <p className="text-xs text-gray-700 mt-0.5">od {exec.started_by_name}</p>
                  )}
                  {exec.status !== 'running' && (
                    <button
                      className="text-xs text-brand-400 hover:text-brand-300 hover:underline mt-1 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={sendingReport === exec.id}
                      onClick={() => handleSendReport(exec.id, exec.tenant_id)}>
                      {sendingReport === exec.id ? <Loader2 size={11} className="animate-spin" /> : <Mail size={11} />}
                      Pošalji izveštaj mejlom
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Poslednje aktivnosti (audit log) — cross-tenant */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
              <FileText size={14} /> Poslednje aktivnosti
            </h2>
            <button className="text-xs text-brand-400 hover:text-brand-300" onClick={() => navigate('/logs')}>
              Svi logovi
            </button>
          </div>
          {recentLogs.length === 0 ? (
            <div className="py-10 text-center text-gray-600 text-sm px-4">
              <FileText size={24} className="mx-auto mb-2 text-gray-700" />
              Još nema zabeleženih aktivnosti
            </div>
          ) : (
            <div>
              {recentLogs.map(log => <LogRow key={log.id} log={log} showTenant />)}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
