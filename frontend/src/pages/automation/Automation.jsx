import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, Zap, History } from 'lucide-react';
import { Table, Modal, Alert, Spinner, Empty, ConfirmDialog } from '../../components/ui';
import useAuthStore from '../../store/authStore';
import api from '../../services/api';

const TRIGGER_LABELS = {
  offline: 'Server otisao offline',
  recovery: 'Server se oporavio',
  cpu_high: 'CPU visok',
  ram_high: 'RAM visok',
  disk_high: 'Disk visok',
  exec_failed: 'Ad-hoc izvrsavanje neuspesno',
  scheduled_exec_failed: 'Zakazano izvrsavanje neuspesno',
};
const THRESHOLD_TRIGGERS = ['cpu_high', 'ram_high', 'disk_high'];

// F mora biti VAN forme -- inace se re-kreira na svakom render-u
function F({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

function relTime(iso) {
  if (!iso) return null;
  const diff = (new Date(iso) - new Date()) / 60000;
  const mins = Math.abs(Math.round(diff));
  const label =
    mins < 1 ? 'sad' :
    mins < 60 ? `${mins} min` :
    mins < 1440 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `za ${label}` : `pre ${label}`;
}

const RuleForm = React.memo(function RuleForm({ tenantId, rule, scripts, servers, onSave, onClose }) {
  const isEdit = !!rule?.id;
  const [form, setForm] = useState(() => ({
    name: rule?.name || '',
    serverId: rule?.server_id || '',
    triggerType: rule?.trigger_type || 'offline',
    thresholdPercent: rule?.threshold_percent ?? 90,
    scriptId: rule?.script_id || (scripts[0]?.id || ''),
    cooldownMinutes: rule?.cooldown_minutes ?? 15,
    enabled: rule?.enabled ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const needsThreshold = THRESHOLD_TRIGGERS.includes(form.triggerType);

  const handleSave = async () => {
    if (!form.name || !form.scriptId) { setError('Naziv i skripta su obavezni'); return; }
    if (needsThreshold && (!form.thresholdPercent || form.thresholdPercent < 1 || form.thresholdPercent > 100)) {
      setError('Prag mora biti izmedju 1 i 100'); return;
    }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        thresholdPercent: needsThreshold ? form.thresholdPercent : null,
      };
      if (isEdit) await api.put(`/tenants/${tenantId}/automation-rules/${rule.id}`, payload);
      else        await api.post(`/tenants/${tenantId}/automation-rules`, payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <Alert type="error" message={error} />}
      <F label="Naziv pravila">
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
      </F>
      <F label="Server">
        <select className="input" value={form.serverId} onChange={e => set('serverId', e.target.value)}>
          <option value="">— Svi serveri —</option>
          {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </F>
      <F label="Trigger">
        <select className="input" value={form.triggerType} onChange={e => set('triggerType', e.target.value)}>
          {Object.entries(TRIGGER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </F>
      {needsThreshold && (
        <F label="Prag (%)">
          <input className="input" type="number" min="1" max="100" value={form.thresholdPercent}
            onChange={e => set('thresholdPercent', parseInt(e.target.value) || 0)} />
        </F>
      )}
      <F label="Skripta">
        <select className="input" value={form.scriptId} onChange={e => set('scriptId', e.target.value)}>
          <option value="">— Odaberi skriptu —</option>
          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </F>
      <F label="Cooldown (minuta)">
        <input className="input" type="number" min="0" value={form.cooldownMinutes}
          onChange={e => set('cooldownMinutes', parseInt(e.target.value) || 0)} />
        <p className="text-xs text-gray-600 mt-1">
          Koliko minuta da se sačeka pre ponovnog pokretanja istog pravila na istom serveru.
        </p>
      </F>
      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
        Aktivno
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj' : 'Napravi')}
        </button>
      </div>
    </div>
  );
});

export default function Automation() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_scripts_manage');

  const [tab,        setTab]        = useState('rules'); // 'rules' | 'history'
  const [rules,       setRules]      = useState([]);
  const [scripts,     setScripts]    = useState([]);
  const [servers,     setServers]    = useState([]);
  const [history,     setHistory]    = useState([]);
  const [loading,     setLoading]    = useState(true);
  const [modal,       setModal]      = useState(null); // null | 'add' | rule
  const [delConfirm,  setDelConfirm] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [rulesRes, scriptRes, serverRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/automation-rules`),
        api.get(`/tenants/${tenantId}/scripts`),
        api.get(`/tenants/${tenantId}/servers`),
      ]);
      setRules(rulesRes.data);
      setScripts(scriptRes.data);
      setServers(serverRes.data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  const fetchHistory = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get(`/tenants/${tenantId}/automation-rules/history`);
      setHistory(res.data);
    } catch {}
  }, [tenantId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  const handleToggle = async (r) => {
    try {
      await api.put(`/tenants/${tenantId}/automation-rules/${r.id}`, {
        name: r.name, serverId: r.server_id, triggerType: r.trigger_type,
        thresholdPercent: r.threshold_percent, scriptId: r.script_id,
        cooldownMinutes: r.cooldown_minutes, enabled: !r.enabled,
      });
      fetchAll();
    } catch (err) {
      alert(err.response?.data?.detail || 'Greška');
    }
  };

  const handleDelete = async (r) => {
    try {
      await api.delete(`/tenants/${tenantId}/automation-rules/${r.id}`);
      setRules(prev => prev.filter(x => x.id !== r.id));
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
          <h1 className="text-lg font-semibold text-gray-100">Automatizacija</h1>
          <p className="text-sm text-gray-500">{rules.length} pravila u {activeTenant?.name}</p>
        </div>
        {tab === 'rules' && canManage && (
          <button className="btn-primary" onClick={() => setModal('add')} disabled={scripts.length === 0}>
            <Plus size={16} /> Novo pravilo
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-gray-800">
        <button
          className={`px-3 py-2 text-sm ${tab === 'rules' ? 'text-brand-400 border-b-2 border-brand-400' : 'text-gray-500'}`}
          onClick={() => setTab('rules')}>Pravila</button>
        <button
          className={`px-3 py-2 text-sm ${tab === 'history' ? 'text-brand-400 border-b-2 border-brand-400' : 'text-gray-500'}`}
          onClick={() => setTab('history')}>Istorija</button>
      </div>

      {tab === 'rules' && (
        <>
          {scripts.length === 0 && (
            <Alert type="info" message="Prvo napravi bar jednu skriptu na stranici 'Skripte' da bi mogao da praviš pravila automatizacije." />
          )}
          {rules.length === 0 ? (
            <Empty icon={Zap} title="Nema pravila automatizacije"
              subtitle="Napravi pravilo koje će automatski pokretati skripte na osnovu događaja sa servera"
              action={canManage && scripts.length > 0 && (
                <button className="btn-primary" onClick={() => setModal('add')}>
                  <Plus size={14} /> Novo pravilo
                </button>
              )} />
          ) : (
            <div className="card p-0 overflow-hidden">
              <Table
                columns={[
                  { key: 'name', label: 'Naziv', render: r => (
                    <div>
                      <div className="font-medium text-gray-200">{r.name}</div>
                      <div className="text-xs text-gray-600">{r.script_name}</div>
                    </div>
                  )},
                  { key: 'trigger', label: 'Trigger', render: r => (
                    <div className="text-xs">
                      <div className="text-gray-300">{TRIGGER_LABELS[r.trigger_type] || r.trigger_type}</div>
                      {r.threshold_percent != null && <div className="text-gray-600">prag: {r.threshold_percent}%</div>}
                    </div>
                  )},
                  { key: 'server', label: 'Server', render: r => (
                    <span className="text-xs text-gray-400">{r.server_name || 'Svi serveri'}</span>
                  )},
                  { key: 'cooldown', label: 'Cooldown', render: r => (
                    <span className="text-xs text-gray-500">{r.cooldown_minutes} min</span>
                  )},
                  { key: 'status', label: 'Status', render: r => (
                    <span className={r.enabled ? 'badge-green' : 'badge-gray'}>
                      {r.enabled ? 'Aktivno' : 'Isključeno'}
                    </span>
                  )},
                  { key: 'actions', label: '', render: r => (
                    <div className="flex items-center gap-1">
                      {canManage && (
                        <>
                          <button className="btn-ghost py-1 px-2 text-xs" onClick={() => handleToggle(r)}
                            title={r.enabled ? 'Isključi' : 'Uključi'}>
                            {r.enabled ? 'Isključi' : 'Uključi'}
                          </button>
                          <button className="btn-ghost py-1 px-2" onClick={() => setModal(r)} title="Uredi">
                            <Edit size={13} />
                          </button>
                          <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                            onClick={() => setDelConfirm(r)} title="Obriši">
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  )},
                ]}
                rows={rules}
              />
            </div>
          )}
        </>
      )}

      {tab === 'history' && (
        history.length === 0 ? (
          <Empty icon={History} title="Nema automatizovanih izvršavanja"
            subtitle="Ovde će se pojaviti izvršavanja pokrenuta pravilima automatizacije" />
        ) : (
          <div className="card p-0 overflow-hidden">
            <Table
              columns={[
                { key: 'rule', label: 'Pravilo', render: h => (
                  <div>
                    <div className="font-medium text-gray-200">{h.rule_name || '(obrisano pravilo)'}</div>
                    <div className="text-xs text-gray-600">{TRIGGER_LABELS[h.trigger_type] || h.trigger_type}</div>
                  </div>
                )},
                { key: 'script', label: 'Skripta', render: h => (
                  <span className="text-xs text-gray-400">{h.script_name}</span>
                )},
                { key: 'status', label: 'Status', render: h => (
                  <span className={
                    h.status === 'done' ? 'text-green-500' :
                    h.status === 'failed' ? 'text-red-500' : 'text-yellow-500'
                  }>{h.status}</span>
                )},
                { key: 'when', label: 'Pokrenuto', render: h => (
                  <span className="text-xs text-gray-500">{relTime(h.started_at) || '—'}</span>
                )},
              ]}
              rows={history}
            />
          </div>
        )
      )}

      <Modal open={!!modal} onClose={() => setModal(null)}
        title={modal === 'add' ? 'Novo pravilo automatizacije' : `Uredi: ${modal?.name}`}>
        {modal && (
          <RuleForm
            tenantId={tenantId}
            rule={modal === 'add' ? null : modal}
            scripts={scripts}
            servers={servers}
            onSave={() => { setModal(null); fetchAll(); }}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši pravilo?"
        message={`Da li sigurno želiš da obrišeš pravilo "${delConfirm?.name}"?`}
        onConfirm={() => handleDelete(delConfirm)}
        onCancel={() => setDelConfirm(null)}
        danger
      />
    </div>
  );
}
