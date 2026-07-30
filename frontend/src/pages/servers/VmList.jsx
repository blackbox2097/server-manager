// src/pages/servers/VmList.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Server, Plus } from 'lucide-react';
import useAuthStore from '../../store/authStore';
import api from '../../services/api';
import { Table, Spinner, Empty } from '../../components/ui';

function formatMb(mb) {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const POWER_LABELS = {
  running: 'Aktivan',
  stopped: 'Zaustavljen',
  paused: 'Pauziran',
  unknown: 'Nepoznato',
};

export default function VmList() {
  const { serverId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const vmType = searchParams.get('type'); // 'vm' | 'container' | null (sve)
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_servers_manage');

  // Ako operater promeni tenant dok je na VM listi, server sa ove stranice
  // ne pripada novom tenantu -- vrati na listu servera umesto greske.
  const initialTenantId = useRef(tenantId);
  useEffect(() => {
    if (tenantId !== initialTenantId.current) {
      navigate('/servers');
    }
  }, [tenantId, navigate]);

  const handleAddAsServer = (vm) => {
    const params = new URLSearchParams();
    params.set('addName', vm.name);
    if (vm.ip_address) params.set('addIp', vm.ip_address);
    if (vm.guest_os) params.set('addOs', vm.guest_os);
    navigate(`/servers?${params.toString()}`);
  };

  const [hypervisorName, setHypervisorName] = useState('');
  const [vms, setVms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchVms = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/tenants/${tenantId}/servers/${serverId}/vms`, {
        params: vmType ? { vm_type: vmType } : {},
      });
      setHypervisorName(data.hypervisorName);
      setVms(data.vms);
      setError('');
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri učitavanju liste');
    } finally {
      setLoading(false);
    }
  }, [tenantId, serverId, vmType]);

  useEffect(() => { fetchVms(); }, [fetchVms]);

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button className="btn-ghost py-1.5 px-2 flex-shrink-0" onClick={() => navigate('/servers')}>
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-100 truncate">
              {vmType === 'container' ? 'Kontejneri' : vmType === 'vm' ? 'Virtuelne mašine' : 'Virtuelne mašine'} {hypervisorName && `— ${hypervisorName}`}
            </h1>
            <p className="text-xs text-gray-500">
              {vms.length} {vmType === 'container' ? 'kontejnera' : vmType === 'vm' ? 'VM' : 'VM/kontejnera'}
            </p>
          </div>
        </div>
        <button className="btn-ghost py-1.5 px-2" onClick={fetchVms} title="Osveži" disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>
      ) : error ? (
        <div className="text-red-400 text-sm p-4">{error}</div>
      ) : vms.length === 0 ? (
        <Empty icon={Server} title={vmType === 'container' ? 'Nema kontejnera' : 'Nema VM-ova'}
          subtitle="Ovaj hipervizor trenutno nema stavki ovog tipa, ili sinhronizacija još nije prošla (osvežava se svakih 5 min)." />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'name', label: 'Naziv', render: v => (
                <div>
                  <div className="font-medium text-gray-200">{v.name}</div>
                  <div className="text-xs text-gray-600">
                    ID: {v.vm_id_on_host}{v.guest_os ? ` · ${v.guest_os}` : ''}
                  </div>
                </div>
              )},
              { key: 'power', label: 'Stanje', sortKey: 'power_state', render: v => (
                <span className={
                  v.power_state === 'running' ? 'text-green-500' :
                  v.power_state === 'stopped' ? 'text-gray-500' : 'text-yellow-500'
                }>
                  {POWER_LABELS[v.power_state] || v.power_state}
                </span>
              )},
              { key: 'cpu', label: 'CPU', sortValue: v => v.cpu_cores, render: v => (
                <span className="text-xs text-gray-400">{v.cpu_cores ?? '—'} jezgara</span>
              )},
              { key: 'ram', label: 'RAM', sortValue: v => v.ram_mb, render: v => (
                <span className="text-xs text-gray-400">{formatMb(v.ram_mb)}</span>
              )},
              { key: 'disk', label: 'Disk', sortValue: v => v.disk_gb, render: v => (
                <span className="text-xs text-gray-400">
                  {v.disk_sizes_gb && v.disk_sizes_gb.length > 1
                    ? v.disk_sizes_gb.map(d => `${d}GB`).join(', ')
                    : (v.disk_gb != null ? `${v.disk_gb} GB` : '—')}
                </span>
              )},
              { key: 'ip', label: 'IP adresa', sortable: false, render: v => (
                <span className="text-xs text-gray-500">{v.ip_address || '—'}</span>
              )},
              ...(canManage ? [{
                key: 'actions', label: '', sortable: false, render: v => (
                  v.linked_server_id ? (
                    <span className="text-xs text-gray-600" title="Već povezan sa serverom">Povezan</span>
                  ) : (
                    <button className="btn-ghost text-xs py-1 px-2 flex items-center gap-1 flex-shrink-0"
                      onClick={() => handleAddAsServer(v)} title="Dodaj kao server">
                      <Plus size={12} />
                      Dodaj kao server
                    </button>
                  )
                )
              }] : []),
            ]}
            rows={vms}
          />
        </div>
      )}
    </div>
  );
}
