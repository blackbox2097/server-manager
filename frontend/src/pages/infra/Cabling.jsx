// src/pages/infra/Cabling.jsx
// Pecovanje: detalji porta (modul, oznaka, kabl na svakoj strani, trace) i
// dijalog za povezivanje dva porta kablom. Portovi dolaze iz modela, a u bazi
// je samo ono sto je korisnik zapisao (vidi /infra/rooms/{id}/cabling).
import React, { useEffect, useMemo, useState } from 'react';
import { Cable, Pencil, Unlink, ArrowRight } from 'lucide-react';
import api from '../../services/api';
import { Alert, Spinner } from '../../components/ui';
import { CABLE_COLORS, cableHex } from '../../components/rack/Faceplate';
import { loadModel, MODULE_TYPES } from '../../components/rack/deviceModels';
import PortStrip, { STATE_LABEL, STRIP_CLS } from '../../components/rack/PortStrip';

export const MODULE_LABEL = {
  none: 'prazan (bez modula)', '1G-SX': '1G SX (MM)', '1G-LX': '1G LX (SM)', '1G-T': '1G RJ45',
  '10G-SR': '10G SR (MM)', '10G-LR': '10G LR (SM)', '10G-DAC': '10G DAC', '10G-T': '10G RJ45',
  '25G-SR': '25G SR', '25G-LR': '25G LR', '40G-SR4': '40G SR4', '40G-LR4': '40G LR4', BiDi: 'BiDi', other: 'drugo',
};
export const CABLE_TYPES = ['Cat5e', 'Cat6', 'Cat6a', 'Cat7', 'OM3', 'OM4', 'OS2', 'DAC', 'AOC', 'Konzolni', 'Drugo'];
const SIDE_LABEL = { front: 'spreda', rear: 'pozadi' };

export const errMsg = (e, d) => e?.response?.data?.detail
  ? (typeof e.response.data.detail === 'string' ? e.response.data.detail : e.response.data.detail.map(x => x.msg).join('; '))
  : d;

export const portLabel = key => (key?.endsWith('@sfp') ? `${key.slice(0, -4)} (SFP)` : key);

/** Indeks kablova: "uredjaj|port|strana" -> { cable, self, other } */
export function indexCables(cables) {
  const idx = new Map();
  (cables || []).forEach(c => {
    const [a, b] = c.ends;
    idx.set(`${a.deviceId}|${a.port}|${a.side}`, { cable: c, self: a, other: b });
    idx.set(`${b.deviceId}|${b.port}|${b.side}`, { cable: c, self: b, other: a });
  });
  return idx;
}

/** Oznake kablova za traku/plocu jednog uredjaja: { kljuc: {front, rear} } */
export function cableMarks(idx, deviceId) {
  const out = {};
  idx.forEach((v, k) => {
    const [d, port, side] = k.split('|');
    if (d === deviceId) (out[port] ||= {})[side] = v.cable.color || true;
  });
  return out;
}

const cableText = c => [c.cableType, c.color, c.lengthM ? `${c.lengthM} m` : null].filter(Boolean).join(' · ');

function ColorDot({ color }) {
  if (!color) return null;
  return <span className="inline-block w-2.5 h-2.5 rounded-full border border-black/40 align-middle" style={{ background: cableHex(color) }} />;
}

