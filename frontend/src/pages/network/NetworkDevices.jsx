// src/pages/network/NetworkDevices.jsx
import React, { useState, useEffect, useCallback, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Edit, Trash2, Plug, Router, ArrowDown, ArrowUp, ChevronRight, ChevronDown, Search, Download } from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import {
  StatusBadge, Badge, Modal, ConfirmDialog,
  Alert, Spinner, Empty, formatNetSpeed, formatUptimeFull, exportToXlsx,
} from '../../components/ui';

function F({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

const DEVICE_TYPES = [
  { value: 'router',  label: 'Ruter' },
  { value: 'switch',  label: 'Svic' },
  { value: 'ap',      label: 'Access Point' },
  { value: 'ups',     label: 'UPS' },
  { value: 'other',   label: 'Ostalo' },
];

const DeviceForm = memo(function DeviceForm({ deviceRef, tenantId, locations, onSave, onClose }) {
  const device = deviceRef.current;
  const isEdit = !!device?.id;

  const [form, setForm] = useState(() => ({
    name: '', description: '', ipAddress: '', deviceType: 'other', vendor: '', model: '', location: '',
    snmpPort: 161, snmpVersion: 'v2c', community: '',
    v3Username: '', v3SecurityLevel: 'authPriv', v3AuthProtocol: 'SHA', v3AuthPassword: '',
    v3PrivProtocol: 'AES', v3PrivPassword: '',
    pollIntervalSec: 60, rawRetentionHours: 72, rollupBucketMinutes: 1, rollupRetentionDays: 90,
    ...(isEdit ? {
      name: device.name, description: device.description || '', ipAddress: device.ip_address,
      deviceType: device.device_type, vendor: device.vendor || '', model: device.model || '', location: device.location || '',
      snmpPort: device.snmp_port, snmpVersion: device.snmp_version,
      pollIntervalSec: device.poll_interval_sec,
    } : {}),
  }));
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name || !form.ipAddress) { setError('Naziv i IP adresa su obavezni'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        community: form.community || undefined,
        v3AuthPassword: form.v3AuthPassword || undefined,
        v3PrivPassword: form.v3PrivPassword || undefined,
      };
      if (isEdit) await api.put(`/tenants/${tenantId}/network-devices/${device.id}`, payload);
      else        await api.post(`/tenants/${tenantId}/network-devices`, payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} onClose={() => setError('')} />}
      <div className="grid grid-cols-2 gap-3">
        <F label="Naziv"><input className="input" value={form.name} onChange={e => set('name', e.target.value)} /></F>
        <F label="IP adresa"><input className="input" value={form.ipAddress} onChange={e => set('ipAddress', e.target.value)} /></F>
      </div>
      <F label="Opis"><input className="input" value={form.description} onChange={e => set('description', e.target.value)} /></F>
      <div className="grid grid-cols-2 gap-3">
        <F label="Tip uređaja">
          <select className="input" value={form.deviceType} onChange={e => set('deviceType', e.target.value)}>
            {DEVICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </F>
        <F label="Proizvođač (opciono)"><input className="input" value={form.vendor} onChange={e => set('vendor', e.target.value)} placeholder="MikroTik, Cisco, Aruba..." /></F>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F label="Model (opciono)"><input className="input" value={form.model} onChange={e => set('model', e.target.value)} placeholder="RB4011, Catalyst 2960..." /></F>
        <F label="Lokacija (opciono)">
          <input className="input" list="location-suggestions" value={form.location}
            onChange={e => set('location', e.target.value)} placeholder="npr. Zemun, Banovci..." />
          <datalist id="location-suggestions">
            {locations.map(loc => <option key={loc} value={loc} />)}
          </datalist>
        </F>
      </div>

      <div className="border border-gray-800 rounded-lg p-3 space-y-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">SNMP konfiguracija</p>
        <div className="grid grid-cols-2 gap-3">
          <F label="Port"><input className="input" type="number" value={form.snmpPort} onChange={e => set('snmpPort', parseInt(e.target.value) || 161)} /></F>
          <F label="Verzija">
            <select className="input" value={form.snmpVersion} onChange={e => set('snmpVersion', e.target.value)}>
              <option value="v2c">v2c</option>
              <option value="v3">v3</option>
            </select>
          </F>
        </div>
        {form.snmpVersion === 'v2c' && (
          <F label="Community string">
            <input className="input" type="password" value={form.community} onChange={e => set('community', e.target.value)}
              placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : 'public'} />
          </F>
        )}
        {form.snmpVersion === 'v3' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <F label="Korisnik"><input className="input" value={form.v3Username} onChange={e => set('v3Username', e.target.value)} /></F>
              <F label="Security level">
                <select className="input" value={form.v3SecurityLevel} onChange={e => set('v3SecurityLevel', e.target.value)}>
                  <option value="noAuthNoPriv">noAuthNoPriv</option>
                  <option value="authNoPriv">authNoPriv</option>
                  <option value="authPriv">authPriv</option>
                </select>
              </F>
            </div>
            {form.v3SecurityLevel !== 'noAuthNoPriv' && (
              <div className="grid grid-cols-2 gap-3">
                <F label="Auth protokol">
                  <select className="input" value={form.v3AuthProtocol} onChange={e => set('v3AuthProtocol', e.target.value)}>
                    <option value="SHA">SHA</option><option value="MD5">MD5</option>
                    <option value="SHA256">SHA256</option><option value="SHA384">SHA384</option><option value="SHA512">SHA512</option>
                  </select>
                </F>
                <F label="Auth lozinka">
                  <input className="input" type="password" value={form.v3AuthPassword} onChange={e => set('v3AuthPassword', e.target.value)}
                    placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : ''} />
                </F>
              </div>
            )}
            {form.v3SecurityLevel === 'authPriv' && (
              <div className="grid grid-cols-2 gap-3">
                <F label="Priv protokol">
                  <select className="input" value={form.v3PrivProtocol} onChange={e => set('v3PrivProtocol', e.target.value)}>
                    <option value="AES">AES128</option><option value="AES192">AES192</option>
                    <option value="AES256">AES256</option><option value="DES">DES</option><option value="3DES">3DES</option>
                  </select>
                </F>
                <F label="Priv lozinka">
                  <input className="input" type="password" value={form.v3PrivPassword} onChange={e => set('v3PrivPassword', e.target.value)}
                    placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : ''} />
                </F>
              </div>
            )}
          </>
        )}
        <F label="Interval osvežavanja (sekunde)">
          <input className="input" type="number" min={10} value={form.pollIntervalSec}
            onChange={e => set('pollIntervalSec', parseInt(e.target.value) || 60)} />
        </F>
      </div>

      <button type="button" className="text-xs text-blue-400 hover:underline"
        onClick={() => setShowAdvanced(v => !v)}>
        {showAdvanced ? 'Sakrij' : 'Prikaži'} napredna retention podešavanja
      </button>
      {showAdvanced && (
        <div className="grid grid-cols-3 gap-3 border border-gray-800 rounded-lg p-3">
          <F label="Raw retention (h)"><input className="input" type="number" value={form.rawRetentionHours}
            onChange={e => set('rawRetentionHours', parseInt(e.target.value) || 72)} /></F>
          <F label="Rollup bucket (min)"><input className="input" type="number" value={form.rollupBucketMinutes}
            onChange={e => set('rollupBucketMinutes', parseInt(e.target.value) || 1)} /></F>
          <F label="Rollup retention (dana)"><input className="input" type="number" value={form.rollupRetentionDays}
            onChange={e => set('rollupRetentionDays', parseInt(e.target.value) || 90)} /></F>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button className="btn btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj izmene' : 'Dodaj uređaj')}
        </button>
      </div>
    </div>
  );
}, () => true);

