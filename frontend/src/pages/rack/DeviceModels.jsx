// src/pages/rack/DeviceModels.jsx
// Biblioteka modela uredjaja (rack modul, 13.11.2026).
//  - Biblioteka: svi modeli sa prednjom plocom, detalji i lista portova
//  - Prepoznavanje (superadmin): koji model je prepoznat za svaki postojeci
//    mrezni uredjaj; klik prikazuje plocu sa ZIVIM stanjem portova iz SNMP-a
//    -- provera i rasporeda u modelu i mapiranja port <-> interfejs.
import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, Search, X, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Spinner, Alert, Empty } from '../../components/ui';
import Faceplate from '../../components/rack/Faceplate';
import { loadModelList, loadModel, mapInterfaces } from '../../components/rack/deviceModels';

const TYPE_LABEL = {
  switch: 'Svič', router: 'Ruter', firewall: 'Firewall', ap: 'AP / link', patch_panel: 'Patch panel',
  fiber_panel: 'Optički panel', ups: 'UPS', server: 'Server', nas: 'NAS', pdu: 'PDU',
  shelf: 'Polica', blank: 'Slepa ploča', cable_manager: 'Organizator kablova', other: 'Ostalo',
};
const MOUNT_LABEL = { rack: 'rack', ears: 'uši', bracket: 'nosač', none: 'van racka' };
const STATE_LABEL = { up: 'gore', down: 'dole', disabled: 'isključen', notPresent: 'prazan', unknown: '—' };

function Legend() {
  const items = [['#639922', 'link gore'], ['#5F5E5A', 'link dole'], ['#A32D2D', 'isključen (admin)'], ['dashed', 'prazan / notPresent'], ['#26282b', 'nije povezan sa SNMP']];
  return (
    <div className="flex flex-wrap gap-4 text-xs text-gray-400">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-2.5 rounded-sm"
            style={c === 'dashed' ? { border: '1px dashed #888780' } : { background: c, border: '1px solid #1a1b1d' }} />
          {l}
        </span>
      ))}
    </div>
  );
}

