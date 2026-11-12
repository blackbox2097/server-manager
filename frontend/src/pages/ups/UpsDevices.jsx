// src/pages/ups/UpsDevices.jsx
// UPS uredjaji -- sopstvena kategorija (odluka 9.11.2026), prva faza NUT izvor.
// Obrazac preslikan iz NetworkDevices.jsx.
import React, { useState, useEffect, useCallback, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, BatteryCharging, Search, RefreshCw, Pencil, Trash2,
  ChevronDown, ChevronRight, PlugZap,
} from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import { Modal, ConfirmDialog, Alert, Spinner, Empty, MeterBar } from '../../components/ui';

export const UPS_STATUS = {
  online:      { cls: 'badge-green',  label: 'Online' },
  on_battery:  { cls: 'badge-orange', label: 'Na bateriji' },
  low_battery: { cls: 'badge-red',    label: 'Prazna baterija' },
  warning:     { cls: 'badge-yellow', label: 'Upozorenje' },
  offline:     { cls: 'badge-red',    label: 'Offline' },
  unknown:     { cls: 'badge-gray',   label: 'Nepoznato' },
};

export function UpsStatusBadge({ status }) {
  const { cls, label } = UPS_STATUS[status] || UPS_STATUS.unknown;
  return (
    <span className={cls}>
      <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1" />
      {label}
    </span>
  );
}

