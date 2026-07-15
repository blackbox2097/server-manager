// src/pages/dashboard/Dashboard.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server, Wifi, WifiOff, AlertTriangle, PlayCircle,
  CheckCircle2, XCircle, Loader2, Terminal as TerminalIcon
} from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { StatusBadge, MeterBar, Spinner, formatUptime } from '../../components/ui';

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

// Redosled prioriteta pri sortiranju servera — problemi na vrhu
const STATUS_PRIORITY = { offline: 0, warning: 1, unknown: 2, online: 3 };

export default function Dashboard() {
  const { activeTenant, accessToken, user, hasPerm } = useAuthStore();
  const navigate = useNavigate();

  const [servers,    setServers]    = useState([]);
  const [executions, setExecutions] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [liveData,   setLiveData]   = useState({});  // serverId -> latest metrics

  const tenantId = activeTenant?.id || (user?.role === 'superadmin' ? '__admin__' : null);
  const canRunScripts = hasPerm('perm_scripts_run');

  const fetchData = useCallback(async () => {
    if (!tenantId || tenantId === '__admin__') { setLoading(false); return; }
    try {
      const [monRes, execRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/monitoring`),
        api.get(`/tenants/${tenantId}/executions?limit=5`).catch(() => ({ data: [] })),
      ]);
      setServers(monRes.data);
      setExecutions(execRes.data);

      const init = {};
      monRes.data.forEach(s => {
        if (s.cpu_percent != null) {
          init[s.id] = { cpu: s.cpu_percent, ram: s.ram_percent, disk: s.disk_percent, uptime: s.uptime_seconds };
        }
      });
      setLiveData(init);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    fetchData();

    const unsub = ws.on('metrics', (data) => {
      if (data.tenantId !== tenantId) return;
      setServers(prev => prev.map(s =>
        s.id === data.serverId ? { ...s, status: data.status, last_seen_at: new Date().toISOString() } : s
      ));
      if (data.metrics) {
        setLiveData(prev => ({ ...prev, [data.serverId]: data.metrics }));
      }
    });

    const unsubExec = ws.on('exec_finished', (data) => {
      if (data.tenantId !== tenantId) return;
      fetchData();
    });

    if (accessToken) ws.connect(accessToken);

    return () => { unsub(); unsubExec(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, accessToken]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner size={32} className="text-brand-500" />
    </div>
  );

  if (!activeTenant && user?.role !== 'superadmin') return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <Server size={40} className="text-gray-700 mb-3" />
      <p className="text-gray-400">Nemaš dodeljenih tenanata.</p>
      <p className="text-sm text-gray-600 mt-1">Kontaktiraj superadmina.</p>
    </div>
  );

  const online  = servers.filter(s => s.status === 'online').length;
  const warning = servers.filter(s => s.status === 'warning').length;
  const offline = servers.filter(s => s.status === 'offline').length;
  const total   = servers.length;

  // Serveri sa problemima na vrhu liste
  const sortedServers = [...servers].sort((a, b) =>
    (STATUS_PRIORITY[a.status] ?? 2) - (STATUS_PRIORITY[b.status] ?? 2)
  );

  // Pregled po okruzenju i OS-u
  const envCounts = servers.reduce((acc, s) => {
    acc[s.environment] = (acc[s.environment] || 0) + 1;
    return acc;
  }, {});
  const osCounts = servers.reduce((acc, s) => {
    acc[s.os_type] = (acc[s.os_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">
          {activeTenant?.name || 'Dashboard'}
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Pregled infrastrukture</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Server}        label="Ukupno servera"  value={total}   />
        <StatCard icon={Wifi}          label="Online"          value={online}   color="text-green-400" />
        <StatCard icon={AlertTriangle} label="Upozorenje"      value={warning}  color="text-yellow-400" />
        <StatCard icon={WifiOff}       label="Offline"         value={offline}  color="text-red-400" />
      </div>

      {/* Okruzenje / OS pregled */}
      {total > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(envCounts).map(([env, count]) => (
            <span key={env} className="badge-gray">
              {env === 'production' ? 'Production' : env === 'staging' ? 'Staging' : 'Dev'}: {count}
            </span>
          ))}
          {Object.entries(osCounts).map(([os, count]) => (
            <span key={os} className="badge-gray">
              {os === 'windows' ? '🪟 Windows' : '🐧 Linux'}: {count}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Server lista — problemi na vrhu */}
        <div className="lg:col-span-2 card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-medium text-gray-300">Serveri</h2>
          </div>
          {sortedServers.length === 0 ? (
            <div className="py-12 text-center text-gray-600 text-sm">Nema servera u ovom tenantu</div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {sortedServers.map(server => {
                const live = liveData[server.id];
                return (
                  <div key={server.id} className="flex items-center gap-4 px-4 py-3 hover:bg-gray-800/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">{server.name}</span>
                        <span className="text-xs text-gray-600">{server.ip_address}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <StatusBadge status={server.status} />
                        <span className="text-xs text-gray-600">{server.os_type === 'windows' ? '🪟 Windows' : '🐧 Linux'}</span>
                        {live?.uptime && <span className="text-xs text-gray-600">↑ {formatUptime(live.uptime)}</span>}
                      </div>
                    </div>
                    {live && server.status !== 'offline' && (
                      <div className="hidden sm:flex items-center gap-4">
                        {[['CPU', live.cpu], ['RAM', live.ram], ['Disk', live.disk]].map(([lbl, val]) => (
                          <div key={lbl} className="w-20">
                            <div className="flex justify-between text-xs text-gray-500 mb-1">
                              <span>{lbl}</span><span>{Math.round(val || 0)}%</span>
                            </div>
                            <MeterBar value={val} />
                          </div>
                        ))}
                      </div>
                    )}
                    {server.status === 'offline' && (
                      <span className="text-xs text-gray-600 hidden sm:block">
                        {server.last_error?.slice(0, 40) || 'Nedostupan'}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Poslednja izvrsavanja skripti */}
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
