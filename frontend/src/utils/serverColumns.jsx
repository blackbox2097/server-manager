// src/utils/serverColumns.jsx
// Deljena columns definicija za Servers.jsx i StatusOverview.jsx -- da red
// izgleda IDENTICNO na oba mesta (isti Table komponent, CPU/RAM/Disk kolone
// se poravnavaju). Handleri (navigate, openProcesses, itd.) su OPCIONI --
// kolona koja ih zahteva se izostavlja ako handler nije prosledjen. Npr.
// StatusOverview ne prosledjuje NIJEDAN handler (cross-tenant pregled bez
// akcija) -- klik na ceo red umesto toga prebacuje tenant i navigira.
import React from 'react';
import { Server, ArrowDown, ArrowUp, Cpu, Plug, TerminalSquare, Edit, Trash2, RotateCw, ExternalLink } from 'lucide-react';
import { StatusBadge, Badge, MetricCell, DiskCell, Spinner, formatUptime, formatNetSpeed } from '../components/ui';

export const VIRT_LABELS = {
  none: 'Fizička',
  kvm: 'ProxMox VM',
  vmware: 'ESXi VM',
  microsoft: 'HyperV VM',
  oracle: 'VirtualBox VM',
  xen: 'Xen VM',
  unknown: 'Nepoznato',
};

export const VIRT_COLORS = {
  kvm: 'purple',
  vmware: 'orange',
  microsoft: 'blue',
  oracle: 'gray',
  xen: 'gray',
  unknown: 'gray',
};