function PortTable({ model, mapping }) {
  const rows = (model.ports || []).filter(p => !['power'].includes(p.type));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-gray-500 uppercase tracking-wider">
          {['Port', 'Tip', 'Brzina', 'PoE', 'SNMP ime', ...(mapping ? ['Interfejs', 'Stanje'] : [])].map(h =>
            <th key={h} className="text-left py-2 px-3 font-medium">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((p, i) => {
            const m = mapping?.byPort[p.name];
            return (
              <tr key={i} className="border-t border-gray-800">
                <td className="py-1.5 px-3 font-mono">{p.name}{p.combo && <span className="badge-gray ml-2">combo</span>}</td>
                <td className="py-1.5 px-3">{p.type.toUpperCase()}</td>
                <td className="py-1.5 px-3">{p.speed || '—'}</td>
                <td className="py-1.5 px-3">{p.poe ? `PoE-${p.poe}` : '—'}</td>
                <td className="py-1.5 px-3 font-mono text-gray-400">{p.snmp_name || '—'}</td>
                {mapping && <>
                  <td className="py-1.5 px-3 font-mono">
                    {m ? <>{m.iface.if_name}{m.how === 'redosled' && <span className="badge-yellow ml-2">po redosledu</span>}</>
                       : <span className="text-gray-600">{p.snmp_name ? 'nije povezan' : '—'}</span>}
                  </td>
                  <td className="py-1.5 px-3">{p.snmp_name ? STATE_LABEL[mapping.state[p.name]] : '—'}</td>
                </>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelDetail({ model, device, onClose }) {
  const [sel, setSel] = useState(null);
  const [ifaces, setIfaces] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setSel(null); setIfaces(null); setErr('');
    if (!device) return;
    api.get(`/tenants/${device.tenantId}/network-devices/${device.id}/interfaces`)
      .then(r => setIfaces(r.data.interfaces))
      .catch(e => setErr(e.response?.data?.detail || 'Greška pri učitavanju interfejsa'));
  }, [model.id, device?.id]);

  const mapping = useMemo(() => (ifaces ? mapInterfaces(model, ifaces) : null), [model, ifaces]);
  const selPort = sel && (model.ports || []).find(p => p.name === sel);

  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">
            {device ? <>{device.name} <span className="text-gray-500 font-normal">· {device.tenant}</span></> : `${model.vendor} ${model.model}`}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {device && <>{model.vendor} {model.model} · </>}
            <span className="font-mono">{model.id}</span>
            {model.sku && <> · {model.sku}</>}
            {' · '}{TYPE_LABEL[model.type] || model.type}
            {' · '}{model.form.height_u ? `${model.form.height_u}U` : 'van racka'} ({MOUNT_LABEL[model.form.mount]})
          </p>
        </div>
        <button className="btn-ghost" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="bg-gray-950 rounded-lg p-4">
        <div style={{ maxWidth: model.form.mount === 'none' ? 420 : 1100 }}>
          <Faceplate model={model} selected={sel}
            portState={mapping?.state} portInfo={mapping?.info}
            onPortClick={p => setSel(p.name)} />
        </div>
      </div>

      {device && <Legend />}
      {err && <Alert type="error" message={err} />}
      {device && !ifaces && !err && <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam interfejse…</div>}
      {mapping && mapping.unmatched.length > 0 && (
        <Alert type="warning" message={`Portovi bez SNMP interfejsa: ${mapping.unmatched.join(', ')}`} />
      )}

      {selPort && (
        <div className="text-sm bg-gray-800/60 rounded-lg px-3 py-2 font-mono">
          {selPort.name} · {selPort.type.toUpperCase()}{selPort.speed ? ` ${selPort.speed}` : ''}
          {selPort.poe ? ` · PoE-${selPort.poe}` : ''}
          {mapping?.info[selPort.name] ? ` · ${mapping.info[selPort.name]}` : ''}
          {mapping ? ` · ${STATE_LABEL[mapping.state[selPort.name]] || '—'}` : ''}
        </div>
      )}

      {model.notes && <p className="text-xs text-gray-400">{model.notes}</p>}
      <PortTable model={model} mapping={mapping} />
    </div>
  );
}

function MatchReport({ models, onOpen }) {
  const [rows, setRows] = useState(null);
  const [errors, setErrors] = useState([]);
  const [err, setErr] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);

  const load = () => {
    setRows(null); setErr('');
    Promise.all([api.get('/device-models/_match-report'), api.get('/device-models/_errors')])
      .then(([r, e]) => { setRows(r.data); setErrors(e.data); })
      .catch(e => setErr(e.response?.data?.detail || 'Greška pri učitavanju'));
  };
  useEffect(load, []);

  if (err) return <Alert type="error" message={err} />;
  if (!rows) return <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam…</div>;
  const shown = onlyMissing ? rows.filter(r => !r.model) : rows;
  const matched = rows.filter(r => r.model).length;

  return (
    <div className="card space-y-3">
      {errors.length > 0 && <Alert type="error" message={`Neispravne definicije: ${errors.map(e => `${e.file} (${e.error})`).join('; ')}`} />}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">Prepoznato <span className="text-gray-100">{matched}</span> od {rows.length} uređaja. Klik na prepoznat uređaj prikazuje ploču sa stanjem portova.</p>
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-400 inline-flex items-center gap-1.5">
            <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} /> samo neprepoznati
          </label>
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /> Osveži</button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-gray-500 uppercase tracking-wider">
          {['Tenant', 'Uređaj', 'Opis (sysDescr)', 'Model'].map(h => <th key={h} className="text-left py-2 px-3 font-medium">{h}</th>)}
        </tr></thead>
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className={`border-t border-gray-800 ${r.model ? 'hover:bg-gray-800/50 cursor-pointer' : ''}`}
              onClick={() => r.model && models[r.model] && onOpen(models[r.model], r)}>
              <td className="py-1.5 px-3 text-gray-400">{r.tenant}</td>
              <td className="py-1.5 px-3">{r.name}</td>
              <td className="py-1.5 px-3 text-gray-500 truncate max-w-xs">{r.sysDescr}</td>
              <td className="py-1.5 px-3 font-mono">{r.model || <span className="text-gray-600">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DeviceModels() {
  const { user } = useAuthStore();
  const isSuperadmin = user?.role === 'superadmin';
  const [list, setList] = useState(null);
  const [models, setModels] = useState({});
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [tab, setTab] = useState('library');
  const [open, setOpen] = useState(null);   // { model, device? }

  useEffect(() => {
    loadModelList()
      .then(async l => {
        setList(l);
        const full = await Promise.all(l.map(s => loadModel(s.id)));
        setModels(Object.fromEntries(full.map(m => [m.id, m])));
      })
      .catch(e => setErr(e.response?.data?.detail || 'Greška pri učitavanju biblioteke'));
  }, []);

  const groups = useMemo(() => {
    if (!list) return [];
    const ql = q.trim().toLowerCase();
    const f = list.filter(s => (!type || s.type === type) &&
      (!ql || `${s.vendor} ${s.model} ${s.sku || ''} ${s.id}`.toLowerCase().includes(ql)));
    const by = {};
    f.forEach(s => { (by[s.vendor] ||= []).push(s); });
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [list, q, type]);

  const types = useMemo(() => [...new Set((list || []).map(s => s.type))], [list]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Modeli uređaja</h1>
          {isSuperadmin && (
            <div className="flex gap-1">
              <button className={tab === 'library' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('library')}>Biblioteka</button>
              <button className={tab === 'match' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('match')}>Prepoznavanje</button>
            </div>
          )}
        </div>
        {tab === 'library' && (
          <div className="flex items-center gap-2">
            <select className="input py-1.5 text-sm w-44" value={type} onChange={e => setType(e.target.value)}>
              <option value="">Svi tipovi</option>
              {types.map(t => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
            </select>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input className="input pl-8 py-1.5 text-sm w-56" placeholder="Pretraga…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {err && <Alert type="error" message={err} />}
      {open && <ModelDetail model={open.model} device={open.device} onClose={() => setOpen(null)} />}

      {tab === 'match' && isSuperadmin && (
        <MatchReport models={models} onOpen={(model, device) => { setOpen({ model, device }); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      )}

      {tab === 'library' && (!list ? (
        <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam biblioteku…</div>
      ) : groups.length === 0 ? (
        <Empty icon={Boxes} title="Nema modela" subtitle="Promeni pretragu ili filter" />
      ) : groups.map(([vendor, items]) => (
        <div key={vendor} className="space-y-2">
          <h2 className="text-sm font-medium text-gray-400">{vendor}</h2>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
            {items.map(s => {
              const m = models[s.id];
              return (
                <button key={s.id} type="button" onClick={() => m && (setOpen({ model: m }), window.scrollTo({ top: 0, behavior: 'smooth' }))}
                  className={`card text-left hover:border-gray-600 transition-colors ${open?.model.id === s.id && !open?.device ? 'border-brand-500' : ''}`}>
                  <div className="flex justify-between items-baseline gap-2 mb-2">
                    <span className="text-sm font-medium truncate">{s.model}</span>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {s.heightU ? `${s.heightU}U` : 'van racka'} · {s.portCount} port.
                    </span>
                  </div>
                  <div className="bg-gray-950 rounded-md p-2" style={{ minHeight: 40 }}>
                    {m ? <div style={{ maxWidth: s.mount === 'none' ? 160 : '100%' }}><Faceplate model={m} showNumbers={false} /></div>
                       : <Spinner />}
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5">{TYPE_LABEL[s.type] || s.type}{s.sku ? ` · ${s.sku}` : ''}</p>
                </button>
              );
            })}
          </div>
        </div>
      )))}
    </div>
  );
}
