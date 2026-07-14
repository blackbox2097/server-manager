// src/pages/dashboard/Monitoring.jsx
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { RefreshCw } from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { StatusBadge, MeterBar, Spinner, formatUptime, formatNetSpeed } from '../../components/ui';
import ProcessListModal from '../../components/ProcessListModal';

const COLORS = { cpu: '#6366f1', ram: '#10b981', disk: '#f59e0b' };

export default function Monitoring() {
  const { activeTenant, accessToken } = useAuthStore();
  const tenantId = activeTenant?.id;

  const [servers,  setServers]   = useState([]);
  const [selected, setSelected]  = useState(null);
  const [history,  setHistory]   = useState([]);
  const [loading,  setLoading]   = useState(true);
  const [polling,  setPolling]   = useState(null);
  const [procModalServer, setProcModalServer] = useState(null);

  const fetchLatest = async () => {
    if (!tenantId) return;
    const { data } = await api.get(`/tenants/${tenantId}/monitoring`);
    setServers(data); setLoading(false);
    if (!selected && data.length) setSelected(data[0].id);
  };

  const fetchHistory = async (serverId) => {
    const { data } = await api.get(`/tenants/${tenantId}/monitoring/${serverId}/history?limit=60`);
    setHistory(data.map(m => ({
      t:    new Date(m.collected_at).toLocaleTimeString('sr', { hour: '2-digit', minute: '2-digit' }),
      cpu:  Math.round(m.cpu_percent  || 0),
      ram:  Math.round(m.ram_percent  || 0),
      disk: Math.round(m.disk_percent || 0),
      rx:   Number(m.net_rx_kbps) || 0,
      tx:   Number(m.net_tx_kbps) || 0,
    })));
  };

  useEffect(() => {
    fetchLatest();
    if (accessToken) ws.connect(accessToken);

    const unsub = ws.on('metrics', (data) => {
      if (data.tenantId !== tenantId) return;
      setServers(prev => prev.map(s =>
        s.id === data.serverId ? { ...s, status: data.status, ...data.metrics && {
          cpu_percent:  data.metrics.cpu,
          ram_percent:  data.metrics.ram,
          disk_percent: data.metrics.disk,
          uptime_seconds: data.metrics.uptime,
          net_rx_kbps:  data.metrics.netRxKbps,
          net_tx_kbps:  data.metrics.netTxKbps,
          process_count: data.metrics.processCount,
        }} : s
      ));
    });
    return unsub;
  }, [tenantId, accessToken]);

  useEffect(() => {
    if (selected) fetchHistory(selected);
  }, [selected]);

  const handlePoll = async (serverId) => {
    setPolling(serverId);
    try {
      await api.post(`/tenants/${tenantId}/monitoring/${serverId}/poll`);
      await fetchLatest();
      await fetchHistory(serverId);
    } finally { setPolling(null); }
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  const selServer = servers.find(s => s.id === selected);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">Monitoring</h1>
        <p className="text-sm text-gray-500">Live metrike — osvežava se automatski</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Server lista */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 text-sm font-medium text-gray-400">Serveri</div>
          <div className="divide-y divide-gray-800/50">
            {servers.map(s => (
              <div key={s.id}
                className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selected === s.id ? 'bg-brand-900/30' : 'hover:bg-gray-800/40'}`}
                onClick={() => setSelected(s.id)}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200 truncate">{s.name}</div>
                  <StatusBadge status={s.status} />
                </div>
                <button className="text-gray-600 hover:text-gray-300 transition-colors" onClick={e => { e.stopPropagation(); handlePoll(s.id); }}>
                  <RefreshCw size={13} className={polling === s.id ? 'animate-spin' : ''} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Detalji + grafici */}
        <div className="lg:col-span-2 space-y-4">
          {selServer && (
            <>
              {/* Stat kartice */}
              <div className="grid grid-cols-3 gap-3">
                {[['CPU', selServer.cpu_percent], ['RAM', selServer.ram_percent], ['Disk', selServer.disk_percent]].map(([l, v]) => (
                  <div key={l} className="card">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">{l}</span>
                      <span className="text-lg font-semibold text-gray-100">{Math.round(v || 0)}%</span>
                    </div>
                    <MeterBar value={v} />
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">OS</span>
                  <span className="text-xs text-gray-300">{selServer.os_name || '—'}</span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">Uptime</span>
                  <span className="text-xs text-gray-300">{formatUptime(selServer.uptime_seconds)}</span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">Mreza (down / up)</span>
                  <span className="text-xs text-gray-300">
                    {formatNetSpeed(selServer.net_rx_kbps)} / {formatNetSpeed(selServer.net_tx_kbps)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Aktivni procesi</span>
                  <button
                    className="text-xs text-brand-400 hover:text-brand-300 hover:underline font-medium disabled:cursor-not-allowed disabled:no-underline disabled:text-gray-300"
                    onClick={() => setProcModalServer(selServer)}
                    disabled={selServer.process_count == null}
                    title={selServer.process_count == null ? 'Nema podataka' : 'Prikazi procese'}>
                    {selServer.process_count ?? '—'}
                  </button>
                </div>
              </div>

              {/* Grafik CPU/RAM/Disk */}
              {history.length > 1 && (
                <div className="card">
                  <p className="text-xs font-medium text-gray-500 mb-3">Istorija metrika — {selServer.name}</p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={history}>
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#6b7280' }} interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#6b7280' }} />
                      <Tooltip
                        formatter={(v, name) => [`${v}%`, name.toUpperCase()]}
                        contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {Object.entries(COLORS).map(([key, color]) => (
                        <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Grafik mrezni saobracaj */}
              {history.length > 1 && (
                <div className="card">
                  <p className="text-xs font-medium text-gray-500 mb-3">Mrezni saobracaj (KB/s) — {selServer.name}</p>
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={history}>
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#6b7280' }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                      <Tooltip
                        formatter={(v, name) => [`${v} KB/s`, name === 'rx' ? 'Download' : 'Upload']}
                        contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 12 }}
                        formatter={v => v === 'rx' ? 'Download' : 'Upload'}
                      />
                      <Line type="monotone" dataKey="rx" stroke="#22c55e" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="tx" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ProcessListModal
        server={procModalServer}
        tenantId={tenantId}
        onClose={() => setProcModalServer(null)}
      />
    </div>
  );
}