export function getServerColumns({
  navigate, openProcesses, handleTest, testing, testResult, restarting,
  openEdit, setDelConfirm, setRestartConfirm,
  canTerminal, canManage,
} = {}) {
  return [
    { key: 'name', label: 'Server', render: s => (
      <div>
        <div className="font-medium text-gray-200 flex items-center gap-2">
          {s.name}
          {s.os_type === 'proxmox' && <Badge color="purple">Proxmox</Badge>}
          {s.os_type === 'hyperv' && <Badge color="blue">Hyper-V</Badge>}
          {s.os_type === 'esxi' && <Badge color="orange">ESXi</Badge>}
          {!['proxmox', 'hyperv', 'esxi'].includes(s.os_type) && s.virt_type && s.virt_type !== 'none' && (
            <Badge color={VIRT_COLORS[s.virt_type] || 'gray'}>{VIRT_LABELS[s.virt_type] || s.virt_type}</Badge>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {s.ip_address} · {s.os_type === 'windows' ? '🪟 Windows' : s.os_type === 'proxmox' ? '🖥️ Hipervizor' : s.os_type === 'hyperv' ? '🖥️ Hipervizor (Hyper-V)' : s.os_type === 'esxi' ? '🖥️ Hipervizor (ESXi)' : '🐧 Linux'}
        </div>
      </div>
    )},
    ...(navigate ? [{
      key: 'vms', label: 'VM', sortable: false, render: s => (
        ['proxmox', 'hyperv', 'esxi'].includes(s.os_type) ? (
          <div className="flex items-center gap-1.5">
            <button className="btn-secondary text-xs py-1 px-2 flex items-center gap-1.5"
              onClick={() => navigate(`/servers/${s.id}/vms?type=vm`)} title="Prikazi VM listu">
              <Server size={12} />
              {s.vm_count ?? 0} VM
            </button>
            {s.os_type === 'proxmox' && (
              <button className="btn-secondary text-xs py-1 px-2 flex items-center gap-1.5"
                onClick={() => navigate(`/servers/${s.id}/vms?type=container`)} title="Prikazi listu kontejnera">
                <Server size={12} />
                {s.container_count ?? 0} LXC
              </button>
            )}
          </div>
        ) : null
      )
    }] : []),
    { key: 'status', label: 'Status',   sortKey: 'status', render: s => <StatusBadge status={s.status} /> },
    { key: 'cpu',    label: 'CPU',       sortValue: s => s.cpu_percent, render: s => <MetricCell value={s.cpu_percent}  label="CPU"  /> },
    { key: 'ram',    label: 'RAM',       sortValue: s => s.ram_percent, render: s => <MetricCell value={s.ram_percent}  label="RAM"  /> },
    { key: 'disk',   label: 'Disk',      sortValue: s => s.disk_percent, render: s => <DiskCell value={s.disk_percent} disks={s.disks} /> },
    { key: 'uptime', label: 'Uptime',    sortValue: s => s.uptime_seconds, render: s => <span className="text-xs text-gray-500">{formatUptime(s.uptime_seconds)}</span> },
    { key: 'net',    label: 'Mreza',     sortable: false, render: s => (
      <div className="text-xs text-gray-500 space-y-0.5">
        <div className="flex items-center gap-1">
          <ArrowDown size={10} className="text-green-500" />
          {formatNetSpeed(s.net_rx_kbps)}
        </div>
        <div className="flex items-center gap-1">
          <ArrowUp size={10} className="text-blue-500" />
          {formatNetSpeed(s.net_tx_kbps)}
        </div>
      </div>
    )},
    ...(openProcesses ? [{
      key: 'procs',  label: 'Procesi',   sortable: false, render: s => (
        s.os_type === 'proxmox' ? null : (
          <button
            className="text-xs text-gray-500 hover:text-brand-400 hover:underline flex items-center gap-1 transition-colors disabled:cursor-not-allowed disabled:no-underline disabled:hover:text-gray-500"
            onClick={() => openProcesses(s)}
            disabled={s.process_count == null}
            title={s.process_count == null ? 'Nema podataka' : 'Prikazi procese'}>
            <Cpu size={11} />
            {s.process_count ?? '—'}
          </button>
        )
      )
    }] : []),
    ...(handleTest ? [{
      key: 'test',   label: 'Konekcija', sortable: false, render: s => (
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs py-1 px-2"
            onClick={() => handleTest(s)} disabled={testing === s.id}>
            {testing === s.id ? <Spinner size={12} /> : <Plug size={12} />}
            <span className="ml-1">Test</span>
          </button>
          {testResult?.[s.id] && (
            <Badge color={testResult[s.id].ok ? 'green' : 'red'}>
              {testResult[s.id].ok ? '✓ OK' : '✗ Fail'}
            </Badge>
          )}
        </div>
      )
    }] : []),
    ...(canTerminal && navigate ? [{
      key: 'terminal', label: '', sortable: false, render: s => (
        s.os_type === 'proxmox' ? null : (
          <button className="btn-ghost py-1 px-2 text-brand-400 hover:text-brand-300"
            onClick={() => navigate(`/servers/${s.id}/terminal`)} title="Otvori terminal">
            <TerminalSquare size={14} />
          </button>
        )
      )
    }] : []),
    ...(canManage ? [{
      key: 'actions', label: '', sortable: false, render: s => (
        <div className="flex items-center gap-1">
          {s.os_type !== 'proxmox' && (
            <button className="btn-ghost py-1 px-2 text-yellow-500 hover:text-yellow-400"
              onClick={() => setRestartConfirm(s)} disabled={restarting === s.id} title="Restartuj server">
              {restarting === s.id ? <Spinner size={14} /> : <RotateCw size={14} />}
            </button>
          )}
          {['proxmox', 'esxi'].includes(s.os_type) && s.hv_api_host && (
            <button className="btn-ghost text-xs py-1 px-2 text-purple-400 hover:text-purple-300 flex items-center"
              onClick={() => window.open(`https://${s.hv_api_host}:${s.hv_api_port || 8006}`, '_blank', 'noopener,noreferrer')}
              title="Otvori management konzolu">
              <ExternalLink size={12} />
              <span className="ml-1">Manage</span>
            </button>
          )}
          <button className="btn-ghost py-1 px-2" onClick={() => openEdit(s)} title="Uredi">
            <Edit size={14} />
          </button>
          <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
            onClick={() => setDelConfirm(s)} title="Obriši">
            <Trash2 size={14} />
          </button>
        </div>
      )
    }] : []),
  ];
}
