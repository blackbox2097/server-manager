// src/pages/infra/Rooms.jsx
// Infrastruktura -> Lokacije i rackovi: spisak lokacija (soba / rack ormana) tenanta.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Warehouse, Pencil, Trash2, Search, MapPin } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Modal, ConfirmDialog, Alert, Spinner, Empty } from '../../components/ui';

const errMsg = (e, d) => e?.response?.data?.detail
  ? (typeof e.response.data.detail === 'string' ? e.response.data.detail : e.response.data.detail.map(x => x.msg).join('; '))
  : d;

export function RoomForm({ open, room, tenantId, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', location: '', floor: '', notes: '' });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setF({ name: room?.name || '', location: room?.location || '', floor: room?.floor || '', notes: room?.notes || '' });
      setErr('');
    }
  }, [open, room]);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    if (!f.name.trim()) { setErr('Naziv je obavezan'); return; }
    setSaving(true); setErr('');
    try {
      if (room?.id) await api.put(`/tenants/${tenantId}/infra/rooms/${room.id}`, f);
      else await api.post(`/tenants/${tenantId}/infra/rooms`, f);
      onSaved();
    } catch (e) { setErr(errMsg(e, 'Greška pri čuvanju')); }
    setSaving(false);
  };
  return (
    <Modal open={open} onClose={onClose} title={room?.id ? 'Izmena lokacije' : 'Nova lokacija'}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null} Sačuvaj</button>
      </>}>
      <div className="space-y-3">
        {err && <Alert type="error" message={err} />}
        <div><label className="label">Naziv *</label>
          <input className="input" value={f.name} onChange={set('name')} placeholder="Server soba, Rack orman 2-1…" autoFocus /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Zgrada / adresa</label>
            <input className="input" value={f.location} onChange={set('location')} placeholder="Uprava" /></div>
          <div><label className="label">Sprat</label>
            <input className="input" value={f.floor} onChange={set('floor')} placeholder="I sprat" /></div>
        </div>
        <div><label className="label">Napomena</label>
          <textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  );
}

export default function Rooms() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');
  const navigate = useNavigate();
  const [rooms, setRooms] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ open: false, room: null });
  const [del, setDel] = useState(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try { setRooms((await api.get(`/tenants/${tenantId}/infra/rooms`)).data); setErr(''); }
    catch (e) { setErr(errMsg(e, 'Greška pri učitavanju')); }
  }, [tenantId]);
  useEffect(() => { setRooms(null); load(); }, [load]);

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const by = {};
    (rooms || []).filter(r => !ql || `${r.name} ${r.location || ''} ${r.floor || ''}`.toLowerCase().includes(ql))
      .forEach(r => { (by[r.location || 'Bez zgrade / adrese'] ||= []).push(r); });
    return Object.entries(by);
  }, [rooms, q]);

  const doDelete = async () => {
    try { await api.delete(`/tenants/${tenantId}/infra/rooms/${del.id}`); setDel(null); load(); }
    catch (e) { setDel(null); setErr(errMsg(e, 'Greška pri brisanju')); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <h1 className="text-xl font-semibold">Lokacije i rackovi</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input className="input pl-8 py-1.5 text-sm w-56" placeholder="Pretraga…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {canManage && <button className="btn-primary" onClick={() => setForm({ open: true, room: null })}><Plus size={16} /> Nova lokacija</button>}
        </div>
      </div>

      {err && <Alert type="error" message={err} onClose={() => setErr('')} />}
      {!rooms ? <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam…</div>
        : rooms.length === 0 ? (
          <Empty icon={Warehouse} title="Još nema lokacija"
            subtitle="Lokacija je soba ili rack orman: server sala, rack po spratu, ormarić u kancelariji."
            action={canManage && <button className="btn-primary" onClick={() => setForm({ open: true, room: null })}><Plus size={16} /> Nova lokacija</button>} />
        ) : groups.map(([loc, items]) => (
          <div key={loc} className="space-y-2">
            <h2 className="text-sm font-medium text-gray-400 inline-flex items-center gap-1.5"><MapPin size={14} /> {loc}</h2>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {items.map(r => {
                const pct = r.units_total ? Math.round(100 * r.units_used / r.units_total) : 0;
                return (
                  <div key={r.id} className="card hover:border-gray-600 transition-colors cursor-pointer"
                    onClick={() => navigate(`/infra/rooms/${r.id}`)}>
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-gray-500">{r.floor || '—'}</p>
                      </div>
                      {canManage && (
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                          <button className="btn-ghost p-1.5" title="Izmeni" onClick={() => setForm({ open: true, room: r })}><Pencil size={14} /></button>
                          <button className="btn-ghost p-1.5" title="Obriši" onClick={() => setDel(r)}><Trash2 size={14} /></button>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-4 text-xs text-gray-400 mt-3">
                      <span><span className="text-gray-100">{r.rack_count}</span> rack.</span>
                      <span><span className="text-gray-100">{r.device_count}</span> uređaja</span>
                      {r.units_total > 0 && <span><span className="text-gray-100">{r.units_used}</span>/{r.units_total} U</span>}
                    </div>
                    {r.units_total > 0 && (
                      <div className="meter-bar mt-2"><div className="meter-fill bg-brand-500" style={{ width: `${pct}%` }} /></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

      <RoomForm open={form.open} room={form.room} tenantId={tenantId}
        onClose={() => setForm({ open: false, room: null })}
        onSaved={() => { setForm({ open: false, room: null }); load(); }} />
      <ConfirmDialog open={!!del} danger title="Brisanje lokacije"
        message={`Obrisati lokaciju "${del?.name}" i sve njene rackove? Lokacija sa uređajima se ne može obrisati.`}
        onConfirm={doDelete} onCancel={() => setDel(null)} />
    </div>
  );
}