function F({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const fmt = (v, unit, digits = 0) => {
  const n = num(v);
  return n === null || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}${unit}`;
};
function fmtRuntime(sec) {
  const n = num(sec);
  if (n === null) return '—';
  const m = Math.round(n / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
}

// Isti izgled kao MeterBar (meter-bar/meter-fill), ali OBRNUTE boje:
// kod baterije je visoka vrednost dobra, niska losa.
function BatteryBar({ value }) {
  const color = value < 20 ? 'bg-red-500' : value < 50 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="meter-bar">
      <div className={`meter-fill ${color}`} style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }} />
    </div>
  );
}

const SOURCE_DEFAULTS = {
  nut:       { port: 3493,  deviceName: 'ups' },
  viewpower: { port: 15178, deviceName: '' },
};

const UpsForm = memo(function UpsForm({ upsRef, tenantId, onSave, onClose }) {
  const ups = upsRef.current;
  const isEdit = !!ups?.id;

  const [form, setForm] = useState(() => ({
    name: '', description: '', location: '', source: 'nut', host: '', port: 3493, deviceName: 'ups',
    username: '', password: '',
    pollIntervalSec: 60, rawRetentionHours: 72, rollupBucketMinutes: 5, rollupRetentionDays: 90,
    ...(isEdit ? {
      name: ups.name, description: ups.description || '', location: ups.location || '',
      source: ups.source || 'nut', host: ups.host, port: ups.port, deviceName: ups.device_name,
      username: ups.username || '',
      pollIntervalSec: ups.poll_interval_sec,
      rawRetentionHours: ups.raw_retention_hours ?? 72,
      rollupBucketMinutes: ups.rollup_bucket_minutes ?? 5,
      rollupRetentionDays: ups.rollup_retention_days ?? 90,
    } : {}),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState(null);
  const [discoverList, setDiscoverList] = useState([]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isVP = form.source === 'viewpower';
  // Promena izvora menja default-e SAMO ako korisnik nije sam uneo drugu vrednost
  const changeSource = (src) => {
    setTestRes(null);
    setDiscoverMsg(null);
    setDiscoverList([]);
    setForm(f => {
      const prev = SOURCE_DEFAULTS[f.source] || SOURCE_DEFAULTS.nut;
      const next = SOURCE_DEFAULTS[src];
      return {
        ...f, source: src,
        port: f.port === prev.port ? next.port : f.port,
        deviceName: f.deviceName === prev.deviceName ? next.deviceName : f.deviceName,
      };
    });
  };

  const handleDiscover = async () => {
    if (!form.host) { setDiscoverMsg({ error: true, text: 'Prvo unesi IP ViewPower računara' }); return; }
    setDiscovering(true); setDiscoverMsg(null); setDiscoverList([]);
    try {
      const { data } = await api.post(`/tenants/${tenantId}/ups/discover`,
        { source: form.source, host: form.host, port: form.port });
      const devs = data.devices || [];
      const label = d => [d.deviceName, d.serial && `S/N ${d.serial}`, d.workMode].filter(Boolean).join(' · ');
      const ver = data.version ? ` · ${data.version}` : '';
      setDiscoverList(devs);
      if (devs.length === 1) {
        set('deviceName', devs[0].deviceName);
        setDiscoverMsg(devs[0].existing
          ? { warn: true, text: `Pronađen: ${label(devs[0])}${ver} — već dodat kao "${devs[0].existing}"` }
          : { text: `Pronađen: ${label(devs[0])}${ver}` });
      } else {
        const free = devs.find(d => !d.existing);
        if (free) set('deviceName', free.deviceName);
        setDiscoverMsg({ text: `Pronađeno ${devs.length} UPS-a — izaberi iz liste${ver}` });
      }
    } catch (err) {
      setDiscoverMsg({ error: true, text: err.response?.data?.detail || 'Autodetekcija neuspešna' });
    } finally {
      setDiscovering(false);
    }
  };

  const handleTest = async () => {
    if (!form.host) { setTestRes({ error: 'Unesi adresu servera' }); return; }
    setTesting(true); setTestRes(null);
    try {
      const { data } = await api.post(`/tenants/${tenantId}/ups/test-connection`, {
        source: form.source, host: form.host, port: form.port, deviceName: form.deviceName,
        username: form.username || undefined, password: form.password || undefined,
      });
      setTestRes(data);
    } catch (err) {
      setTestRes({ error: err.response?.data?.detail || 'Konekcija neuspešna' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name || !form.host || !form.deviceName) { setError(isVP ? 'Naziv, ViewPower računar i portName su obavezni' : 'Naziv, NUT server i ime UPS-a su obavezni'); return; }
    setSaving(true); setError('');
    try {
      const payload = { ...form, password: form.password || undefined };
      if (isEdit) await api.put(`/tenants/${tenantId}/ups/${ups.id}`, payload);
      else        await api.post(`/tenants/${tenantId}/ups`, payload);
      onSave();
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <F label="Naziv *">
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="UPS serverska sala" />
        </F>
        <F label="Lokacija">
          <input className="input" value={form.location} onChange={e => set('location', e.target.value)} />
        </F>
      </div>
      <F label="Opis">
        <input className="input" value={form.description} onChange={e => set('description', e.target.value)} />
      </F>
      <F label="Izvor podataka">
        <select className="input" value={form.source} onChange={e => changeSource(e.target.value)}>
          <option value="nut">NUT server (Synology / QNAP / Linux)</option>
          <option value="viewpower">ViewPower (Windows računar sa UPS-om)</option>
        </select>
      </F>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <F label={isVP ? 'ViewPower računar (IP ili hostname) *' : 'NUT server (IP ili hostname) *'}>
            <input className="input" value={form.host} onChange={e => set('host', e.target.value)} placeholder="192.168.1.10" />
          </F>
        </div>
        <F label="Port">
          <input className="input" type="number" value={form.port}
            onChange={e => set('port', parseInt(e.target.value) || SOURCE_DEFAULTS[form.source].port)} />
        </F>
      </div>
      {isVP ? (
        <F label="portName uređaja u ViewPower-u *">
          <div className="flex gap-2">
            <input className="input flex-1" value={form.deviceName} onChange={e => set('deviceName', e.target.value)}
              placeholder="klikni Pronađi ili unesi ručno (npr. USB160CD9D7)" />
            <button type="button" className="btn btn-secondary whitespace-nowrap" onClick={handleDiscover} disabled={discovering}>
              {discovering ? <Spinner size={14} /> : <Search size={16} />} Pronađi
            </button>
          </div>
          {discoverMsg && (
            <p className={`text-xs mt-1 ${discoverMsg.error ? 'text-red-400' : discoverMsg.warn ? 'text-yellow-400' : 'text-gray-400'}`}>{discoverMsg.text}</p>
          )}
          {discoverList.length > 1 && (
            <select className="input mt-2" value={form.deviceName} onChange={e => set('deviceName', e.target.value)}>
              {discoverList.map(d => (
                <option key={d.deviceName} value={d.deviceName}>
                  {[d.deviceName, d.serial && `S/N ${d.serial}`, d.workMode].filter(Boolean).join(' · ')}
                  {d.existing ? ` (već dodat: ${d.existing})` : ''}
                </option>
              ))}
            </select>
          )}
        </F>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <F label="Ime UPS-a na serveru *">
            <input className="input" value={form.deviceName} onChange={e => set('deviceName', e.target.value)} />
          </F>
          <F label="Korisnik (opciono)">
            <input className="input" value={form.username} onChange={e => set('username', e.target.value)} />
          </F>
          <F label="Lozinka (opciono)">
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)}
              placeholder={isEdit && ups.has_password ? '(prazno = zadrži staru)' : ''} />
          </F>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={testing}>
          {testing ? <Spinner size={14} /> : <PlugZap size={16} />} Testiraj konekciju
        </button>
        {testRes && (testRes.error ? (
          <span className="text-xs text-red-400">{testRes.error}</span>
        ) : (
          <span className="text-xs text-gray-300 flex items-center gap-2 flex-wrap">
            <UpsStatusBadge status={testRes.status} />
            {[testRes.manufacturer, testRes.model].filter(Boolean).join(' ')}
            <span className="text-gray-500">· {testRes.varCount} promenljivih</span>
            {testRes.reason && <span className="text-yellow-400">· {testRes.reason}</span>}
          </span>
        ))}
      </div>

      <F label="Interval osvežavanja (sekunde)">
        <input className="input" type="number" min={10} value={form.pollIntervalSec}
          onChange={e => set('pollIntervalSec', parseInt(e.target.value) || 60)} />
      </F>

      <button type="button" className="text-xs text-blue-400 hover:underline"
        onClick={() => setShowAdvanced(v => !v)}>
        {showAdvanced ? 'Sakrij' : 'Prikaži'} napredna retention podešavanja
      </button>
      {showAdvanced && (
        <div className="grid grid-cols-3 gap-3 border border-gray-800 rounded-lg p-3">
          <F label="Raw retention (h)"><input className="input" type="number" value={form.rawRetentionHours}
            onChange={e => set('rawRetentionHours', parseInt(e.target.value) || 72)} /></F>
          <F label="Rollup bucket (min)"><input className="input" type="number" value={form.rollupBucketMinutes}
            onChange={e => set('rollupBucketMinutes', parseInt(e.target.value) || 5)} /></F>
          <F label="Rollup retention (dana)"><input className="input" type="number" value={form.rollupRetentionDays}
            onChange={e => set('rollupRetentionDays', parseInt(e.target.value) || 90)} /></F>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button className="btn btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj izmene' : 'Dodaj UPS')}
        </button>
      </div>
    </div>
  );
}, () => true);

function UpsDetails({ tenantId, upsId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api.get(`/tenants/${tenantId}/ups/${upsId}`).then(r => setData(r.data)).catch(() => setErr(true));
  }, [tenantId, upsId]);
  if (err) return <div className="text-xs text-red-400 py-2">Greška pri učitavanju detalja</div>;
  if (!data) return <div className="py-3"><Spinner size={14} /></div>;
  let vars = {};
  try { vars = data.raw_vars_json ? JSON.parse(data.raw_vars_json) : {}; } catch {}
  const keys = Object.keys(vars).sort();
  return (
    <div className="space-y-2">
      {data.last_error && <div className="text-xs text-yellow-400">Poslednja poruka: {data.last_error}</div>}
      {keys.length === 0 ? (
        <div className="text-xs text-gray-500 py-2">Nema podataka — UPS još nije uspešno poll-ovan</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-0.5 font-mono text-xs">
          {keys.map(k => (
            <div key={k} className="flex justify-between gap-3 border-b border-gray-800/30 py-0.5">
              <span className="text-gray-500 truncate">{k}</span>
              <span className="text-gray-300 text-right">{vars[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function UpsDevices() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_ups_manage');
  const [searchParams, setSearchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('Dodaj UPS');
  const [delConfirm, setDelConfirm] = useState(null);
  const [testing, setTesting] = useState(null);
  const [openingEdit, setOpeningEdit] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const upsRef = React.useRef(null);

  const fetchItems = useCallback(async () => {
    if (!tenantId) return;
    try {
      const { data } = await api.get(`/tenants/${tenantId}/ups`);
      setItems(data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);
  useEffect(() => {
    const t = setInterval(fetchItems, 60000);  // metrike se osvezavaju na 60s
    return () => clearInterval(t);
  }, [fetchItems]);
  useEffect(() => {
    const unsub = ws.on('ups_status', (data) => {
      setItems(prev => prev.map(u => u.id !== data.upsId ? u : {
        ...u, status: data.status, last_error: data.error || null,
      }));
    });
    return unsub;
  }, []);

  const openAdd = () => { upsRef.current = null; setModalTitle('Dodaj UPS'); setModalOpen(true); };
  const openEdit = async (u) => {
    setOpeningEdit(u.id);
    try {
      const { data } = await api.get(`/tenants/${tenantId}/ups/${u.id}`);
      upsRef.current = data;
      setModalTitle(`Izmeni — ${u.name}`);
      setModalOpen(true);
    } catch {} finally { setOpeningEdit(null); }
  };
  const handleSaved = () => { setModalOpen(false); fetchItems(); };

  const handleDelete = async () => {
    if (!delConfirm) return;
    await api.delete(`/tenants/${tenantId}/ups/${delConfirm.id}`);
    setDelConfirm(null); fetchItems();
  };

  const handleTest = async (u) => {
    setTesting(u.id);
    try { await api.post(`/tenants/${tenantId}/ups/${u.id}/test`); } catch {}
    finally { setTesting(null); fetchItems(); }
  };

  const q = searchQuery.trim().toLowerCase();
  const statusFilter = searchParams.get('status') || '';
  const filtered = React.useMemo(() => items
    .filter(u => !q || [u.name, u.host, u.location, u.description, u.manufacturer, u.model]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(q)))
    .filter(u => !statusFilter || u.status === statusFilter),
  [items, q, statusFilter]);

  if (loading) return <Spinner />;

  const TH = ({ children }) => (
    <th className="text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider">{children}</th>
  );
  const COLS = 11;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <h1 className="text-xl font-semibold">UPS</h1>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-sm w-40 flex-shrink-0" value={statusFilter} onChange={e => setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            if (e.target.value) next.set('status', e.target.value); else next.delete('status');
            return next;
          })}>
            <option value="">Svi statusi</option>
            {Object.entries(UPS_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input className="input pl-8 py-1.5 text-sm w-48" placeholder="Pretraga..."
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {canManage && (
            <button className="btn btn-primary flex-shrink-0 whitespace-nowrap" onClick={openAdd}>
              <Plus size={16} /> Dodaj UPS
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <Empty icon={BatteryCharging} title="Nema UPS uređaja"
          subtitle="Dodaj UPS preko NUT servera (Synology/QNAP/Linux) ili ViewPower-a (Windows)"
          action={canManage && <button className="btn btn-primary" onClick={openAdd}><Plus size={16} /> Dodaj UPS</button>} />
      ) : filtered.length === 0 ? (
        <Empty icon={Search} title="Nema rezultata" subtitle={q ? `Ništa ne odgovara pretrazi "${searchQuery}"` : 'Nijedan UPS ne odgovara izabranom filteru'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <TH></TH><TH>Naziv</TH><TH>Izvor</TH><TH>Status</TH><TH>Opterećenje</TH>
                <TH>Baterija</TH><TH>Runtime</TH><TH>Ulaz / Izlaz</TH><TH>Temp.</TH><TH>Model</TH><TH></TH>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => {
                const isOpen = expanded === u.id;
                const load = num(u.load_percent);
                return (
                  <React.Fragment key={u.id}>
                    <tr className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/50 transition-colors"
                        onClick={() => setExpanded(isOpen ? null : u.id)}>
                      <td className="py-2.5 pl-3 text-gray-500 w-6">
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="text-gray-200 font-medium">{u.name}</div>
                        {(u.location || u.description) && (
                          <div className="text-xs text-gray-500">{[u.location, u.description].filter(Boolean).join(' · ')}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-gray-400 text-xs">
                        <div>{u.host}:{u.port}</div>
                        <div className="text-gray-600">{u.source === 'viewpower' ? 'ViewPower' : 'NUT'} · {u.device_name}</div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <UpsStatusBadge status={u.status} />
                          {u.replace_battery && <span className="badge-orange">Zameni bateriju</span>}
                        </div>
                        {u.status !== 'online' && u.last_error && (
                          <div className="text-xs text-gray-500 mt-0.5 max-w-[220px] truncate" title={u.last_error}>{u.last_error}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        {load === null ? <span className="text-gray-600">—</span> : (
                          <div className="w-24">
                            <div className="flex justify-between text-xs text-gray-500 mb-1"><span></span><span>{Math.round(load)}%</span></div>
                            <MeterBar value={load} />
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        {num(u.battery_charge) === null ? <span className="text-gray-600">—</span> : (
                          <div className="w-24">
                            <div className="flex justify-between text-xs text-gray-500 mb-1"><span></span><span>{Math.round(num(u.battery_charge))}%</span></div>
                            <BatteryBar value={num(u.battery_charge)} />
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">{fmtRuntime(u.battery_runtime_sec)}</td>
                      <td className="py-2.5 px-3 text-gray-300 whitespace-nowrap">
                        {fmt(u.input_voltage, '')} / {fmt(u.output_voltage, ' V')}
                      </td>
                      <td className="py-2.5 px-3 text-gray-300">{fmt(u.temperature, '°C', 1)}</td>
                      <td className="py-2.5 px-3 text-xs text-gray-400">
                        {[u.manufacturer, u.model].filter(Boolean).join(' ') || '—'}
                      </td>
                      <td className="py-2.5 px-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1 justify-end">
                          <button className="btn-ghost p-1.5" title="Osveži odmah" onClick={() => handleTest(u)} disabled={testing === u.id}>
                            {testing === u.id ? <Spinner size={14} /> : <RefreshCw size={14} />}
                          </button>
                          {canManage && (
                            <>
                              <button className="btn-ghost p-1.5" title="Izmeni" onClick={() => openEdit(u)} disabled={openingEdit === u.id}>
                                {openingEdit === u.id ? <Spinner size={14} /> : <Pencil size={14} />}
                              </button>
                              <button className="btn-ghost p-1.5 text-red-400" title="Obriši" onClick={() => setDelConfirm(u)}>
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-gray-800/50 bg-gray-900/40">
                        <td></td>
                        <td colSpan={COLS - 1} className="py-3 px-3">
                          <UpsDetails tenantId={tenantId} upsId={u.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={modalTitle}>
        <UpsForm upsRef={upsRef} tenantId={tenantId} onSave={handleSaved} onClose={() => setModalOpen(false)} />
      </Modal>

      <ConfirmDialog open={!!delConfirm} title="Obriši UPS"
        message={`Da li si siguran da želiš da obrišeš "${delConfirm?.name}"?`}
        onConfirm={handleDelete} onCancel={() => setDelConfirm(null)} danger />
    </div>
  );
}
