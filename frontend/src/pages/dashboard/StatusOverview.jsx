// src/pages/dashboard/StatusOverview.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Server, Router } from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { StatusBadge, MetricCell, DiskCell, Spinner, Empty, formatUptime } from '../../components/ui';

const STATUS_LABELS = { online: 'online', warning: 'upozorenje', offline: 'offline' };
const DEVICE_TYPE_LABELS = { router: 'Ruter', switch: 'Svič', ap: 'Access Point', ups: 'UPS', other: 'Uređaj' };

function osLabel(osType) {
  return osType === 'windows' ? '🪟 Windows'
    : osType === 'proxmox' ? '🖥️ Proxmox'
    : osType === 'hyperv' ? '🖥️ Hyper-V'
    : osType === 'esxi' ? '🖥️ ESXi'
    : '🐧 Linux';
}

export default function StatusOverview() {
  const { type } = useParams(); // 'servers' | 'network-devices'
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status') || 'warning';
  const navigate = useNavigate();
  const { tenants, setActiveTenant } = useAuthStore();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const isServers = type === 'servers';
  const endpoint = isServers ? '/dashboard/servers-by-status' : '/dashboard/network-devices-by-status';
  const title = isServers ? 'Serveri' : 'Mrežni uređaji';

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`${endpoint}?status=${encodeURIComponent(status)}`);
      setItems(Array.isArray(data) ? data : []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [endpoint, status]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  useEffect(() => {
    if (!isServers) return;
    const unsub = ws.on('metrics', (data) => {
      setItems(prev => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex(it => it.id === data.serverId);
        if (data.status !== status) {
          return idx === -1 ? list : list.filter(it => it.id !== data.serverId);
        }
        if (idx === -1) {
          fetchItems();
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
      });
    });
    return unsub;
  }, [isServers, status, fetchItems]);

  useEffect(() => {
    if (isServers) return;
    const unsub = ws.on('network_status', (data) => {
      setItems(prev => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex(it => it.id === data.deviceId);
        if (data.status !== status) {
          return idx === -1 ? list : list.filter(it => it.id !== data.deviceId);
        }
        if (idx === -1) {
          fetchItems();
          return list;
        }
        const next = [...list];
        next[idx] = { ...next[idx], status: data.status, last_error: data.error || null };
        return next;
      });
    });
    return unsub;
  }, [isServers, status, fetchItems]);

  const groups = [];
  const groupIndex = new Map();
  for (const item of items) {
    if (!groupIndex.has(item.tenant_id)) {
      groupIndex.set(item.tenant_id, groups.length);
      groups.push({ tenantId: item.tenant_id, tenantName: item.tenant_name, items: [] });
    }
    groups[groupIndex.get(item.tenant_id)].items.push(item);
  }

  const handleOpen = (item) => {
    const tenant = tenants.find(t => t.id === item.tenant_id);
    if (tenant) setActiveTenant(tenant);
    navigate(isServers ? '/servers' : '/network-devices');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="btn-ghost py-1.5 px-2 flex-shrink-0" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">
            {title} — {STATUS_LABELS[status] || status}
          </h1>
          <p className="text-xs text-gray-500">
            {items.length} {isServers ? 'servera' : 'uređaja'} preko svih tenanta
          </p>
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>
      ) : items.length === 0 ? (
        <Empty icon={isServers ? Server : Router} title="Nema rezultata"
          subtitle={`Nijedan ${isServers ? 'server' : 'uređaj'} nije u statusu "${STATUS_LABELS[status] || status}"`} />
      ) : (
        <div className="card p-0 overflow-hidden">
          {groups.map(group => (
            <div key={group.tenantId}>
              <div className="px-4 py-1.5 bg-gray-900/50 text-[11px] font-medium text-gray-500 uppercase tracking-wider">
                {group.tenantName}
              </div>
              <div className="divide-y divide-gray-800/50">
                {group.items.map(item => (
                  <div key={item.id} className="flex items-center gap-4 px-4 py-3 hover:bg-gray-800/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">{item.name}</span>
                        <StatusBadge status={item.status} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {item.ip_address} · {isServers ? osLabel(item.os_type) : (DEVICE_TYPE_LABELS[item.device_type] || item.device_type)}
                        {!isServers && item.vendor && ` · ${item.vendor}${item.model ? ' ' + item.model : ''}`}
                        {!isServers && item.location && ` · 📍 ${item.location}`}
                      </div>
                      {item.last_error && (
                        <div className="text-xs text-gray-600 mt-0.5 truncate">{item.last_error}</div>
                      )}
                    </div>
                    {isServers && (
                      <div className="hidden md:flex items-center gap-4 flex-shrink-0">
                        <MetricCell value={item.cpu_percent} label="CPU" />
                        <MetricCell value={item.ram_percent} label="RAM" />
                        <DiskCell value={item.disk_percent} disks={item.disks} />
                        <span className="text-xs text-gray-500 w-20 text-right">{formatUptime(item.uptime_seconds)}</span>
                      </div>
                    )}
                    <button className="btn-secondary flex-shrink-0" onClick={() => handleOpen(item)}>
                      Otvori
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
