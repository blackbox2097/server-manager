// src/pages/infra/RoomView.jsx
// Prikaz jedne lokacije: rackovi jedan pored drugog, uredjaji crtani iz
// biblioteke modela, drag & drop po U pozicijama (i izmedju rackova), traka
// "bez mesta u racku", panel izabranog uredjaja sa zivim stanjem portova.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Plus, Pencil, Trash2, X, Unlink, Maximize2, Minimize2 } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Modal, ConfirmDialog, Alert, Spinner } from '../../components/ui';
import Faceplate, { STATUS_LED } from '../../components/rack/Faceplate';
import { loadModelList, loadModel, mapInterfaces, portStates as computePortStates } from '../../components/rack/deviceModels';
import PortStrip, { STATE_LABEL, STRIP_CLS, STRIP_HIDDEN } from '../../components/rack/PortStrip';
import { RoomForm } from './Rooms';
import { PortDetail, CableDialog, indexCables, cableMarks } from './Cabling';

const ROW_H = 46;                                    // px po 1U u normalnom prikazu
const NAMES_W = 190;                                 // kolona sa nazivima desno od racka
const LBL_W = 26;

const errMsg = (e, d) => e?.response?.data?.detail
  ? (typeof e.response.data.detail === 'string' ? e.response.data.detail : e.response.data.detail.map(x => x.msg).join('; '))
  : d;

const STATUS_DOT = {
  online: 'bg-green-500', offline: 'bg-red-500', warning: 'bg-yellow-500',
  on_battery: 'bg-orange-500', low_battery: 'bg-red-500',
};
const KIND_LABEL = { network: 'Mrežni uređaj', server: 'Server', ups: 'UPS' };

// ── geometrija racka (U <-> red na ekranu, red 0 = vrh) ─────────────────────
const uOfRow = (rack, row) => (rack.units_from_top ? row + 1 : rack.height_u - row);
const topRowOf = (rack, pos, h) => (rack.units_from_top ? pos - 1 : rack.height_u - (pos + h - 1));
const posFromTopRow = (rack, topRow, h) =>
  Math.min(uOfRow(rack, topRow), uOfRow(rack, topRow + h - 1));

function fits(rack, devices, selfId, topRow, h) {
  if (topRow < 0 || topRow + h > rack.height_u) return false;
  const pos = posFromTopRow(rack, topRow, h), top = pos + h - 1;
  return !devices.some(d => d.id !== selfId && d.rack_position <= top && d.rack_position + d.height_u - 1 >= pos);
}

