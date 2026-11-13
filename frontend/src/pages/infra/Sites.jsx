// src/pages/infra/Sites.jsx
// Infrastruktura -> Lokacije i rackovi: spisak lokacija (objekata) tenanta.
// Lokacija -> prostorije (Site.jsx) -> rackovi (RoomView.jsx).
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2, Search, MapPin } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Alert, Spinner, Empty } from '../../components/ui';
import { SiteForm, errMsg } from './Site';

export default function Sites() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId = activeTenant?.id;
  const canManage = hasPerm('perm_network_manage');
  const navigate = useNavigate();
  const [sites, setSites] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [s, r] = await Promise.all([
        api.get(`/tenants/${tenantId}/infra/sites`), api.get(`/tenants/${tenantId}/infra/rooms`)]);
      setSites(s.data); setRooms(r.data); setErr('');
    } catch (e) { setErr(errMsg(e, 'Greška pri učitavanju')); }
  }, [tenantId]);
  useEffect(() => { setSites(null); load(); }, [load]);

  // pretraga trazi i po prostorijama -- "server sala" nadje lokaciju koja je ima
  const ql = q.trim().toLowerCase();
  const shown = (sites || []).filter(s => !ql || `${s.name} ${s.address || ''}`.toLowerCase().includes(ql)
    || rooms.some(r => r.site_id === s.id && `${r.name} ${r.floor || ''}`.toLowerCase().includes(ql)));

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <h1 className="text-xl font-semibold">Lokacije i rackovi</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input className="input pl-8 py-1.5 text-sm w-56" placeholder="Lokacija ili prostorija…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {canManage && <button className="btn-primary" onClick={() => setForm(true)}><Plus size={16} /> Nova lokacija</button>}
        </div>
      </div>

      {err && <Alert type="error" message={err} onClose={() => setErr('')} />}
      {!sites ? <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Učitavam…</div>
        : sites.length === 0 ? (
          <Empty icon={Building2} title="Još nema lokacija"
            subtitle="Lokacija je objekat (zgrada). U njoj su prostorije, a u prostorijama rackovi."
            action={canManage && <button className="btn-primary" onClick={() => setForm(true)}><Plus size={16} /> Nova lokacija</button>} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {shown.map(s => {
              const rs = rooms.filter(r => r.site_id === s.id);
              return (
                <div key={s.id} className="card hover:border-gray-600 transition-colors cursor-pointer space-y-3"
                  onClick={() => navigate(`/infra/sites/${s.id}`)}>
                  <div className="flex items-start gap-3">
                    <Building2 size={18} className="text-gray-500 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium">{s.name}</p>
                      {s.address && <p className="text-xs text-gray-500 inline-flex items-center gap-1"><MapPin size={11} /> {s.address}</p>}
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-400">
                    <span><span className="text-gray-100">{s.room_count}</span> prostorija</span>
                    <span><span className="text-gray-100">{s.rack_count}</span> rack.</span>
                    <span><span className="text-gray-100">{s.device_count}</span> uređaja</span>
                  </div>
                  {rs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" onClick={e => e.stopPropagation()}>
                      {rs.map(r => (
                        <button key={r.id} onClick={() => navigate(`/infra/rooms/${r.id}`)} title={r.floor || ''}
                          className="text-xs px-2 py-1 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100">
                          {r.name}{r.rack_count ? <span className="text-gray-500"> · {r.rack_count}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      <SiteForm open={form} tenantId={tenantId} onClose={() => setForm(false)}
        onSaved={s => { setForm(false); navigate(`/infra/sites/${s.id}`); }} />
    </div>
  );
}
