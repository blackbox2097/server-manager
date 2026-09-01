// src/utils/networkDeviceColumns.jsx
// Deljena columns definicija za NetworkDevices.jsx i StatusOverview.jsx,
// po istom obrascu kao serverColumns.jsx. Handleri su OPCIONI -- kolona
// koja ih zahteva se izostavlja ako handler nije prosledjen. NetworkDevices.jsx
// zadrzava svoju custom tabelu (grupisanje po lokaciji + expand red za
// interfejse -- Table komponenta ne podrzava expand redove), ali renderuje
// celije preko ovih istih definicija. StatusOverview.jsx (cross-tenant, bez
// expand-a) koristi <Table> direktno sa getNetworkDeviceColumns({}).
import React from 'react';
import { ChevronRight, ChevronDown, Router, Edit, Trash2, Plug } from 'lucide-react';
import { StatusBadge, Badge, Spinner, formatUptimeFull } from '../components/ui';

export const DEVICE_TYPES = [
  { value: 'router',  label: 'Ruter' },
  { value: 'switch',  label: 'Svic' },
  { value: 'ap',      label: 'Access Point' },
  { value: 'ups',     label: 'UPS' },
  { value: 'other',   label: 'Ostalo' },
];

function deviceTypeLabel(type) {
  return DEVICE_TYPES.find(t => t.value === type)?.label || type;
}

export function getNetworkDeviceColumns({
  expanded, toggleExpand,
  testing, handleTest,
  canManage, openEdit, setDelConfirm,
} = {}) {
  return [
    ...(toggleExpand ? [{
      key: 'expand', label: '', sortable: false, render: d => (
        expanded?.has(d.id) ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />
      )
    }] : []),
    { key: 'name', label: 'Naziv', render: d => (
      <div>
        <div className="font-medium flex items-center gap-2 text-gray-200"><Router size={14} className="text-gray-500" />{d.name}</div>
        <div className="text-xs text-gray-500">{d.ip_address}</div>
      </div>
    )},
    { key: 'device_type', label: 'Tip', sortValue: d => deviceTypeLabel(d.device_type), render: d => (
      <Badge color="blue">{deviceTypeLabel(d.device_type)}</Badge>
    )},
    { key: 'vendor', label: 'Uređaj', sortable: false, render: d => (
      d.vendor || d.model ? (
        <div>
          {d.vendor && <span>{d.vendor}</span>}
          {d.model && <div className="text-xs text-gray-500">{d.model}</div>}
        </div>
      ) : '—'
    )},
    { key: 'status', label: 'Status', sortKey: 'status', render: d => <StatusBadge status={d.status} /> },
    { key: 'uptime', label: 'Uptime', sortValue: d => d.sys_uptime_ticks, render: d => (
      <span className="text-xs text-gray-500">{formatUptimeFull(d.sys_uptime_ticks != null ? d.sys_uptime_ticks / 100 : null)}</span>
    )},
    { key: 'interface_count', label: 'Interfejsi', sortValue: d => d.interface_count, render: d => d.interface_count },
    { key: 'poll_interval_sec', label: 'Interval', sortValue: d => d.poll_interval_sec, render: d => `${d.poll_interval_sec}s` },
    ...(handleTest || canManage ? [{
      key: 'actions', label: '', sortable: false, render: d => (
        <div className="flex gap-1 justify-end" onClick={e => e.stopPropagation()}>
          {handleTest && (
            <button className="icon-btn" title="Testiraj" disabled={testing === d.id} onClick={() => handleTest(d)}>
              {testing === d.id ? <Spinner size={14} /> : <Plug size={14} />}
            </button>
          )}
          {canManage && <>
            <button className="icon-btn" title="Izmeni" onClick={() => openEdit(d)}><Edit size={14} /></button>
            <button className="icon-btn text-red-400" title="Obriši" onClick={() => setDelConfirm(d)}><Trash2 size={14} /></button>
          </>}
        </div>
      )
    }] : []),
  ];
}