// ── rack ────────────────────────────────────────────────────────────────────
function RackColumn({ rack, devices, models, canManage, selectedId, onSelect, onEmptyClick,
                      onEdit, onDelete, dragRef, preview, setPreview, onDrop, rowH, states, modules, marks, highlights,
                      selPort, onPortClick, onToggleFocus }) {
  const areaRef = useRef(null);
  const ROW_H = rowH;
  const RACK_W = Math.round(482.6 / 44.45 * rowH);   // 19" sirina u istoj razmeri
  const H = rack.height_u;
  const used = devices.reduce((s, d) => s + d.height_u, 0);
  const taken = new Set();
  devices.forEach(d => { const t = topRowOf(rack, d.rack_position, d.height_u); for (let r = t; r < t + d.height_u; r++) taken.add(r); });
  const myPreview = preview?.rackId === rack.id ? preview : null;

  const dragOver = e => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();
    const rect = areaRef.current.getBoundingClientRect();
    const row = Math.floor((e.clientY - rect.top) / ROW_H);
    const topRow = row - drag.grabRow;
    const ok = drag.rackable && fits(rack, devices, drag.id, topRow, drag.h);
    if (!myPreview || myPreview.topRow !== topRow || myPreview.ok !== ok) {
      setPreview({ rackId: rack.id, topRow, h: drag.h, ok,
        position: ok ? posFromTopRow(rack, topRow, drag.h) : null });
    }
  };
  const drop = e => {
    e.preventDefault();
    if (myPreview) onDrop(rack, myPreview);
  };

  return (
    <div className="flex-shrink-0">
      <div className="flex items-center justify-between gap-2 mb-1.5" style={{ marginLeft: LBL_W, width: RACK_W }}>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{rack.name}</p>
          <p className="text-xs text-gray-500">{H} U · zauzeto {used} U{rack.units_from_top ? ' · U1 na vrhu' : ''}</p>
        </div>
        <div className="flex gap-0.5 items-center flex-shrink-0">
          <button className="btn-secondary py-1 px-2.5 text-xs mr-1" title="Uvećan prikaz: uređaji i portovi" onClick={() => onToggleFocus(rack.id)}>
            <Maximize2 size={13} /> Zoom
          </button>
          {canManage && <>
            <button className="btn-ghost p-1.5" title="Izmeni rack" onClick={() => onEdit(rack)}><Pencil size={13} /></button>
            <button className="btn-ghost p-1.5" title="Obriši rack" onClick={() => onDelete(rack)}><Trash2 size={13} /></button>
          </>}
        </div>
      </div>
      <div className="flex">
        {/* U oznake levo */}
        <div style={{ width: LBL_W }}>
          {Array.from({ length: H }, (_, r) => (
            <div key={r} className="text-[10px] text-gray-600 text-right pr-1.5 font-mono"
              style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>{uOfRow(rack, r)}</div>
          ))}
        </div>
        {/* rack */}
        <div ref={areaRef} className="relative bg-gray-900 border-x-4 border-gray-700"
          style={{ width: RACK_W + 8, height: H * ROW_H }}
          onDragOver={dragOver} onDrop={drop}
          onDragLeave={e => { if (!areaRef.current.contains(e.relatedTarget)) setPreview(null); }}>
          {/* prazne pozicije */}
          {Array.from({ length: H }, (_, r) => r).filter(r => !taken.has(r)).map(r => (
            <div key={`e${r}`} className="absolute left-0 right-0 border-b border-gray-800/60 group"
              style={{ top: r * ROW_H, height: ROW_H }}>
              {canManage && (
                <button className="hidden group-hover:flex items-center justify-center w-full h-full text-gray-500 hover:text-gray-200 text-xs gap-1"
                  onClick={() => onEmptyClick(rack, uOfRow(rack, r))}>
                  <Plus size={12} /> dodaj na U{uOfRow(rack, r)}
                </button>
              )}
            </div>
          ))}
          {/* uredjaji */}
          {devices.map(d => {
            const t = topRowOf(rack, d.rack_position, d.height_u);
            const m = d.model_id && models[d.model_id];
            const sel = selectedId === d.id;
            return (
              <div key={d.id}
                draggable={canManage}
                onDragStart={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  dragRef.current = { id: d.id, h: d.height_u, rackable: true,
                    grabRow: Math.max(0, Math.min(d.height_u - 1, Math.floor((e.clientY - r.top) / ROW_H))) };
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', d.id);
                }}
                onDragEnd={() => { dragRef.current = null; setPreview(null); }}
                onClick={() => onSelect(d.id)}
                title={`${d.name} · U${d.rack_position}${d.height_u > 1 ? `–U${d.rack_position + d.height_u - 1}` : ''}`}
                className={`absolute left-0 right-0 overflow-hidden ${canManage ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${sel ? 'ring-2 ring-brand-500 z-[5]' : ''}`}
                style={{ top: t * ROW_H, height: d.height_u * ROW_H, opacity: dragRef.current?.id === d.id && preview ? 0.4 : 1 }}>
                {m ? <Faceplate model={m} showNumbers={rowH >= 60} portState={states[d.id]}
                       modules={modules[d.id]} cables={marks[d.id]} highlight={highlights.get(d.id)}
                       statusColor={STATUS_LED[d.linked_status]}
                       selected={sel ? selPort : null} onPortClick={p => onPortClick(d.id, p.pkey)} />
                   : <div className="w-full h-full bg-gray-700 border border-gray-600 flex items-center px-3 text-xs text-gray-200">{d.name}</div>}
              </div>
            );
          })}
          {/* pregled pri prevlacenju */}
          {myPreview && (
            <div className={`absolute left-0 right-0 pointer-events-none border-2 ${myPreview.ok ? 'border-green-500 bg-green-500/20' : 'border-red-500 bg-red-500/20'}`}
              style={{ top: Math.max(0, myPreview.topRow) * ROW_H,
                       height: (Math.min(H, myPreview.topRow + myPreview.h) - Math.max(0, myPreview.topRow)) * ROW_H }} />
          )}
        </div>
        {/* nazivi desno */}
        <div className="relative" style={{ width: NAMES_W, height: H * ROW_H }}>
          {devices.map(d => {
            const t = topRowOf(rack, d.rack_position, d.height_u);
            return (
              <button key={d.id} onClick={() => onSelect(d.id)}
                className={`absolute left-0 right-0 flex items-center gap-1.5 pl-2 text-left text-xs truncate ${selectedId === d.id ? 'text-brand-200' : 'text-gray-300 hover:text-gray-100'}`}
                style={{ top: t * ROW_H, height: d.height_u * ROW_H }}>
                {d.linked_kind && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[d.linked_status] || 'bg-gray-600'}`} />}
                <span className="truncate">{d.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── forme ───────────────────────────────────────────────────────────────────
function RackForm({ open, rack, roomId, tenantId, onClose, onSaved }) {
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) { setF({ name: rack?.name || '', heightU: rack?.height_u || 42, unitsFromTop: !!rack?.units_from_top, notes: rack?.notes || '' }); setErr(''); }
  }, [open, rack]);
  const save = async () => {
    const body = { ...f, roomId, heightU: Number(f.heightU) };
    try {
      if (rack?.id) await api.put(`/tenants/${tenantId}/infra/racks/${rack.id}`, body);
      else await api.post(`/tenants/${tenantId}/infra/racks`, body);
      onSaved();
    } catch (e) { setErr(errMsg(e, 'Greška pri čuvanju')); }
  };
  return (
    <Modal open={open} onClose={onClose} title={rack?.id ? 'Izmena racka' : 'Novi rack'}
      footer={<><button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save}>Sačuvaj</button></>}>
      <div className="space-y-3">
        {err && <Alert type="error" message={err} />}
        <div><label className="label">Naziv *</label>
          <input className="input" value={f.name || ''} onChange={e => setF(p => ({ ...p, name: e.target.value }))} placeholder="Rack 1-1" autoFocus /></div>
        <div><label className="label">Visina (U)</label>
          <input className="input w-32" type="number" min={1} max={60} value={f.heightU || ''} onChange={e => setF(p => ({ ...p, heightU: e.target.value }))} /></div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={!!f.unitsFromTop} onChange={e => setF(p => ({ ...p, unitsFromTop: e.target.checked }))} />
          U1 je na vrhu (kako je odštampano na racku)
        </label>
        <div><label className="label">Napomena</label>
          <textarea className="input" rows={2} value={f.notes || ''} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} /></div>
      </div>
    </Modal>
  );
}

function WideModal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="font-semibold text-gray-100">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="p-4 border-t border-gray-800 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

const CAND_GROUPS = [['network', 'Mrežni uređaji'], ['server', 'Serveri'], ['ups', 'UPS']];
const PASSIVE_TYPES = ['patch_panel', 'fiber_panel', 'cable_manager', 'shelf', 'blank', 'pdu', 'ups', 'server'];
const PASSIVE_GROUPS = [
  ['Patch paneli', ['patch_panel']], ['Optički paneli', ['fiber_panel']],
  ['Organizatori i police', ['cable_manager', 'shelf', 'blank']], ['Napajanje', ['pdu', 'ups']], ['Ostalo', ['server']],
];

function ModelTile({ m, full, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-left rounded-lg border p-2 transition-colors ${active ? 'border-brand-500 bg-brand-600/10' : 'border-gray-700 hover:border-gray-500'}`}>
      <div className="bg-gray-950 rounded p-1.5 mb-1.5">{full ? <Faceplate model={full} showNumbers={false} /> : <div className="h-6" />}</div>
      <p className="text-xs text-gray-200 truncate">{m.model}</p>
      <p className="text-[11px] text-gray-500">{m.heightU ? `${m.heightU}U` : 'van racka'}{m.portCount ? ` · ${m.portCount} port.` : ''}</p>
    </button>
  );
}

function DeviceForm({ open, device, preset, room, racks, devices, tenantId, modelList, models, onClose, onSaved }) {
  const [kind, setKind] = useState('passive');     // passive | monitoring | other (samo pri dodavanju)
  const [f, setF] = useState({});
  const [cands, setCands] = useState(null);
  const [full, setFull] = useState({});
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const isEdit = !!device?.id;

  useEffect(() => {
    if (!open) return;
    setErr(''); setQ(''); setKind('passive');
    const link = device?.network_device_id ? `network:${device.network_device_id}`
      : device?.server_id ? `server:${device.server_id}` : device?.ups_id ? `ups:${device.ups_id}` : '';
    setF({ name: device?.name || '', modelId: device?.model_id || '', heightU: device?.height_u || 1,
           serialNumber: device?.serial_number || '', notes: device?.notes || '', link,
           rackId: preset?.rackId ?? (device ? (device.rack_id || '') : (racks[0]?.id || '')),
           pos: preset?.position ?? device?.rack_position ?? null });
    api.get(`/tenants/${tenantId}/infra/link-candidates`).then(r => setCands(r.data)).catch(() => setCands({ network: [], servers: [], ups: [] }));
  }, [open, device, tenantId]);

  // predpregled ploca za pasivnu opremu
  useEffect(() => {
    if (!open) return;
    const ids = (modelList || []).filter(m => PASSIVE_TYPES.includes(m.type)).map(m => m.id);
    Promise.all(ids.map(id => loadModel(id).catch(() => null)))
      .then(ms => setFull(Object.fromEntries(ms.filter(Boolean).map(m => [m.id, m]))));
  }, [open, modelList]);

  const nextName = base => {
    const names = new Set((devices || []).map(d => d.name));
    for (let i = 1; i < 999; i++) { const n = `${base} ${i}`; if (!names.has(n)) return n; }
    return base;
  };
  const pickPassive = m => setF(p => ({ ...p, modelId: m.id, link: '',
    name: (!p.name || p.autoName) ? nextName(m.model.replace(/\s*\(.*\)$/, '').replace(/ \d+U$/, '')) : p.name, autoName: true }));

  const pickLink = (kindKey, c) => setF(p => ({
    ...p, link: `${kindKey}:${c.id}`, autoName: false,
    name: c.name,
    modelId: c.suggestedModel || (kindKey === 'ups' ? 'generic/ups-2u' : kindKey === 'server' ? (p.modelId || 'generic/server-1u') : p.modelId),
  }));

  const save = async () => {
    if (!f.name?.trim()) { setErr('Naziv je obavezan'); return; }
    const [lk, id] = (f.link || ':').split(':');
    const body = {
      name: f.name, roomId: room.id, modelId: f.modelId || null,
      heightU: f.modelId ? null : Number(f.heightU) || 1,
      serialNumber: f.serialNumber, notes: f.notes,
      networkDeviceId: lk === 'network' ? id : null, serverId: lk === 'server' ? id : null, upsId: lk === 'ups' ? id : null,
    };
    const wantRack = rackable && f.rackId ? f.rackId : null;
    const wantPos = wantRack ? f.pos : null;
    if (wantRack && !wantPos) { setErr('Izaberi poziciju u racku (ili "van racka")'); return; }
    setSaving(true); setErr('');
    try {
      if (isEdit) {
        const D = `/tenants/${tenantId}/infra/devices/${device.id}`;
        const moved = (device.rack_id || null) !== wantRack || (device.rack_position || null) !== wantPos;
        if (moved && device.rack_id) await api.patch(`${D}/place`, { rackId: null, position: null });
        await api.put(D, body);
        if (moved && wantRack) await api.patch(`${D}/place`, { rackId: wantRack, position: wantPos });
      } else {
        await api.post(`/tenants/${tenantId}/infra/devices`, { ...body, rackId: wantRack, rackPosition: wantPos });
      }
      onSaved();
    } catch (e) { setErr(errMsg(e, 'Greška pri čuvanju')); }
    setSaving(false);
  };

  const sel = modelList?.find(m => m.id === f.modelId);
  const height = f.modelId ? (sel?.heightU ?? 1) : (Number(f.heightU) || 1);
  const rackable = height > 0;
  // slobodne pocetne pozicije u izabranom racku za ovu visinu (od vrha racka nadole)
  const freeIn = rackId => {
    const r = racks.find(x => x.id === rackId);
    if (!r || !rackable) return [];
    const others = (devices || []).filter(d => d.rack_id === rackId && d.id !== device?.id);
    const out = [];
    for (let p = 1; p + height - 1 <= r.height_u; p++) {
      const top = p + height - 1;
      if (!others.some(d => d.rack_position <= top && d.rack_position + d.height_u - 1 >= p)) out.push(p);
    }
    return r.units_from_top ? out : out.reverse();
  };
  const freePos = freeIn(f.rackId);
  useEffect(() => {
    if (!open || !f.rackId) return;
    if (!rackable) { setF(p => ({ ...p, rackId: '', pos: null })); return; }
    if (!freePos.includes(f.pos)) setF(p => ({ ...p, pos: freePos[0] ?? null }));
  }, [open, f.rackId, height, rackable, freePos.join(',')]);  // eslint-disable-line
  const byVendor = useMemo(() => {
    const g = {};
    (modelList || []).forEach(m => { (g[m.vendor] ||= []).push(m); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [modelList]);

  const candRows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const rows = [];
    [['network', 'Mrežni uređaj', cands?.network], ['server', 'Server', cands?.servers], ['ups', 'UPS', cands?.ups]].forEach(([k, label, list]) =>
      (list || []).forEach(c => { if (!ql || `${c.name} ${c.ip || ''}`.toLowerCase().includes(ql)) rows.push({ k, label, c }); }));
    return rows;
  }, [cands, q]);

  const linkSelect = (
    <select className="input" value={f.link || ''} onChange={e => setF(p => ({ ...p, link: e.target.value }))}>
      <option value="">— nije povezan —</option>
      {[['network', 'Mrežni uređaji', cands?.network], ['server', 'Serveri', cands?.servers], ['ups', 'UPS', cands?.ups]].map(([k, label, list]) =>
        list?.length > 0 && (
          <optgroup key={k} label={label}>
            {list.map(c => <option key={c.id} value={`${k}:${c.id}`} disabled={!!c.linkedTo && c.linkedTo !== device?.id}>
              {c.name}{c.ip ? ` (${c.ip})` : ''}{c.linkedTo && c.linkedTo !== device?.id ? ' — već u racku' : ''}</option>)}
          </optgroup>
        ))}
    </select>
  );
  const modelSelect = (
    <select className="input" value={f.modelId || ''} onChange={e => setF(p => ({ ...p, modelId: e.target.value }))}>
      <option value="">— bez modela (generički uređaj) —</option>
      {byVendor.map(([v, items]) => (
        <optgroup key={v} label={v}>
          {items.map(m => <option key={m.id} value={m.id}>{m.model} ({m.heightU ? `${m.heightU}U` : 'van racka'})</option>)}
        </optgroup>
      ))}
    </select>
  );

  const span = p => `U${p}${height > 1 ? `–U${p + height - 1}` : ''}`;
  const placeBlock = (
    <div className="flex items-center gap-2 flex-1 min-w-0 mr-4">
      <span className="text-sm text-gray-400 flex-shrink-0">Mesto:</span>
      {!rackable ? (
        <span className="text-sm text-gray-400">ovaj model ne ide u rack — biće van racka</span>
      ) : (<>
        <select className="input w-64" value={f.rackId || ''} onChange={e => setF(p => ({ ...p, rackId: e.target.value, pos: null }))}>
          <option value="">van racka</option>
          {racks.map(r => <option key={r.id} value={r.id}>{r.name} ({freeIn(r.id).length ? `${freeIn(r.id).length} slobodnih mesta` : 'nema mesta'})</option>)}
        </select>
        {f.rackId && (freePos.length ? (
          <select className="input w-32" value={f.pos || ''} onChange={e => setF(p => ({ ...p, pos: Number(e.target.value) }))}>
            {freePos.map(p => <option key={p} value={p}>{span(p)}</option>)}
          </select>
        ) : <span className="text-sm text-yellow-400">nema mesta za {height}U</span>)}
      </>)}
    </div>
  );

  const common = (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2"><label className="label">Naziv *</label>
        <input className="input" value={f.name || ''} onChange={e => setF(p => ({ ...p, name: e.target.value, autoName: false }))} /></div>
      {(isEdit || kind !== 'passive') && <div className="col-span-2"><label className="label">Model</label>{modelSelect}
</div>}
      {!f.modelId && <div><label className="label">Visina (U)</label>
        <input className="input" type="number" min={1} max={60} value={f.heightU || 1} onChange={e => setF(p => ({ ...p, heightU: e.target.value }))} /></div>}
      {isEdit && <div className="col-span-2"><label className="label">Povezan sa monitoringom</label>{linkSelect}</div>}
      <div><label className="label">Serijski broj</label>
        <input className="input" value={f.serialNumber || ''} onChange={e => setF(p => ({ ...p, serialNumber: e.target.value }))} /></div>
      <div className="col-span-2"><label className="label">Napomena</label>
        <textarea className="input" rows={2} value={f.notes || ''} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} /></div>
    </div>
  );

  return (
    <WideModal open={open} onClose={onClose} title={isEdit ? `Izmena: ${device.name}` : 'Dodaj u rack'}
      footer={<>{placeBlock}<button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null} Sačuvaj</button></>}>
      <div className="space-y-4">
        {err && <Alert type="error" message={err} />}

        {!isEdit && (
          <div className="flex gap-1 border-b border-gray-800">
            {[['passive', 'Pasivna oprema'], ['monitoring', 'Iz monitoringa'], ['other', 'Drugi model']].map(([k, l]) => (
              <button key={k} onClick={() => { setKind(k); setF(p => ({ ...p, link: k === 'monitoring' ? p.link : '', modelId: k === kind ? p.modelId : '', name: k === kind ? p.name : '' })); }}
                className={`px-3 py-2 text-sm border-b-2 -mb-px ${kind === k ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{l}</button>
            ))}
          </div>
        )}

        {!isEdit && kind === 'passive' && PASSIVE_GROUPS.map(([label, types]) => {
          const items = (modelList || []).filter(m => types.includes(m.type));
          if (!items.length) return null;
          return (
            <div key={label}>
              <p className="text-xs text-gray-500 mb-1.5">{label}</p>
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                {items.map(m => <ModelTile key={m.id} m={m} full={full[m.id]} active={f.modelId === m.id} onClick={() => pickPassive(m)} />)}
              </div>
            </div>
          );
        })}

        {!isEdit && kind === 'monitoring' && (
          <div className="space-y-2">
            <input className="input" placeholder="Pretraga po nazivu ili IP adresi…" value={q} onChange={e => setQ(e.target.value)} />
            <div className="max-h-64 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800">
              {!cands ? <div className="p-3"><Spinner /></div> : candRows.length === 0 ? <p className="p-3 text-sm text-gray-500">Nema rezultata.</p>
                : CAND_GROUPS.map(([gk, gl]) => {
                  const rows = candRows.filter(r => r.k === gk);
                  if (!rows.length) return null;
                  const free = rows.filter(r => !r.c.linkedTo || r.c.linkedTo === device?.id).length;
                  return (
                    <div key={gk}>
                      <div className="sticky top-0 z-[1] bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 flex justify-between">
                        <span>{gl}</span><span className="text-gray-500">{free} slobodno / {rows.length}</span>
                      </div>
                      {rows.map(({ k, label, c }) => {
                  const used = !!c.linkedTo && c.linkedTo !== device?.id;
                  const active = f.link === `${k}:${c.id}`;
                  return (
                    <button key={`${k}${c.id}`} type="button" disabled={used} onClick={() => pickLink(k, c)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-3 ${active ? 'bg-brand-600/20' : used ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-800/60'}`}>
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[c.status] || 'bg-gray-600'}`} />
                      <span className="flex-1 truncate">{c.name} <span className="text-gray-500">{c.ip}</span></span>
                      {used ? <span className="text-xs text-gray-500">već u racku</span>
                        : c.suggestedModel && <span className="text-xs text-gray-400 font-mono">{c.suggestedModel}</span>}
                    </button>
                  );
                })}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {(isEdit || kind !== 'passive' || f.modelId) && common}
      </div>
    </WideModal>
  );
}

// ── panel izabranog uredjaja ────────────────────────────────────────────────
function DevicePanel({ device, rack, model, mapping, states, modules, marks, highlight, selPort, onPortClick,
                       canManage, onClose, onEdit, onUnplace, onDelete, children }) {
  const where = rack ? `${rack.name} · U${device.rack_position}${device.height_u > 1 ? `–U${device.rack_position + device.height_u - 1}` : ''}` : 'van racka';
  return (
    <div className="card space-y-3">
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <p className="font-medium truncate">{device.name}</p>
          <p className="text-xs text-gray-500">{model ? `${model.vendor} ${model.model}` : 'generički uređaj'} · {where}</p>
        </div>
        <button className="btn-ghost p-1.5" onClick={onClose}><X size={14} /></button>
      </div>
      {model && (
        <div className="bg-gray-950 rounded-lg p-2">
          <Faceplate model={model} portState={states} portInfo={mapping?.info}
            modules={modules} cables={marks} highlight={highlight}
            statusColor={STATUS_LED[device.linked_status]}
            selected={selPort} onPortClick={p => onPortClick(p.pkey)} />
        </div>
      )}
      {model && !selPort && <p className="text-xs text-gray-500">Klikni na port za detalje i kablove.</p>}
      {children && <div className="bg-gray-800/30 rounded-lg p-3">{children}</div>}
      <div className="text-sm space-y-1">
        {device.linked_kind ? (
          <p className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[device.linked_status] || 'bg-gray-600'}`} />
            <span className="text-gray-400">{KIND_LABEL[device.linked_kind]}:</span> {device.linked_name}
            <span className="text-gray-500">({device.linked_status})</span>
          </p>
        ) : <p className="text-gray-500 text-xs">Nije povezan sa monitoringom.</p>}
        {device.serial_number && <p className="text-xs"><span className="text-gray-500">S/N:</span> <span className="font-mono">{device.serial_number}</span></p>}
        {device.notes && <p className="text-xs text-gray-400 whitespace-pre-wrap">{device.notes}</p>}
        {mapping?.unmatched?.length > 0 && <p className="text-xs text-yellow-400">Portovi bez SNMP interfejsa: {mapping.unmatched.join(', ')}</p>}
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="btn-secondary" onClick={onEdit}><Pencil size={14} /> Izmeni</button>
          {rack && <button className="btn-secondary" onClick={onUnplace}><Unlink size={14} /> Skini iz racka</button>}
          <button className="btn-danger" onClick={onDelete}><Trash2 size={14} /> Obriši</button>
        </div>
      )}
    </div>
  );
}

