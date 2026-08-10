// src/pages/network/NetworkDevices.jsx
import React, { useState, useEffect, useCallback, memo } from 'react';
import { Plus, Edit, Trash2, Plug, Router, ArrowDown, ArrowUp } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import {
  StatusBadge, Badge, Modal, ConfirmDialog,
  Alert, Spinner, Empty, Table, formatNetSpeed,
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

const DeviceForm = memo(function DeviceForm({ deviceRef, tenantId, onSave, onClose }) {
  const device = deviceRef.current;
  const isEdit = !!device?.id;

  const [form, setForm] = useState(() => ({
    name: '', description: '', ipAddress: '', deviceType: 'other', vendor: '',
    snmpPort: 161, snmpVersion: 'v2c', community: '',
    v3Username: '', v3SecurityLevel: 'authPriv', v3AuthProtocol: 'SHA', v3AuthPassword: '',
    v3PrivProtocol: 'AES', v3PrivPassword: '',
    pollIntervalSec: 60, rawRetentionHours: 72, rollupBucketMinutes: 1, rollupRetentionDays: 90,
    ...(isEdit ? {
      name: device.name, description: device.description || '', ipAddress: device.ip_address,
      deviceType: device.device_type, vendor: device.vendor || '',
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

function InterfacesModal({ device, tenantId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!device) return;
    setLoading(true);
    api.get(`/tenants/${tenantId}/network-devices/${device.id}/interfaces`)
       .then(r => setData(r.data))
       .catch(() => setData({ interfaces: [] }))
       .finally(() => setLoading(false));
  }, [device, tenantId]);

  return (
    <Modal open={!!device} onClose={onClose} title={`Interfejsi — ${device?.name || ''}`}>
      {loading ? <Spinner /> : (
        !data?.interfaces?.length ? <Empty title="Nema interfejsa" subtitle="Uređaj još nije uspešno poll-ovan" /> : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {data.interfaces.map(i => (
              <div key={i.id} className="border border-gray-800 rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{i.if_name} <span className="text-gray-500 text-xs">#{i.if_index}</span></div>
                  {i.if_alias && <div className="text-xs text-gray-500">{i.if_alias}</div>}
                  {i.mac_address && <div className="text-xs text-gray-600">{i.mac_address}</div>}
                </div>
                <div className="text-right space-y-1">
                  <StatusBadge status={i.oper_status === 'up' ? 'online' : (i.oper_status === 'down' ? 'offline' : 'unknown')} />
                  {i.last_metric_at && (
                    <div className="text-xs text-gray-500 flex gap-2 justify-end">
                      <span className="flex items-center gap-1"><ArrowDown size={12} />{formatNetSpeed(i.in_kbps)}</span>
                      <span className="flex items-center gap-1"><ArrowUp size={12} />{formatNetSpeed(i.out_kbps)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </Modal>
  );
}

export default function NetworkDevices() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');

  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('Dodaj uređaj');
  const [delConfirm, setDelConfirm] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [ifaceDevice, setIfaceDevice] = useState(null);

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
    }
  };

  const columns = [
    { key: 'name', label: 'Uređaj', render: d => (
      <div>
        <div className="font-medium flex items-center gap-2"><Router size={14} className="text-gray-500" />{d.name}</div>
        <div className="text-xs text-gray-500">{d.ip_address}</div>
      </div>
    )},
    { key: 'device_type', label: 'Tip', render: d => <Badge color="blue">{DEVICE_TYPES.find(t => t.value === d.device_type)?.label || d.device_type}</Badge> },
    { key: 'vendor', label: 'Proizvođač', render: d => d.vendor || '—' },
    { key: 'status', label: 'Status', render: d => <StatusBadge status={d.status} /> },
    { key: 'interface_count', label: 'Interfejsi', render: d => (
      <button className="text-blue-400 hover:underline text-sm" onClick={() => setIfaceDevice(d)}>
        {d.interface_count}
      </button>
    )},
    { key: 'poll_interval_sec', label: 'Interval', render: d => `${d.poll_interval_sec}s` },
    { key: 'actions', label: '', render: d => (
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
    )},
  ];

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold">Mrežni uređaji</h1>
        {canManage && (
          <button className="btn btn-primary" onClick={openAdd}>
            <Plus size={16} /> Dodaj uređaj
          </button>
        )}
      </div>

      {devices.length === 0 ? (
        <Empty icon={Router} title="Nema mrežnih uređaja"
          subtitle="Dodaj ruter, svič ili AP za SNMP monitoring"
          action={canManage && <button className="btn btn-primary" onClick={openAdd}><Plus size={16} /> Dodaj uređaj</button>} />
      ) : (
        <Table columns={columns} rows={devices} />
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={modalTitle}>
        <DeviceForm deviceRef={editDeviceRef} tenantId={tenantId} onSave={handleSaved} onClose={() => setModalOpen(false)} />
      </Modal>

      <InterfacesModal device={ifaceDevice} tenantId={tenantId} onClose={() => setIfaceDevice(null)} />

      <ConfirmDialog open={!!delConfirm} title="Obriši uređaj"
        message={`Da li si siguran da želiš da obrišeš "${delConfirm?.name}"?`}
        onConfirm={handleDelete} onCancel={() => setDelConfirm(null)} danger />
    </div>
  );
}
