// src/pages/scripts/Schedules.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit, Play, Clock, PauseCircle, PlayCircle } from 'lucide-react';
import clsx from 'clsx';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import {
  Modal, ConfirmDialog, Alert, Spinner, Empty, Table
} from '../../components/ui';

const CRON_PRESETS = [
  { label: 'Svakih 15 min',        cron: '*/15 * * * *' },
  { label: 'Svakih 30 min',        cron: '*/30 * * * *' },
  { label: 'Svaki sat',            cron: '0 * * * *'    },
  { label: 'Svakih 6 sati',        cron: '0 */6 * * *'  },
  { label: 'Svaki dan u 02:00',    cron: '0 2 * * *'    },
  { label: 'Svaki dan u 09:00',    cron: '0 9 * * *'    },
  { label: 'Svakog ponedeljka u 09:00', cron: '0 9 * * 1' },
  { label: 'Prvog u mesecu u 03:00',    cron: '0 3 1 * *' },
];

function ScheduleForm({ tenantId, schedule, scripts, servers, onSave, onClose }) {
  const isEdit = !!schedule?.id;
  const [name,       setName]       = useState(schedule?.name || '');
  const [scriptId,   setScriptId]   = useState(schedule?.script_id || '');
  const [cron,       setCron]       = useState(schedule?.cron_expression || '0 2 * * *');
  const [active,     setActive]     = useState(schedule?.active ?? true);
  const [selected,   setSelected]   = useState(new Set(schedule?.server_ids || []));
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  const toggleServer = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!name.trim())   { setError('Naziv je obavezan'); return; }
    if (!scriptId)       { setError('Odaberi skriptu'); return; }
    if (!selected.size)   { setError('Odaberi bar jedan server'); return; }
    if (!cron.trim())    { setError('Cron izraz je obavezan'); return; }

    setSaving(true); setError('');
    const payload = {
      name, scriptId, cronExpression: cron, active,
      serverIds: [...selected],
    };
    try {
      if (isEdit) await api.put(`/tenants/${tenantId}/schedules/${schedule.id}`, payload);
      else        await api.post(`/tenants/${tenantId}/schedules`, payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} />}

      <div>
        <label className="label">Naziv *</label>
        <input className="input" value={name} onChange={e => setName(e.target.value)}
          placeholder="npr. Nocni apt update" />
      </div>

      <div>
        <label className="label">Skripta *</label>
        <select className="input" value={scriptId} onChange={e => setScriptId(e.target.value)}>
          <option value="">— Odaberi skriptu —</option>
          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div>
        <label className="label">Raspored (cron izraz) *</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {CRON_PRESETS.map(p => (
            <button key={p.cron} type="button"
              className={clsx('text-xs px-2 py-1 rounded-md border transition-colors',
                cron === p.cron
                  ? 'bg-brand-900/50 border-brand-700 text-brand-300'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700')}
              onClick={() => setCron(p.cron)}>
              {p.label}
            </button>
          ))}
        </div>
        <input className="input font-mono text-sm" value={cron}
          onChange={e => setCron(e.target.value)} placeholder="0 2 * * *" />
        <p className="text-xs text-gray-600 mt-1">
          Format: minut sat dan-u-mesecu mesec dan-u-nedelji (standardni cron)
        </p>
      </div>

      <div>
        <label className="label">Serveri * ({selected.size} odabrano)</label>
        <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-800 rounded-lg p-2">
          {servers.length === 0 && <p className="text-xs text-gray-600 p-2">Nema servera u ovom tenantu</p>}
          {servers.map(s => (
            <label key={s.id}
              className={clsx('flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
                selected.has(s.id) ? 'bg-brand-900/40 border border-brand-700' : 'bg-gray-800/50 border border-transparent hover:bg-gray-800')}>
              <input type="checkbox" className="accent-brand-500"
                checked={selected.has(s.id)} onChange={() => toggleServer(s.id)} />
              <span className="text-sm text-gray-300">{s.name}</span>
              <span className="text-xs text-gray-600">{s.ip_address}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" className="accent-brand-500" checked={active}
          onChange={e => setActive(e.target.checked)} />
        <span className="text-sm text-gray-300">Aktivno (odmah počinje da se izvršava po rasporedu)</span>
      </label>

      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj izmene' : 'Zakaži')}
        </button>
      </div>
    </div>
  );
}

function relTime(iso) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const label =
    mins < 60 ? `${mins} min` :
    mins < 1440 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `za ${label}` : `pre ${label}`;
}

export default function Schedules() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_scripts_manage');
  const canRun    = hasPerm('perm_scripts_run');

  const [schedules,  setSchedules]  = useState([]);
  const [scripts,    setScripts]    = useState([]);
  const [servers,    setServers]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(null); // null | 'add' | schedule
  const [delConfirm, setDelConfirm] = useState(null);
  const [running,    setRunning]    = useState(null);

  const fetchAll = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [schedRes, scriptRes, serverRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/schedules`),
        api.get(`/tenants/${tenantId}/scripts`),
        api.get(`/tenants/${tenantId}/servers`),
      ]);
      setSchedules(schedRes.data);
      setScripts(scriptRes.data);
      setServers(serverRes.data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleToggle = async (s) => {
    try {
      await api.post(`/tenants/${tenantId}/schedules/${s.id}/toggle`);
      fetchAll();
    } catch (err) {
      alert(err.response?.data?.detail || 'Greška');
    }
  };

  const handleRunNow = async (s) => {
    setRunning(s.id);
    try {
      await api.post(`/tenants/${tenantId}/schedules/${s.id}/run-now`);
      fetchAll();
    } catch (err) {
      alert(err.response?.data?.detail || 'Greška pri pokretanju');
    } finally {
      setRunning(null);
    }
  };

  const handleDelete = async (s) => {
    try {
      await api.delete(`/tenants/${tenantId}/schedules/${s.id}`);
      setSchedules(prev => prev.filter(x => x.id !== s.id));
      setDelConfirm(null);
    } catch (err) {
      setDelConfirm(null);
      alert(err.response?.data?.detail || 'Greška pri brisanju');
    }
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Zakazani poslovi</h1>
          <p className="text-sm text-gray-500">{schedules.length} zakazanih skripti u {activeTenant?.name}</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setModal('add')} disabled={scripts.length === 0}>
            <Plus size={16} /> Novo zakazivanje
          </button>
        )}
      </div>

      {scripts.length === 0 && (
        <Alert type="info" message="Prvo napravi bar jednu skriptu na stranici 'Skripte' da bi mogao da je zakažeš." />
      )}

      {schedules.length === 0 ? (
        <Empty icon={Clock} title="Nema zakazanih poslova"
          subtitle="Zakaži automatsko izvršavanje skripte po rasporedu"
          action={canManage && scripts.length > 0 && (
            <button className="btn-primary" onClick={() => setModal('add')}>
              <Plus size={14} /> Novo zakazivanje
            </button>
          )} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'name', label: 'Naziv', render: s => (
                <div>
                  <div className="font-medium text-gray-200">{s.name}</div>
                  <div className="text-xs text-gray-600">{s.script_name} · {s.server_ids.length} server{s.server_ids.length === 1 ? '' : 'a'}</div>
                </div>
              )},
              { key: 'cron', label: 'Raspored', render: s => (
                <code className="text-xs text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">{s.cron_expression}</code>
              )},
              { key: 'status', label: 'Status', render: s => (
                <span className={s.active ? 'badge-green' : 'badge-gray'}>
                  {s.active ? 'Aktivno' : 'Pauzirano'}
                </span>
              )},
              { key: 'next', label: 'Sledece pokretanje', render: s => (
                <span className="text-xs text-gray-500">{s.active ? (relTime(s.next_run_at) || '—') : '—'}</span>
              )},
              { key: 'last', label: 'Poslednje', render: s => (
                <div className="text-xs">
                  {s.last_run_at ? (
                    <>
                      <div className="text-gray-500">{relTime(s.last_run_at)}</div>
                      {s.last_status && (
                        <span className={
                          s.last_status === 'done' ? 'text-green-500' :
                          s.last_status === 'failed' ? 'text-red-500' : 'text-yellow-500'
                        }>{s.last_status}</span>
                      )}
                    </>
                  ) : <span className="text-gray-600">Nikad</span>}
                </div>
              )},
              { key: 'actions', label: '', render: s => (
                <div className="flex items-center gap-1">
                  {canRun && (
                    <button className="btn-ghost py-1 px-2" onClick={() => handleRunNow(s)}
                      disabled={running === s.id} title="Pokreni odmah">
                      {running === s.id ? <Spinner size={13} /> : <Play size={13} />}
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button className="btn-ghost py-1 px-2" onClick={() => handleToggle(s)}
                        title={s.active ? 'Pauziraj' : 'Aktiviraj'}>
                        {s.active ? <PauseCircle size={14} /> : <PlayCircle size={14} className="text-green-500" />}
                      </button>
                      <button className="btn-ghost py-1 px-2" onClick={() => setModal(s)} title="Uredi">
                        <Edit size={13} />
                      </button>
                      <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                        onClick={() => setDelConfirm(s)} title="Obriši">
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              )},
            ]}
            rows={schedules}
          />
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)}
        title={modal === 'add' ? 'Novo zakazivanje' : `Uredi: ${modal?.name}`}>
        {modal && (
          <ScheduleForm
            tenantId={tenantId}
            schedule={modal === 'add' ? null : modal}
            scripts={scripts}
            servers={servers}
            onSave={() => { setModal(null); fetchAll(); }}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši zakazani posao"
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.name}"?`}
        danger
        onConfirm={() => handleDelete(delConfirm)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