// ── uvecan prikaz racka: kartice uredjaja sa trakama portova ────────────────
function portSummary(model) {
  const g = new Map();
  (model?.ports || []).filter(p => !p.combo && !STRIP_HIDDEN.has(p.type)).forEach(p => {
    const k = `${p.type.toUpperCase()}${p.speed ? ' ' + p.speed : ''}${p.poe === 'out' ? ' PoE' : ''}`;
    g.set(k, (g.get(k) || 0) + 1);
  });
  return [...g].map(([k, n]) => `${n} × ${k}`).join(' · ');
}

const TYPE_BADGE = {
  switch: 'Svič', router: 'Ruter', firewall: 'Firewall', ap: 'AP', patch_panel: 'Patch panel', fiber_panel: 'Optički panel',
  ups: 'UPS', server: 'Server', nas: 'NAS', pdu: 'PDU', shelf: 'Polica', blank: 'Slepa ploča', cable_manager: 'Organizator', other: 'Uređaj',
};
const LINK_BADGE = { online: 'badge-green', offline: 'badge-red', warning: 'badge-yellow', on_battery: 'badge-orange', low_battery: 'badge-red' };

function RackPortsView({ rack, devices, models, mappings, states, marks, highlights, labels, selectedId, selPort,
                         onPick, canManage, onBack, onEdit, onUnplace, onDelete, children }) {
  const ordered = [...devices].sort((a, b) => topRowOf(rack, a.rack_position, a.height_u) - topRowOf(rack, b.rack_position, b.height_u));
  const span = d => `U${d.rack_position}${d.height_u > 1 ? `–U${d.rack_position + d.height_u - 1}` : ''}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={onBack}><Minimize2 size={14} /> Nazad na rack</button>
          <div>
            <p className="font-medium">{rack.name}</p>
            <p className="text-xs text-gray-500">{rack.height_u} U · {devices.length} uređaja · Esc za povratak</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-400">
          {[['up', 'link gore'], ['down', 'link dole'], ['disabled', 'isključen'], ['notPresent', 'prazan / nije prisutan'], ['unknown', 'bez SNMP podatka']].map(([k, l]) => (
            <span key={k} className="inline-flex items-center gap-1.5"><span className={`inline-block w-4 h-3.5 rounded-sm border ${STRIP_CLS[k]}`} />{l}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="relative inline-block w-4 h-3.5 rounded-sm border border-gray-600 bg-gray-900"><span className="absolute left-0.5 right-0.5 bottom-0.5 h-0.5 bg-blue-400" /></span>kabl</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3.5 rounded-sm border border-gray-600 bg-gray-900 ring-2 ring-yellow-400" />drugi kraj</span>
        </div>
      </div>

      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-3">
          {ordered.length === 0 && <div className="card text-sm text-gray-400">Rack je prazan.</div>}
          {ordered.map(d => {
            const m = d.model_id && models[d.model_id];
            const hasPorts = m && (m.front?.blocks || []).some(b => !STRIP_HIDDEN.has(b.type));
            const head = (
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <span className="font-mono font-semibold text-gray-100">{d.name}</span>
                <span className="badge-gray">{TYPE_BADGE[m?.type] || 'Uređaj'}</span>
                <span className="text-sm text-gray-400 truncate">{m ? `${m.vendor !== 'Generic' ? m.vendor + ' ' : ''}${m.model}` : 'bez modela'} · {span(d)}</span>
                {d.linked_kind && <span className={LINK_BADGE[d.linked_status] || 'badge-gray'}>{d.linked_status}</span>}
              </div>
            );
            const actions = canManage && (
              <div className="flex gap-4 text-sm flex-shrink-0">
                <button className="text-brand-400 hover:underline" onClick={() => onEdit(d)}>Izmeni</button>
                <button className="text-brand-400 hover:underline" onClick={() => onUnplace(d)}>Skini iz racka</button>
                <button className="text-red-400 hover:underline" onClick={() => onDelete(d)}>Obriši</button>
              </div>
            );
            if (!hasPorts) {
              return (
                <div key={d.id} className="px-4 py-2.5 rounded-xl border border-gray-800 bg-gray-900/50 flex items-center justify-between gap-3">
                  {head}{actions}
                </div>
              );
            }
            return (
              <div key={d.id} className="card space-y-3">
                <div className="flex items-start justify-between gap-3">
                  {head}
                  <span className="text-xs font-mono text-gray-500 text-right">{[d.linked_ip, portSummary(m)].filter(Boolean).join(' · ')}</span>
                </div>
                {actions && <div className="flex justify-end">{actions}</div>}
                <div className="bg-gray-950 rounded-lg p-3 overflow-x-auto">
                  <PortStrip model={m} states={states[d.id]} info={mappings[d.id]?.info}
                    cables={marks[d.id]} highlight={highlights.get(d.id)} labels={labels[d.id]}
                    selected={selectedId === d.id ? selPort : null} onPick={port => onPick(d.id, port)} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="w-[340px] flex-shrink-0 sticky top-16">
          <div className="card">
            {children || <p className="text-sm text-gray-500">Klikni na port da vidiš detalje i kablove.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── stranica ────────────────────────────────────────────────────────────────
export default function RoomView() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');

  const [data, setData] = useState(null);
  const [models, setModels] = useState({});
  const [modelList, setModelList] = useState([]);
  const [err, setErr] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [devForm, setDevForm] = useState({ open: false });
  const [rackForm, setRackForm] = useState({ open: false });
  const [roomForm, setRoomForm] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [preview, setPreview] = useState(null);
  const dragRef = useRef(null);
  const firstTenant = useRef(tenantId);
  const [selPort, setSelPort] = useState(null);
  const [portStates, setPortStates] = useState({});
  const [cabling, setCabling] = useState({ ports: {}, cables: [] });
  const [trace, setTrace] = useState(null);
  const [cableDlg, setCableDlg] = useState({ open: false });
  // Uvecan prikaz racka (kartice uredjaja sa trakama portova)
  const [portsRackId, setPortsRackId] = useState(null);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') setPortsRackId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadPorts = useCallback(async () => {
    if (!tenantId) return;
    try { setPortStates((await api.get(`/tenants/${tenantId}/infra/rooms/${roomId}/port-states`)).data); } catch {}
  }, [tenantId, roomId]);
  useEffect(() => {
    loadPorts();
    const t = setInterval(loadPorts, 60000);   // SNMP interface walk je na 5 min, 60 s je dovoljno
    return () => clearInterval(t);
  }, [loadPorts]);

  const loadCabling = useCallback(async () => {
    if (!tenantId) return;
    try { setCabling((await api.get(`/tenants/${tenantId}/infra/rooms/${roomId}/cabling`)).data); } catch {}
  }, [tenantId, roomId]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const d = (await api.get(`/tenants/${tenantId}/infra/rooms/${roomId}`)).data;
      setData(d);
      loadCabling();
      const ids = [...new Set(d.devices.map(x => x.model_id).filter(Boolean))];
      const loaded = await Promise.all(ids.map(id => loadModel(id).catch(() => null)));
      setModels(prev => ({ ...prev, ...Object.fromEntries(loaded.filter(Boolean).map(m => [m.id, m])) }));
      loadPorts();
    } catch (e) {
      if (e?.response?.status === 404) navigate('/infra'); else setErr(errMsg(e, 'Greška pri učitavanju'));
    }
  }, [tenantId, roomId, navigate, loadPorts, loadCabling]);

  useEffect(() => { load(); }, [load]);
  // dolazak sa drugog kraja kabla iz druge lokacije: izaberi uredjaj i port
  useEffect(() => {
    const st = location.state;
    setPortsRackId(null);
    setSelectedId(st?.dev || null); setSelPort(st?.port || null);
  }, [roomId, location.key]);  // eslint-disable-line
  useEffect(() => { loadModelList().then(setModelList).catch(() => {}); }, []);
  // promena tenanta -- lokacija pripada drugom tenantu
  useEffect(() => { if (firstTenant.current && tenantId !== firstTenant.current) navigate('/infra'); }, [tenantId, navigate]);

  const mappings = useMemo(() => {
    const out = {};
    (data?.devices || []).forEach(d => {
      const m = d.model_id && models[d.model_id];
      if (m && d.network_device_id) out[d.id] = mapInterfaces(m, portStates[d.id] || []);
    });
    return out;
  }, [data, models, portStates]);

  // dokumentacija portova: moduli, oznake, kablovi -> po uredjaju
  const cableIdx = useMemo(() => indexCables(cabling.cables), [cabling]);
  const { modules, labels, marks, states } = useMemo(() => {
    const modules = {}, labels = {}, marks = {}, states = {};
    (data?.devices || []).forEach(d => {
      const info = cabling.ports?.[d.id] || {};
      modules[d.id] = Object.fromEntries(Object.entries(info).filter(([, v]) => v.module).map(([k, v]) => [k, v.module]));
      labels[d.id] = Object.fromEntries(Object.entries(info).filter(([, v]) => v.label).map(([k, v]) => [k, v.label]));
      marks[d.id] = cableMarks(cableIdx, d.id);
      const m = d.model_id && models[d.model_id];
      states[d.id] = computePortStates(m, mappings[d.id], modules[d.id]);
    });
    // Faceplate crta samo prednju stranu -- oznaka = kabl spreda
    const frontMarks = Object.fromEntries(Object.entries(marks).map(([id, mk]) =>
      [id, Object.fromEntries(Object.entries(mk).filter(([, v]) => v.front).map(([k, v]) => [k, v.front]))]));
    return { modules, labels, marks: { strip: marks, face: frontMarks }, states };
  }, [data, cabling, cableIdx, models, mappings]);

  // trace izabranog porta (i isticanje svih portova na putanji)
  const selDevice = (data?.devices || []).find(d => d.id === selectedId);
  const selModel = selDevice?.model_id && models[selDevice.model_id];
  const selPortObj = selModel && selPort ? (selModel.ports || []).find(p => p.key === selPort) : null;
  useEffect(() => {
    setTrace(null);
    if (!tenantId || !selectedId || !selPortObj || ['power', 'usb', 'outlet'].includes(selPortObj.type)) return;
    let live = true;
    api.get(`/tenants/${tenantId}/infra/trace`, { params: { deviceId: selectedId, port: selPortObj.key } })
      .then(r => { if (live) setTrace(r.data.path); }).catch(() => {});
    return () => { live = false; };
  }, [tenantId, selectedId, selPortObj?.key, cabling]);  // eslint-disable-line
  const highlights = useMemo(() => {
    const h = new Map();
    (trace || []).forEach(x => {
      if (x.kind !== 'port' || (x.deviceId === selectedId && x.port === selPort)) return;
      if (!h.has(x.deviceId)) h.set(x.deviceId, new Set());
      h.get(x.deviceId).add(x.port);
    });
    return h;
  }, [trace, selectedId, selPort]);

  const racks = data?.racks || [];
  if (portsRackId && !racks.some(r => r.id === portsRackId) && data) setTimeout(() => setPortsRackId(null));
  const portsRack = racks.find(r => r.id === portsRackId);
  const devices = data?.devices || [];
  const unplaced = devices.filter(d => !d.rack_id);
  const selected = devices.find(d => d.id === selectedId);
  const modelSummary = id => modelList.find(m => m.id === id);
  const isRackable = d => !d.model_id || (modelSummary(d.model_id)?.heightU ?? 1) > 0;

  // skok na port (drugi kraj kabla, tacka u trace-u)
  const jumpTo = (devId, port, rid) => {
    if (rid && rid !== roomId) { navigate(`/infra/rooms/${rid}`, { state: { dev: devId, port } }); return; }
    const d = devices.find(x => x.id === devId);
    if (!d) return;
    if (portsRackId) setPortsRackId(d.rack_id || null);
    setSelectedId(devId); setSelPort(port);
  };
  const portDetail = (selDevice && selPortObj) ? (
    <PortDetail tenantId={tenantId} device={selDevice} model={selModel} port={selPortObj} room={data.room}
      mapping={mappings[selDevice.id]} info={cabling.ports?.[selDevice.id]?.[selPortObj.key]} cableIdx={cableIdx}
      trace={trace} canManage={canManage} onChanged={loadCabling} onJump={jumpTo}
      onConnect={side => setCableDlg({ open: true, from: {
        deviceId: selDevice.id, deviceName: selDevice.name, port: selPortObj.key, side, portType: selPortObj.type } })}
      onEditCable={(cable, self, other) => setCableDlg({ open: true, edit: { cable, self, other } })} />
  ) : null;

  const place = async (deviceId, rackId, position) => {
    try {
      await api.patch(`/tenants/${tenantId}/infra/devices/${deviceId}/place`, { rackId, position });
      setErr('');
    } catch (e) { setErr(errMsg(e, 'Premeštanje nije uspelo')); }
    load();
  };

  const onDrop = (rack, pv) => {
    const drag = dragRef.current;
    dragRef.current = null; setPreview(null);
    if (!drag) return;
    if (!drag.rackable) { setErr('Ovaj model ne ide u rack'); return; }
    if (!pv.ok) { setErr('Uređaj tu ne staje (zauzeto ili van racka)'); return; }
    place(drag.id, rack.id, pv.position);
  };

  const doConfirm = async () => {
    const c = confirm; setConfirm(null);
    try {
      if (c.kind === 'rack') await api.delete(`/tenants/${tenantId}/infra/racks/${c.item.id}`);
      if (c.kind === 'device') { await api.delete(`/tenants/${tenantId}/infra/devices/${c.item.id}`); setSelectedId(null); }
    } catch (e) { setErr(errMsg(e, 'Brisanje nije uspelo')); }
    load();
  };

  if (!data) {
    return err ? <Alert type="error" message={err} /> : <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam…</div>;
  }
  const { room } = data;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/infra" className="btn-ghost p-1.5"><ArrowLeft size={16} /></Link>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold truncate">{room.name}</h1>
            <p className="text-xs text-gray-500">{[room.location, room.floor].filter(Boolean).join(' · ') || '—'}</p>
          </div>
          {canManage && <button className="btn-ghost p-1.5" title="Izmeni lokaciju" onClick={() => setRoomForm(true)}><Pencil size={14} /></button>}
        </div>
        <div className="flex gap-2 items-center">
        {canManage && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setRackForm({ open: true, rack: null })}><Plus size={16} /> Rack</button>
            <button className="btn-primary" onClick={() => setDevForm({ open: true, device: null, preset: null })}><Plus size={16} /> Uređaj</button>
          </div>
        )}
        </div>
      </div>

      {err && <Alert type="error" message={err} onClose={() => setErr('')} />}

      {portsRack ? (
        <RackPortsView rack={portsRack} devices={devices.filter(d => d.rack_id === portsRack.id)} models={models}
          mappings={mappings} states={states} marks={marks.strip} highlights={highlights} labels={labels}
          selectedId={selectedId} selPort={selPort} onPick={(id, port) => { setSelectedId(id); setSelPort(port); }}
          canManage={canManage} onBack={() => setPortsRackId(null)}
          onEdit={d => setDevForm({ open: true, device: d, preset: null })}
          onUnplace={d => place(d.id, null, null)}
          onDelete={d => setConfirm({ kind: 'device', item: d })}>
          {portDetail}
        </RackPortsView>
      ) : (
      <div className="flex gap-4 items-start">
        {/* sa strane: uredjaji bez mesta u racku -- i zona za skidanje iz racka */}
        <div className="w-56 flex-shrink-0 sticky top-16"
          onDragOver={e => { if (dragRef.current) e.preventDefault(); }}
          onDrop={e => {
            e.preventDefault();
            const drag = dragRef.current; dragRef.current = null; setPreview(null);
            const d = drag && devices.find(x => x.id === drag.id);
            if (d?.rack_id) place(d.id, null, null);
          }}>
          <div className="card p-3 min-h-[160px]">
            <p className="text-sm font-medium mb-1">Van racka <span className="text-gray-500 font-normal">({unplaced.length})</span></p>
            <p className="text-[11px] text-gray-500 mb-2">{canManage ? 'Prevuci u rack, ili iz racka ovde.' : 'Uređaji koji nisu u racku.'}</p>
            <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
              {unplaced.length === 0 && <p className="text-xs text-gray-600 py-4 text-center border border-dashed border-gray-800 rounded-lg">prazno</p>}
              {unplaced.map(d => {
                const rackable = isRackable(d);
                return (
                  <div key={d.id} draggable={canManage && rackable}
                    onDragStart={e => {
                      dragRef.current = { id: d.id, h: d.height_u, grabRow: 0, rackable };
                      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id);
                    }}
                    onDragEnd={() => { dragRef.current = null; setPreview(null); }}
                    onClick={() => setSelectedId(d.id)}
                    className={`px-2.5 py-2 rounded-lg border text-xs flex items-center gap-1.5 ${selectedId === d.id ? 'border-brand-500' : 'border-gray-700'} ${canManage && rackable ? 'cursor-grab' : 'cursor-pointer'} bg-gray-800/60`}>
                    {d.linked_kind && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[d.linked_status] || 'bg-gray-600'}`} />}
                    <span className="truncate flex-1">{d.name}</span>
                    <span className="text-gray-500 flex-shrink-0">{rackable ? `${d.height_u}U` : 'ne ide u rack'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-4">
          {racks.length === 0 ? (
            <div className="card text-sm text-gray-400">
              Lokacija još nema rack. {canManage && <button className="text-brand-400 hover:underline" onClick={() => setRackForm({ open: true, rack: null })}>Dodaj rack</button>}
            </div>
          ) : (
            <div className="overflow-x-auto pb-2">
              <div className="flex gap-6">
                {racks.map(r => (
                  <RackColumn key={r.id} rack={r} devices={devices.filter(d => d.rack_id === r.id)} models={models}
                    rowH={ROW_H} states={states} modules={modules} marks={marks.face} highlights={highlights} selPort={selPort}
                    onToggleFocus={id => {
                      setPortsRackId(id);
                      if (selDevice?.rack_id !== id) { setSelectedId(null); setSelPort(null); }
                      window.scrollTo({ top: 0 });
                    }}
                    onPortClick={(id, port) => { setSelectedId(id); setSelPort(port); }}
                    canManage={canManage} selectedId={selectedId} onSelect={id => { setSelectedId(id); setSelPort(null); }}
                    onEmptyClick={(rack, u) => setDevForm({ open: true, device: null, preset: { rackId: rack.id, position: u } })}
                    onEdit={rack => setRackForm({ open: true, rack })}
                    onDelete={rack => setConfirm({ kind: 'rack', item: rack })}
                    dragRef={dragRef} preview={preview} setPreview={setPreview} onDrop={onDrop} />
                ))}
              </div>
            </div>
          )}

        </div>

        {selected && (
          <div className="w-[420px] flex-shrink-0 sticky top-16">
            <DevicePanel device={selected} rack={racks.find(r => r.id === selected.rack_id)}
              model={selected.model_id ? models[selected.model_id] : null} canManage={canManage}
              mapping={mappings[selected.id]} states={states[selected.id]} modules={modules[selected.id]}
              marks={marks.face[selected.id]} highlight={highlights.get(selected.id)}
              selPort={selPort} onPortClick={setSelPort}
              onClose={() => setSelectedId(null)}
              onEdit={() => setDevForm({ open: true, device: selected, preset: null })}
              onUnplace={() => place(selected.id, null, null)}
              onDelete={() => setConfirm({ kind: 'device', item: selected })}>
              {portDetail}
            </DevicePanel>
          </div>
        )}
      </div>
      )}

      <DeviceForm open={devForm.open} device={devForm.device} preset={devForm.preset} room={room} racks={racks}
        devices={devices} models={models}
        tenantId={tenantId} modelList={modelList}
        onClose={() => setDevForm({ open: false })}
        onSaved={() => { setDevForm({ open: false }); load(); }} />
      <CableDialog open={cableDlg.open} tenantId={tenantId} room={room} from={cableDlg.from} edit={cableDlg.edit}
        onClose={() => setCableDlg({ open: false })}
        onSaved={() => { setCableDlg({ open: false }); loadCabling(); }} />
      <RackForm open={rackForm.open} rack={rackForm.rack} roomId={room.id} tenantId={tenantId}
        onClose={() => setRackForm({ open: false })}
        onSaved={() => { setRackForm({ open: false }); load(); }} />
      <RoomForm open={roomForm} room={room} tenantId={tenantId}
        onClose={() => setRoomForm(false)} onSaved={() => { setRoomForm(false); load(); }} />
      <ConfirmDialog open={!!confirm} danger
        title={confirm?.kind === 'rack' ? 'Brisanje racka' : 'Brisanje uređaja'}
        message={confirm?.kind === 'rack'
          ? `Obrisati rack "${confirm?.item.name}"? Uređaji iz njega prelaze u "Van racka".`
          : `Obrisati uređaj "${confirm?.item.name}" iz dokumentacije? Monitoring se ne menja.`}
        onConfirm={doConfirm} onCancel={() => setConfirm(null)} />
    </div>
  );
}
