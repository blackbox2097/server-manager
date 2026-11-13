// src/pages/infra/Site.jsx
// Jedna lokacija (objekat): spisak prostorija sa rackovima. Ovde su i forme
// za lokaciju i prostoriju (koriste ih i Sites.jsx i RoomView.jsx).
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Pencil, Trash2, DoorOpen, MapPin } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Modal, ConfirmDialog, Alert, Spinner, Empty } from '../../components/ui';

export const errMsg = (e, d) => e?.response?.data?.detail
  ? (typeof e.response.data.detail === 'string' ? e.response.data.detail : e.response.data.detail.map(x => x.msg).join('; '))
  : d;

export function SiteForm({ open, site, tenantId, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', address: '', notes: '' });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) { setF({ name: site?.name || '', address: site?.address || '', notes: site?.notes || '' }); setErr(''); }
  }, [open, site]);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    if (!f.name.trim()) { setErr('Naziv je obavezan'); return; }
    setSaving(true); setErr('');
    try {
      const r = site?.id ? await api.put(`/tenants/${tenantId}/infra/sites/${site.id}`, f)
                         : await api.post(`/tenants/${tenantId}/infra/sites`, f);
      onSaved(r.data);
    } catch (e) { setErr(errMsg(e, 'Greška pri čuvanju')); }
    setSaving(false);
  };
  return (
    <Modal open={open} onClose={onClose} title={site?.id ? 'Izmena lokacije' : 'Nova lokacija'}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null} Sačuvaj</button>
      </>}>
      <div className="space-y-3">
        {err && <Alert type="error" message={err} />}
        <div><label className="label">Naziv *</label>
          <input className="input" value={f.name} onChange={set('name')} placeholder="Uprava, Depo, Galerija…" autoFocus /></div>
        <div><label className="label">Adresa</label>
          <input className="input" value={f.address} onChange={set('address')} /></div>
        <div><label className="label">Napomena</label>
          <textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  );
}

export function RoomForm({ open, room, siteId, tenantId, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', floor: '', notes: '', siteId: '' });
  const [sites, setSites] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF({ name: room?.name || '', floor: room?.floor || '', notes: room?.notes || '', siteId: room?.site_id || siteId || '' });
    setErr('');
    if (room?.id) api.get(`/tenants/${tenantId}/infra/sites`).then(r => setSites(r.data)).catch(() => {});
  }, [open, room, siteId, tenantId]);
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
    <Modal open={open} onClose={onClose} title={room?.id ? 'Izmena prostorije' : 'Nova prostorija'}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null} Sačuvaj</button>
      </>}>
      <div className="space-y-3">
        {err && <Alert type="error" message={err} />}
        <div><label className="label">Naziv *</label>
          <input className="input" value={f.name} onChange={set('name')} placeholder="Server sala, Rack orman hodnik…" autoFocus /></div>
        <div><label className="label">Sprat</label>
          <input className="input" value={f.floor} onChange={set('floor')} placeholder="prizemlje, I sprat…" /></div>
        {room?.id && sites.length > 1 && (
          <div><label className="label">Lokacija</label>
            <select className="input" value={f.siteId} onChange={set('siteId')}>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {f.siteId !== room.site_id && <p className="text-xs text-yellow-400 mt-1">Prostorija prelazi u drugu lokaciju zajedno sa svim rackovima i uređajima.</p>}
          </div>
        )}
        <div><label className="label">Napomena</label>
          <textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  );
}