// ── detalji porta ───────────────────────────────────────────────────────────
export function PortDetail({ tenantId, device, model, port, mapping, info, cableIdx, trace, canManage, room,
                             onChanged, onConnect, onEditCable, onJump }) {
  const [label, setLabel] = useState(info?.label || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [askDel, setAskDel] = useState(null);
  useEffect(() => { setLabel(info?.label || ''); setErr(''); setAskDel(null); }, [device.id, port.key, info?.label]);

  const st = mapping?.state?.[port.name];
  const iface = mapping?.byPort?.[port.name]?.iface;
  const cableable = !['power', 'usb', 'outlet'].includes(port.type);
  const sides = model.passthrough ? [['front', 'Prednja strana'], ['rear', 'Zadnja strana']] : [['front', null]];

  const saveInfo = async patch => {
    setBusy(true); setErr('');
    try {
      await api.put(`/tenants/${tenantId}/infra/port-info`, {
        deviceId: device.id, port: port.key, module: info?.module ?? null, label: info?.label ?? null,
        notes: info?.notes ?? null, ...patch,
      });
      onChanged();
    } catch (e) { setErr(errMsg(e, 'Čuvanje nije uspelo')); }
    setBusy(false);
  };
  const disconnect = async cable => {
    setAskDel(null); setErr('');
    try { await api.delete(`/tenants/${tenantId}/infra/cables/${cable.id}`); onChanged(); }
    catch (e) { setErr(errMsg(e, 'Otkačinjanje nije uspelo')); }
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-gray-500">Izabrani port</p>
        <p className="font-mono font-semibold">{device.name} · {portLabel(port.key)}</p>
      </div>
      {err && <Alert type="error" message={err} onClose={() => setErr('')} />}
      {mapping ? (
        <p className="flex items-center gap-2 text-sm">
          <span className={`inline-block w-3 h-3 rounded-sm border ${STRIP_CLS[st] || STRIP_CLS.unknown}`} />
          {STATE_LABEL[st] || STATE_LABEL.unknown}
        </p>
      ) : device.network_device_id ? <p className="text-sm text-gray-500">Nema SNMP podataka.</p> : null}
      <div className="grid grid-cols-2 gap-y-1.5 text-sm">
        <span className="text-gray-500">Tip porta</span><span className="font-mono">{port.type.toUpperCase()}</span>
        {port.speed && <><span className="text-gray-500">Brzina</span><span className="font-mono">{port.speed}</span></>}
        {port.poe && <><span className="text-gray-500">PoE</span><span className="font-mono">PoE-{port.poe}</span></>}
        {port.combo && <><span className="text-gray-500">Combo</span><span className="font-mono">deli port sa RJ45</span></>}
        {iface && <>
          <span className="text-gray-500">SNMP ime</span><span className="font-mono">{iface.if_name}{mapping.byPort[port.name].how === 'redosled' ? ' *' : ''}</span>
          {iface.if_alias && <><span className="text-gray-500">Opis</span><span>{iface.if_alias}</span></>}
          {iface.oper_status === 'up' && iface.if_speed_bps > 0 && <><span className="text-gray-500">Trenutna brzina</span>
            <span className="font-mono">{iface.if_speed_bps >= 1e9 ? `${iface.if_speed_bps / 1e9}G` : `${Math.round(iface.if_speed_bps / 1e6)}M`}</span></>}
        </>}
      </div>
      {iface && mapping.byPort[port.name].how === 'redosled' && <p className="text-xs text-gray-500">* povezano po redosledu (port je preimenovan na uređaju)</p>}

      {cableable && (
        <div className="space-y-2">
          {MODULE_TYPES.has(port.type) && (
            <div className="grid grid-cols-[90px_1fr] items-center gap-2">
              <label className="text-sm text-gray-500">Modul</label>
              <select className="input py-1 text-sm" disabled={!canManage || busy} value={info?.module || ''}
                onChange={e => saveInfo({ module: e.target.value || null })}>
                <option value="">— nije uneto —</option>
                {Object.entries(MODULE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-[90px_1fr] items-center gap-2">
            <label className="text-sm text-gray-500">Oznaka</label>
            <input className="input py-1 text-sm" disabled={!canManage || busy} value={label} placeholder={canManage ? 'npr. kancelarija 12' : ''}
              onChange={e => setLabel(e.target.value)}
              onBlur={() => { if (label.trim() !== (info?.label || '')) saveInfo({ label: label.trim() || null }); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </div>
        </div>
      )}

      {cableable && (
        <div className="border-t border-gray-800 pt-3 space-y-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Kabl</p>
          {sides.map(([side, sideLabel]) => {
            const e = cableIdx.get(`${device.id}|${port.key}|${side}`);
            return (
              <div key={side} className="rounded-lg bg-gray-800/50 px-3 py-2 text-sm space-y-1.5">
                {sideLabel && <p className="text-xs text-gray-500">{sideLabel}</p>}
                {e ? (<>
                  <button className="flex items-center gap-1.5 text-left hover:text-brand-300" title="Idi na drugi kraj"
                    onClick={() => onJump(e.other.deviceId, e.other.port, e.other.roomId)}>
                    <ArrowRight size={13} className="flex-shrink-0 text-gray-500" />
                    <span className="font-mono">{e.other.deviceName} · {portLabel(e.other.port)}</span>
                    {e.other.side === 'rear' && <span className="text-xs text-gray-500">(pozadi)</span>}
                  </button>
                  <p className="text-xs text-gray-500">
                    {e.other.roomId !== room.id ? `${e.other.roomName} · ` : ''}{e.other.rackName || 'van racka'}
                  </p>
                  {(cableText(e.cable) || e.cable.label) && (
                    <p className="text-xs text-gray-300 flex items-center gap-1.5 flex-wrap">
                      <ColorDot color={e.cable.color} /> {cableText(e.cable)}
                      {e.cable.label && <span className="font-mono bg-gray-900 px-1.5 rounded">{e.cable.label}</span>}
                    </p>
                  )}
                  {e.cable.notes && <p className="text-xs text-gray-400 whitespace-pre-wrap">{e.cable.notes}</p>}
                  {canManage && (askDel === e.cable.id ? (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-gray-400">Otkačiti kabl?</span>
                      <button className="text-red-400 hover:underline" onClick={() => disconnect(e.cable)}>Da, otkači</button>
                      <button className="text-gray-400 hover:underline" onClick={() => setAskDel(null)}>Ne</button>
                    </div>
                  ) : (
                    <div className="flex gap-4 text-xs pt-0.5">
                      <button className="text-brand-400 hover:underline inline-flex items-center gap-1" onClick={() => onEditCable(e.cable, e.self, e.other)}><Pencil size={11} /> Izmeni</button>
                      <button className="text-red-400 hover:underline inline-flex items-center gap-1" onClick={() => setAskDel(e.cable.id)}><Unlink size={11} /> Otkači</button>
                    </div>
                  ))}
                </>) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-500">Nije povezan</span>
                    {canManage && <button className="btn-secondary py-1 px-2.5 text-xs" onClick={() => onConnect(side)}><Cable size={13} /> Poveži</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cableable && trace && trace.length > 1 && (
        <div className="border-t border-gray-800 pt-3">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Trace</p>
          <ol className="space-y-0.5">
            {trace.map((x, i) => x.kind === 'cable' ? (
              <li key={i} className="pl-[5px] ml-[3px] border-l-2 border-dashed border-gray-700 py-1 text-[11px] text-gray-500 flex items-center gap-1.5">
                <span className="pl-2" /><ColorDot color={x.color} />{cableText(x) || 'kabl'}{x.label && <span className="font-mono">· {x.label}</span>}
              </li>
            ) : (
              <li key={i}>
                <button onClick={() => onJump(x.deviceId, x.port, x.roomId)} disabled={x.deviceId === device.id && x.port === port.key}
                  className={`flex items-start gap-2 text-left text-xs w-full rounded px-1 py-0.5 ${x.deviceId === device.id && x.port === port.key ? 'text-brand-300' : 'hover:bg-gray-800 text-gray-200'}`}>
                  <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${i === 0 || i === trace.length - 1 ? 'bg-brand-500' : 'bg-gray-600'}`} />
                  <span className="min-w-0">
                    <span className="font-mono">{x.deviceName} · {x.portName}</span>
                    <span className="block text-gray-500">{x.roomId !== room.id ? `${x.roomName} · ` : ''}{x.rackName ? `${x.rackName} U${x.rackPosition}` : 'van racka'}{x.passthrough ? ' · panel' : ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── dijalog: novi kabl / izmena kabla ────────────────────────────────────────
function Wide({ open, onClose, title, children, footer }) {
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

/**
 * from  -- { deviceId, deviceName, port, side, portType }  (kraj od kog se krece)
 * edit  -- { cable, self, other } za izmenu postojeceg kabla (krajevi se ne menjaju)
 */
export function CableDialog({ open, tenantId, room, from, edit, onClose, onSaved }) {
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState(room.id);
  const [roomData, setRoomData] = useState(null);
  const [roomCab, setRoomCab] = useState(null);
  const [models, setModels] = useState({});
  const [devId, setDevId] = useState('');
  const [port, setPort] = useState(null);
  const [side, setSide] = useState('front');
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(''); setPort(null); setDevId(''); setSide('front'); setRoomId(room.id);
    const c = edit?.cable;
    setF(c ? { cableType: c.cableType || '', color: c.color || '', lengthM: c.lengthM ?? '', label: c.label || '', notes: c.notes || '' }
           : { cableType: from?.portType === 'rj45' ? 'Cat6' : '', color: '', lengthM: '', label: '', notes: '' });
    if (!edit) api.get(`/tenants/${tenantId}/infra/rooms`).then(r => setRooms(r.data)).catch(() => {});
  }, [open, edit, from, tenantId, room.id]);

  useEffect(() => {
    if (!open || edit) return;
    setRoomData(null); setRoomCab(null); setDevId(''); setPort(null);
    Promise.all([
      api.get(`/tenants/${tenantId}/infra/rooms/${roomId}`),
      api.get(`/tenants/${tenantId}/infra/rooms/${roomId}/cabling`),
    ]).then(async ([r, c]) => {
      const ids = [...new Set(r.data.devices.map(d => d.model_id).filter(Boolean))];
      const ms = await Promise.all(ids.map(id => loadModel(id).catch(() => null)));
      setModels(Object.fromEntries(ms.filter(Boolean).map(m => [m.id, m])));
      setRoomData(r.data); setRoomCab(c.data);
    }).catch(e => setErr(errMsg(e, 'Učitavanje lokacije nije uspelo')));
  }, [open, edit, roomId, tenantId]);

  const idx = useMemo(() => indexCables(roomCab?.cables), [roomCab]);
  // uredjaji sa portovima za kabl, grupisani po racku
  const groups = useMemo(() => {
    if (!roomData) return [];
    const ok = d => { const m = models[d.model_id]; return m && (m.ports || []).some(p => !['power', 'usb', 'outlet'].includes(p.type)); };
    const out = roomData.racks.map(r => [r.name, roomData.devices.filter(d => d.rack_id === r.id && ok(d))
      .sort((a, b) => b.rack_position - a.rack_position)]);
    out.push(['Van racka', roomData.devices.filter(d => !d.rack_id && ok(d))]);
    return out.filter(([, ds]) => ds.length);
  }, [roomData, models]);
  const dev = roomData?.devices.find(d => d.id === devId);
  const devModel = dev && models[dev.model_id];
  const busy = useMemo(() => {
    const s = new Set();
    if (!dev || !devModel) return s;
    (devModel.ports || []).forEach(p => {
      if (idx.has(`${dev.id}|${p.key}|${side}`)) s.add(p.key);
      if (dev.id === from?.deviceId && p.key === from?.port) s.add(p.key);
      if (['power', 'usb', 'outlet'].includes(p.type)) s.add(p.key);
    });
    return s;
  }, [dev, devModel, idx, side, from]);
  const labels = useMemo(() => {
    const o = {};
    Object.entries(roomCab?.ports?.[devId] || {}).forEach(([k, v]) => { if (v.label) o[k] = v.label; });
    return o;
  }, [roomCab, devId]);

  const props = () => ({
    cableType: f.cableType || null, color: f.color || null,
    lengthM: f.lengthM === '' || f.lengthM == null ? null : Number(String(f.lengthM).replace(',', '.')),
    label: f.label || null, notes: f.notes || null,
  });
  const save = async () => {
    const p = props();
    if (p.lengthM != null && !(p.lengthM > 0)) { setErr('Dužina mora biti pozitivan broj'); return; }
    if (!edit && !port) { setErr('Izaberi port na drugom kraju'); return; }
    setSaving(true); setErr('');
    try {
      if (edit) await api.put(`/tenants/${tenantId}/infra/cables/${edit.cable.id}`, p);
      else await api.post(`/tenants/${tenantId}/infra/cables`, {
        a: { deviceId: from.deviceId, port: from.port, side: from.side },
        b: { deviceId: devId, port, side }, ...p,
      });
      onSaved();
    } catch (e) { setErr(errMsg(e, 'Čuvanje nije uspelo')); }
    setSaving(false);
  };

  const fromTxt = edit
    ? `${edit.self.deviceName} · ${portLabel(edit.self.port)}${edit.self.side === 'rear' ? ' (pozadi)' : ''}`
    : `${from?.deviceName} · ${portLabel(from?.port)}${from?.side === 'rear' ? ' (pozadi)' : ''}`;
  const toTxt = edit
    ? `${edit.other.deviceName} · ${portLabel(edit.other.port)}${edit.other.side === 'rear' ? ' (pozadi)' : ''}`
    : dev && port ? `${dev.name} · ${portLabel(port)}${side === 'rear' ? ' (pozadi)' : ''}` : '…';

  return (
    <Wide open={open} onClose={onClose} title={edit ? 'Izmena kabla' : 'Novi kabl'}
      footer={<>
        <span className="flex-1 text-sm text-gray-400 font-mono truncate">{fromTxt} <span className="text-gray-600">→</span> {toTxt}</span>
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save} disabled={saving || (!edit && !port)}>{saving ? <Spinner /> : null} Sačuvaj</button>
      </>}>
      <div className="space-y-4">
        {err && <Alert type="error" message={err} />}
        {!edit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Lokacija drugog kraja</label>
                <select className="input" value={roomId} onChange={e => setRoomId(e.target.value)}>
                  {(rooms.length ? rooms : [room]).map(r => <option key={r.id} value={r.id}>{r.name}{r.location ? ` (${r.location})` : ''}</option>)}
                </select></div>
              <div><label className="label">Uređaj</label>
                <select className="input" value={devId} disabled={!roomData} onChange={e => { setDevId(e.target.value); setPort(null); setSide('front'); }}>
                  <option value="">{roomData ? '— izaberi —' : 'učitavam…'}</option>
                  {groups.map(([g, ds]) => (
                    <optgroup key={g} label={g}>
                      {ds.map(d => <option key={d.id} value={d.id}>{d.name}{d.rack_position ? ` (U${d.rack_position})` : ''}</option>)}
                    </optgroup>
                  ))}
                </select></div>
            </div>
            {roomData && !groups.length && <p className="text-sm text-gray-500">U ovoj lokaciji nema uređaja sa portovima (uređaj mora imati model).</p>}
            {devModel && (
              <div className="space-y-2">
                {devModel.passthrough && (
                  <div className="flex gap-1">
                    {[['front', 'Prednja strana (patch kabl)'], ['rear', 'Zadnja strana (instalacija)']].map(([k, l]) => (
                      <button key={k} type="button" onClick={() => { setSide(k); setPort(null); }}
                        className={`px-3 py-1.5 text-xs rounded-lg border ${side === k ? 'border-brand-500 bg-brand-600/15 text-gray-100' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>{l}</button>
                    ))}
                  </div>
                )}
                <div className="bg-gray-950 rounded-lg p-3 overflow-x-auto">
                  <PortStrip model={devModel} selected={port} onPick={setPort} disabled={busy} labels={labels}
                    cables={Object.fromEntries([...busy].filter(k => idx.has(`${dev.id}|${k}|${side}`)).map(k => [k, { [side === 'rear' ? 'rear' : 'front']: idx.get(`${dev.id}|${k}|${side}`).cable.color || true }]))} />
                </div>
                <p className="text-xs text-gray-500">Zatamnjeni portovi su već povezani{devModel.passthrough ? ` (${SIDE_LABEL[side]})` : ''}.</p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-4 gap-3">
          <div><label className="label">Tip kabla</label>
            <select className="input" value={f.cableType || ''} onChange={e => setF(p => ({ ...p, cableType: e.target.value }))}>
              <option value="">—</option>
              {CABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div><label className="label">Boja</label>
            <select className="input" value={f.color || ''} onChange={e => setF(p => ({ ...p, color: e.target.value }))}>
              <option value="">—</option>
              {CABLE_COLORS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select></div>
          <div><label className="label">Dužina (m)</label>
            <input className="input" inputMode="decimal" value={f.lengthM ?? ''} onChange={e => setF(p => ({ ...p, lengthM: e.target.value }))} /></div>
          <div><label className="label">Oznaka kabla</label>
            <input className="input" value={f.label || ''} onChange={e => setF(p => ({ ...p, label: e.target.value }))} placeholder="npr. P-014" /></div>
          <div className="col-span-4"><label className="label">Napomena</label>
            <input className="input" value={f.notes || ''} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} /></div>
        </div>
      </div>
    </Wide>
  );
}