function InterfaceRow({ iface }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 border-b border-gray-800/30 last:border-b-0">
      <div>
        <div className="text-sm font-medium">{iface.if_name} <span className="text-gray-500 text-xs">#{iface.if_index}</span></div>
        {iface.if_alias && <div className="text-xs text-gray-500">{iface.if_alias}</div>}
        {iface.mac_address && <div className="text-xs text-gray-600">{iface.mac_address}</div>}
      </div>
      <div className="text-right space-y-1">
        <StatusBadge status={iface.oper_status === 'up' ? 'online' : (iface.oper_status === 'down' ? 'offline' : 'unknown')} />
        {iface.last_metric_at && (
          <div className="text-xs text-gray-500 flex gap-2 justify-end">
            <span className="flex items-center gap-1"><ArrowDown size={12} />{formatNetSpeed(iface.in_kbps)}</span>
            <span className="flex items-center gap-1"><ArrowUp size={12} />{formatNetSpeed(iface.out_kbps)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function NetworkDevices() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');

  const [searchParams, setSearchParams] = useSearchParams();
  const [devices, setDevices] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('Dodaj uređaj');
  const [delConfirm, setDelConfirm] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [ifaceCache, setIfaceCache] = useState({});
  const [ifaceLoading, setIfaceLoading] = useState(null);

  const editDeviceRef = React.useRef(null);

  const fetchDevices = useCallback(async () => {
    if (!tenantId) return;
    try {
      const { data } = await api.get(`/tenants/${tenantId}/network-devices`);
      setDevices(data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);
  useEffect(() => {
    const unsub = ws.on('network_status', (data) => {
      setDevices(prev => prev.map(d => d.id !== data.deviceId ? d : {
        ...d, status: data.status, last_error: data.error || null,
      }));
    });
    return unsub;
  }, []);

  const toggleExpand = async (device) => {
    const next = new Set(expanded);
    if (next.has(device.id)) {
      next.delete(device.id);
      setExpanded(next);
      return;
    }
    next.add(device.id);
    setExpanded(next);
    if (!ifaceCache[device.id]) {
      setIfaceLoading(device.id);
      try {
        const { data } = await api.get(`/tenants/${tenantId}/network-devices/${device.id}/interfaces`);
        setIfaceCache(prev => ({ ...prev, [device.id]: data.interfaces }));
      } catch {
        setIfaceCache(prev => ({ ...prev, [device.id]: [] }));
      } finally {
        setIfaceLoading(null);
      }
    }
  };

  const openAdd = () => { editDeviceRef.current = null; setModalTitle('Dodaj uređaj'); setModalOpen(true); };
  const openEdit = (d) => { editDeviceRef.current = d; setModalTitle(`Izmeni — ${d.name}`); setModalOpen(true); };
  const handleSaved = () => { setModalOpen(false); fetchDevices(); };

  const handleDelete = async () => {
    if (!delConfirm) return;
    await api.delete(`/tenants/${tenantId}/network-devices/${delConfirm.id}`);
    setDelConfirm(null); fetchDevices();
  };

  const handleTest = async (device) => {
    setTesting(device.id);
    try {
      const { data } = await api.post(`/tenants/${tenantId}/network-devices/${device.id}/test`);
      setTestResult(prev => ({ ...prev, [device.id]: data }));
    } catch {
      setTestResult(prev => ({ ...prev, [device.id]: { status: 'offline' } }));
    } finally {
      setTesting(null);
      fetchDevices();
      if (expanded.has(device.id)) {
        try {
          const { data } = await api.get(`/tenants/${tenantId}/network-devices/${device.id}/interfaces`);
          setIfaceCache(prev => ({ ...prev, [device.id]: data.interfaces }));
        } catch {}
      } else {
        setIfaceCache(prev => {
          const next = { ...prev };
          delete next[device.id];
          return next;
        });
      }
    }
  };

  const knownLocations = React.useMemo(() => {
    const set = new Set(devices.map(d => d.location).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [devices]);

  const q = searchQuery.trim().toLowerCase();
  const statusFilter = searchParams.get('status') || '';
  const filteredDevices = React.useMemo(() => {
    return devices
      .filter(d => !q || [d.name, d.ip_address, d.vendor, d.model, d.location, d.description]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(q)))
      .filter(d => !statusFilter || d.status === statusFilter);
  }, [devices, q, statusFilter]);

  // Grupisi uredjaje po lokaciji (bez lokacije ide u posebnu grupu na kraju),
  // sortirano abecedno unutar svake grupe po imenu.
  const groupedDevices = React.useMemo(() => {
    const groups = {};
    for (const d of filteredDevices) {
      const key = d.location || '__none__';
      (groups[key] ||= []).push(d);
    }
    const locKeys = Object.keys(groups).filter(k => k !== '__none__').sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const ordered = locKeys.map(k => [k, groups[k]]);
    if (groups.__none__) ordered.push(['Bez lokacije', groups.__none__]);
    for (const [, list] of ordered) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return ordered;
  }, [filteredDevices]);

  const handleExport = async () => {
    const cols = [
      { label: 'Naziv', get: d => d.name },
      { label: 'IP adresa', get: d => d.ip_address },
      { label: 'Tip', get: d => DEVICE_TYPES.find(t => t.value === d.device_type)?.label || d.device_type },
      { label: 'Uređaj (proizvođač)', get: d => d.vendor },
      { label: 'Model', get: d => d.model },
      { label: 'Lokacija', get: d => d.location },
      { label: 'Status', get: d => d.status },
      { label: 'Broj interfejsa', get: d => d.interface_count },
      { label: 'Interval osvežavanja (s)', get: d => d.poll_interval_sec },
    ];
    await exportToXlsx(`mrezni-uredjaji-${activeTenant?.name || 'export'}`, cols, filteredDevices, 'Mrežni uređaji');
  };

  const columns = [
    { key: 'expand', label: '' },
    { key: 'name', label: 'Naziv' },
    { key: 'device_type', label: 'Tip' },
    { key: 'vendor', label: 'Uređaj' },
    { key: 'status', label: 'Status' },
    { key: 'uptime', label: 'Uptime' },
    { key: 'interface_count', label: 'Interfejsi' },
    { key: 'poll_interval_sec', label: 'Interval' },
    { key: 'actions', label: '' },
  ];

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold">Mrežni uređaji</h1>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-sm w-32 flex-shrink-0" value={statusFilter} onChange={e => setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            if (e.target.value) next.set('status', e.target.value); else next.delete('status');
            return next;
          })}>
            <option value="">Svi statusi</option>
            <option value="online">Online</option>
            <option value="warning">Upozorenje</option>
            <option value="offline">Offline</option>
          </select>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input className="input pl-8 py-1.5 text-sm w-48" placeholder="Pretraga..."
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {devices.length > 0 && (
            <button className="btn btn-secondary flex-shrink-0" onClick={handleExport} title="Izvezi u CSV">
              <Download size={16} />
            </button>
          )}
          {canManage && (
            <button className="btn btn-primary flex-shrink-0 whitespace-nowrap" onClick={openAdd}>
              <Plus size={16} /> Dodaj uređaj
            </button>
          )}
        </div>
      </div>

      {devices.length === 0 ? (
        <Empty icon={Router} title="Nema mrežnih uređaja"
          subtitle="Dodaj ruter, svič ili AP za SNMP monitoring"
          action={canManage && <button className="btn btn-primary" onClick={openAdd}><Plus size={16} /> Dodaj uređaj</button>} />
      ) : filteredDevices.length === 0 ? (
        <Empty icon={Search} title="Nema rezultata" subtitle={q ? `Ništa ne odgovara pretrazi "${searchQuery}"` : 'Nijedan uređaj ne odgovara izabranom filteru'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {columns.map(col => (
                  <th key={col.key} className="text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupedDevices.map(([locName, list]) => (
                <React.Fragment key={locName}>
                  <tr className="bg-gray-900/70">
                    <td colSpan={columns.length} className="py-1.5 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-800">
                      {locName} <span className="text-gray-600 font-normal normal-case">({list.length})</span>
                    </td>
                  </tr>
                  {list.map(d => {
                const isOpen = expanded.has(d.id);
                return (
                  <React.Fragment key={d.id}>
                    <tr className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/50 transition-colors"
                        onClick={() => toggleExpand(d)}>
                      <td className="py-2.5 px-3 text-gray-500 w-6">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">
                        <div className="font-medium flex items-center gap-2"><Router size={14} className="text-gray-500" />{d.name}</div>
                        <div className="text-xs text-gray-500">{d.ip_address}</div>
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">
                        <Badge color="blue">{DEVICE_TYPES.find(t => t.value === d.device_type)?.label || d.device_type}</Badge>
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">
                        {d.vendor || d.model ? (
                          <div>
                            {d.vendor && <span>{d.vendor}</span>}
                            {d.model && <div className="text-xs text-gray-500">{d.model}</div>}
                          </div>
                        ) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-gray-300"><StatusBadge status={d.status} /></td>
                      <td className="py-2.5 px-3 text-gray-300 text-xs">
                        {formatUptimeFull(d.sys_uptime_ticks != null ? d.sys_uptime_ticks / 100 : null)}
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">{d.interface_count}</td>
                      <td className="py-2.5 px-3 text-gray-300">{d.poll_interval_sec}s</td>
                      <td className="py-2.5 px-3 text-gray-300" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 justify-end">
                          <button className="icon-btn" title="Testiraj" disabled={testing === d.id}
                            onClick={() => handleTest(d)}>
                            {testing === d.id ? <Spinner size={14} /> : <Plug size={14} />}
                          </button>
                          {canManage && <>
                            <button className="icon-btn" title="Izmeni" onClick={() => openEdit(d)}><Edit size={14} /></button>
                            <button className="icon-btn text-red-400" title="Obriši" onClick={() => setDelConfirm(d)}><Trash2 size={14} /></button>
                          </>}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-gray-800/50 bg-gray-900/40">
                        <td></td>
                        <td colSpan={columns.length - 1} className="py-2 px-3">
                          {ifaceLoading === d.id ? (
                            <div className="py-3"><Spinner size={14} /></div>
                          ) : !ifaceCache[d.id]?.length ? (
                            <div className="text-xs text-gray-500 py-2">Nema interfejsa — uređaj još nije uspešno poll-ovan</div>
                          ) : (
                            <div className="rounded-lg border border-gray-800 divide-y divide-gray-800/30 overflow-hidden">
                              {ifaceCache[d.id].map(i => <InterfaceRow key={i.id} iface={i} />)}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={modalTitle}>
        <DeviceForm deviceRef={editDeviceRef} tenantId={tenantId} locations={knownLocations} onSave={handleSaved} onClose={() => setModalOpen(false)} />
      </Modal>

      <ConfirmDialog open={!!delConfirm} title="Obriši uređaj"
        message={`Da li si siguran da želiš da obrišeš "${delConfirm?.name}"?`}
        onConfirm={handleDelete} onCancel={() => setDelConfirm(null)} danger />
    </div>
  );
}