export function RoomCard({ r, canManage, onOpen, onEdit, onDelete }) {
  const pct = r.units_total ? Math.round(100 * r.units_used / r.units_total) : 0;
  return (
    <div className="card hover:border-gray-600 transition-colors cursor-pointer" onClick={onOpen}>
      <div className="flex justify-between items-start gap-2">
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-gray-500">{r.floor || '—'}</p>
        </div>
        {canManage && (
          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
            <button className="btn-ghost p-1.5" title="Izmeni" onClick={onEdit}><Pencil size={14} /></button>
            <button className="btn-ghost p-1.5" title="Obriši" onClick={onDelete}><Trash2 size={14} /></button>
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
}

export default function Site() {
  const { siteId } = useParams();
  const navigate = useNavigate();
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');
  const firstTenant = React.useRef(tenantId);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [roomForm, setRoomForm] = useState({ open: false, room: null });
  const [siteForm, setSiteForm] = useState(false);
  const [del, setDel] = useState(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try { setData((await api.get(`/tenants/${tenantId}/infra/sites/${siteId}`)).data); setErr(''); }
    catch (e) { if (e?.response?.status === 404) navigate('/infra'); else setErr(errMsg(e, 'Greška pri učitavanju')); }
  }, [tenantId, siteId, navigate]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (firstTenant.current && tenantId !== firstTenant.current) navigate('/infra'); }, [tenantId, navigate]);

  const doDelete = async () => {
    const d = del; setDel(null);
    try {
      if (d.kind === 'site') { await api.delete(`/tenants/${tenantId}/infra/sites/${siteId}`); navigate('/infra'); return; }
      await api.delete(`/tenants/${tenantId}/infra/rooms/${d.item.id}`); load();
    } catch (e) { setErr(errMsg(e, 'Greška pri brisanju')); }
  };

  if (!data) return err ? <Alert type="error" message={err} /> : <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam…</div>;
  const { site, rooms } = data;
  const floors = {};
  rooms.forEach(r => { (floors[r.floor || 'Bez sprata'] ||= []).push(r); });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/infra" className="btn-ghost p-1.5" title="Sve lokacije"><ArrowLeft size={16} /></Link>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold truncate">{site.name}</h1>
            <p className="text-xs text-gray-500 inline-flex items-center gap-1">{site.address ? <><MapPin size={11} /> {site.address}</> : 'Lokacija'}</p>
          </div>
          {canManage && <>
            <button className="btn-ghost p-1.5" title="Izmeni lokaciju" onClick={() => setSiteForm(true)}><Pencil size={14} /></button>
            <button className="btn-ghost p-1.5" title="Obriši lokaciju" onClick={() => setDel({ kind: 'site' })}><Trash2 size={14} /></button>
          </>}
        </div>
        {canManage && <button className="btn-primary" onClick={() => setRoomForm({ open: true, room: null })}><Plus size={16} /> Nova prostorija</button>}
      </div>

      {err && <Alert type="error" message={err} onClose={() => setErr('')} />}
      {site.notes && <p className="text-sm text-gray-400 whitespace-pre-wrap">{site.notes}</p>}

      {rooms.length === 0 ? (
        <Empty icon={DoorOpen} title="Lokacija još nema prostorija"
          subtitle="Prostorija je mesto sa rackovima: server sala, rack orman u hodniku, ormarić u kancelariji."
          action={canManage && <button className="btn-primary" onClick={() => setRoomForm({ open: true, room: null })}><Plus size={16} /> Nova prostorija</button>} />
      ) : Object.entries(floors).map(([fl, items]) => (
        <div key={fl} className="space-y-2">
          <h2 className="text-sm font-medium text-gray-400">{fl}</h2>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {items.map(r => (
              <RoomCard key={r.id} r={r} canManage={canManage}
                onOpen={() => navigate(`/infra/rooms/${r.id}`)}
                onEdit={() => setRoomForm({ open: true, room: { ...r, site_id: site.id } })}
                onDelete={() => setDel({ kind: 'room', item: r })} />
            ))}
          </div>
        </div>
      ))}

      <RoomForm open={roomForm.open} room={roomForm.room} siteId={site.id} tenantId={tenantId}
        onClose={() => setRoomForm({ open: false, room: null })}
        onSaved={() => { setRoomForm({ open: false, room: null }); load(); }} />
      <SiteForm open={siteForm} site={site} tenantId={tenantId}
        onClose={() => setSiteForm(false)} onSaved={() => { setSiteForm(false); load(); }} />
      <ConfirmDialog open={!!del} danger
        title={del?.kind === 'site' ? 'Brisanje lokacije' : 'Brisanje prostorije'}
        message={del?.kind === 'site'
          ? `Obrisati lokaciju "${site.name}"? Lokacija sa prostorijama se ne može obrisati.`
          : `Obrisati prostoriju "${del?.item?.name}" i njene rackove? Prostorija sa uređajima se ne može obrisati.`}
        onConfirm={doDelete} onCancel={() => setDel(null)} />
    </div>
  );
}
