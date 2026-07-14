// src/pages/dashboard/Dashboard.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { Server, Wifi, WifiOff, AlertTriangle, Activity } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
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

export default function Dashboard() {
  const { activeTenant, accessToken, user } = useAuthStore();
  const [servers, setServers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [liveData, setLiveData] = useState({});  // serverId -> latest metrics
  const [history, setHistory]   = useState([]);  // sparkline tačke

  const tenantId = activeTenant?.id || (user?.role === 'superadmin' ? '__admin__' : null);

  const fetchData = useCallback(async () => {
    if (!tenantId || tenantId === '__admin__') { setLoading(false); return; }
    try {
      const { data } = await api.get(`/tenants/${tenantId}/monitoring`);
      setServers(data);
      const init = {};
      data.forEach(s => {
        if (s.cpu_percent != null) {
          init[s.id] = { cpu: s.cpu_percent, ram: s.ram_percent, disk: s.disk_percent };
        }
      });
      setLiveData(init);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    fetchData();

    // Live WebSocket updates
    const unsub = ws.on('metrics', (data) => {
      if (data.tenantId !== tenantId) return;
      setServers(prev => prev.map(s =>
        s.id === data.serverId ? { ...s, status: data.status, last_seen_at: new Date().toISOString() } : s
      ));
      if (data.metrics) {
        setLiveData(prev => ({ ...prev, [data.serverId]: data.metrics }));
        setHistory(prev => {
          const next = [...prev, { t: Date.now(), cpu: data.metrics.cpu }].slice(-30);
          return next;
        });
      }
    });

    // WebSocket konekcija
    if (accessToken) ws.connect(accessToken);

    return unsub;
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

      {/* Sparkline */}
      {history.length > 2 && (
        <div className="card">
          <p className="text-xs font-medium text-gray-500 mb-3 flex items-center gap-2">
            <Activity size={14} /> Prosečan CPU — poslednjih 30 merenja
          </p>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={history}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[0, 100]} hide />
              <Tooltip
                formatter={v => [`${Math.round(v)}%`, 'CPU']}
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ display: 'none' }}
              />
              <Line type="monotone" dataKey="cpu" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Server lista */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-300">Serveri</h2>
        </div>
        {servers.length === 0 ? (
          <div className="py-12 text-center text-gray-600 text-sm">Nema servera u ovom tenantu</div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {servers.map(server => {
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
    </div>
  );
}
