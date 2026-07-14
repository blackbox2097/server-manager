// src/pages/admin/Admin.jsx
// Superadmin panel — upravljanje tenantima i operaterima

import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, Users, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import api from '../../services/api';
import { Modal, ConfirmDialog, Alert, Spinner, Empty, Table } from '../../components/ui';
import clsx from 'clsx';

// ── Tenant forma ──────────────────────────────────────────────────────────────
function TenantForm({ tenant, onSave, onClose }) {
  const isEdit = !!tenant?.id;
  const [form, setForm] = useState({ name: '', slug: '', color: '#378ADD', description: '', ...(tenant || {}) });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleSave = async () => {
    if (!form.name || !form.slug) { setError('Naziv i slug su obavezni'); return; }
    setSaving(true); setError('');
    try {
      if (isEdit) await api.put(`/admin/tenants/${tenant.id}`, form);
      else        await api.post('/admin/tenants', form);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Greška');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {error && <Alert type="error" message={error} />}
      <div><label className="label">Naziv *</label>
        <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: isEdit ? f.slug : e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') }))} /></div>
      <div><label className="label">Slug * (url-friendly, npr. acme-corp)</label>
        <input className="input" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase() }))} disabled={isEdit} /></div>
      <div className="flex gap-3">
        <div className="flex-1"><label className="label">Opis</label>
          <input className="input" value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
        <div><label className="label">Boja</label>
          <input type="color" className="h-10 w-14 rounded-lg border border-gray-700 bg-gray-800 cursor-pointer px-1"
            value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} /></div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj' : 'Kreiraj tenant')}
        </button>
      </div>
    </div>
  );
}

// ── Operator forma ────────────────────────────────────────────────────────────
function OperatorForm({ operator, tenants, onSave, onClose }) {
  const isEdit = !!operator?.id;
  const [form, setForm] = useState({
    username: '', password: '', fullName: '', email: '', authType: 'local',
    ...(operator ? { username: operator.username, fullName: operator.full_name, email: operator.email || '', authType: operator.auth_type } : {}),
  });
  const [assignments, setAssignments] = useState(
    operator?.tenants?.map(t => ({
      tenantId:           t.tenantId,
      permScriptsRun:     t.permScriptsRun,
      permScriptsManage:  t.permScriptsManage,
      permServersManage:  t.permServersManage,
      permKeysManage:     t.permKeysManage,
    })) || []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const hasTenant = (id) => assignments.some(a => a.tenantId === id);
  const getA      = (id) => assignments.find(a => a.tenantId === id) || {};

  const toggleTenant = (tenantId) => {
    setAssignments(prev =>
      prev.some(a => a.tenantId === tenantId)
        ? prev.filter(a => a.tenantId !== tenantId)
        : [...prev, { tenantId, permScriptsRun: false, permScriptsManage: false, permServersManage: false, permKeysManage: false }]
    );
  };

  const setPerm = (tenantId, perm, val) => {
    setAssignments(prev => prev.map(a => a.tenantId === tenantId ? { ...a, [perm]: val } : a));
  };

  const handleSave = async () => {
    if (!form.username) { setError('Username je obavezan'); return; }
    if (!isEdit && form.authType === 'local' && form.password.length < 10) { setError('Lozinka mora imati min. 10 karaktera'); return; }
    setSaving(true); setError('');
    try {
      let userId = operator?.id;
      if (isEdit) {
        await api.put(`/admin/users/${operator.id}`, form);
      } else {
        const { data } = await api.post('/admin/users', form);
        userId = data.id;
      }
      await api.put(`/admin/users/${userId}/tenants`, { assignments });
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Greška');
    } finally { setSaving(false); }
  };

  const PERMS = [
    { key: 'permScriptsRun',    label: 'Pokretanje skripti' },
    { key: 'permScriptsManage', label: 'Upravljanje skriptama' },
    { key: 'permServersManage', label: 'Upravljanje serverima' },
    { key: 'permKeysManage',    label: 'SSH ključevi' },
  ];

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} />}

      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Username *</label>
          <input className="input" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} disabled={isEdit} /></div>
        <div><label className="label">Puno ime</label>
          <input className="input" value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} /></div>
        <div><label className="label">Email</label>
          <input className="input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
        <div><label className="label">Tip auth</label>
          <select className="input" value={form.authType} onChange={e => setForm(f => ({ ...f, authType: e.target.value }))}>
            <option value="local">Lokalni nalog</option>
            <option value="ldap">LDAP/AD</option>
          </select></div>
        {(!isEdit || form.password) && form.authType === 'local' && (
          <div className="col-span-2"><label className="label">{isEdit ? 'Nova lozinka (ostavi prazno da zadržiš)' : 'Lozinka *'}</label>
            <input className="input" type="password" value={form.password || ''} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></div>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-gray-400 mb-2">Tenanti i dozvole</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {tenants.map(t => {
            const active = hasTenant(t.id);
            const a = getA(t.id);
            return (
              <div key={t.id} className={clsx('border rounded-lg overflow-hidden', active ? 'border-brand-700' : 'border-gray-800')}>
                <div className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-800/50" onClick={() => toggleTenant(t.id)}>
                  <input type="checkbox" className="accent-brand-500" checked={active} onChange={() => {}} />
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} />
                  <span className="text-sm text-gray-200 flex-1">{t.name}</span>
                  <span className="text-xs text-gray-600">{t.server_count || 0} servera</span>
                </div>
                {active && (
                  <div className="px-3 pb-2.5 pt-1 bg-gray-900/50 border-t border-gray-800 grid grid-cols-2 gap-1.5">
                    {PERMS.map(p => (
                      <label key={p.key} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" className="accent-brand-500" checked={!!a[p.key]} onChange={e => setPerm(t.id, p.key, e.target.checked)} />
                        <span className="text-xs text-gray-400">{p.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj izmene' : 'Kreiraj operatera')}
        </button>
      </div>
    </div>
  );
}

// ── Glavna Admin stranica ─────────────────────────────────────────────────────
export default function Admin() {
  const [tab, setTab] = useState('tenants');
  const [tenants, setTenants] = useState([]);
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [delConfirm, setDelConfirm] = useState(null);

  const fetchAll = async () => {
    const [t, u] = await Promise.all([api.get('/admin/tenants'), api.get('/admin/users')]);
    setTenants(t.data); setUsers(u.data); setLoading(false);
  };
  useEffect(() => { fetchAll(); }, []);

  const handleDeleteTenant = async (id) => {
    await api.delete(`/admin/tenants/${id}`);
    setTenants(prev => prev.filter(t => t.id !== id));
    setDelConfirm(null);
  };
  const handleDeleteUser = async (id) => {
    await api.delete(`/admin/users/${id}`);
    setUsers(prev => prev.filter(u => u.id !== id));
    setDelConfirm(null);
  };

  if (loading) return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">Admin panel</h1>
        <p className="text-sm text-gray-500">Upravljanje tenantima i operaterima</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {[{ id: 'tenants', icon: Shield, label: `Tenanti (${tenants.length})` },
          { id: 'users',   icon: Users,  label: `Operateri (${users.length})` }].map(t => (
          <button key={t.id}
            className={clsx('flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px',
              tab === t.id ? 'border-brand-500 text-brand-400' : 'border-transparent text-gray-500 hover:text-gray-300')}
            onClick={() => setTab(t.id)}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {/* Tenanti tab */}
      {tab === 'tenants' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => setModal({ type: 'tenant', data: null })}>
              <Plus size={15} /> Novi tenant
            </button>
          </div>
          {tenants.length === 0 ? <Empty icon={Shield} title="Nema tenanata" /> : (
            <div className="card p-0 overflow-hidden">
              <Table columns={[
                { key: 'name', label: 'Tenant', render: t => (
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ background: t.color }} />
                    <div>
                      <div className="font-medium text-gray-200">{t.name}</div>
                      <div className="text-xs text-gray-600">{t.slug}</div>
                    </div>
                  </div>
                )},
                { key: 'servers',   label: 'Serveri',   render: t => <span className="text-gray-400">{t.server_count || 0}</span> },
                { key: 'operators', label: 'Operateri', render: t => <span className="text-gray-400">{t.operator_count || 0}</span> },
                { key: 'active',    label: 'Status',    render: t => <span className={t.active ? 'badge-green' : 'badge-gray'}>{t.active ? 'Aktivan' : 'Neaktivan'}</span> },
                { key: 'actions',   label: '', render: t => (
                  <div className="flex gap-1">
                    <button className="btn-ghost py-1 px-2" onClick={() => setModal({ type: 'tenant', data: t })}><Edit size={13} /></button>
                    <button className="btn-ghost py-1 px-2 text-red-500" onClick={() => setDelConfirm({ type: 'tenant', data: t })}><Trash2 size={13} /></button>
                  </div>
                )},
              ]} rows={tenants} />
            </div>
          )}
        </div>
      )}

      {/* Operateri tab */}
      {tab === 'users' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => setModal({ type: 'user', data: null })}>
              <Plus size={15} /> Novi operater
            </button>
          </div>
          {users.length === 0 ? <Empty icon={Users} title="Nema operatera" /> : (
            <div className="card p-0 overflow-hidden">
              <Table columns={[
                { key: 'username', label: 'Korisnik', render: u => (
                  <div>
                    <div className="font-medium text-gray-200">{u.username}</div>
                    <div className="text-xs text-gray-600">{u.full_name || u.email || u.auth_type}</div>
                  </div>
                )},
                { key: 'tenants', label: 'Tenanti', render: u => (
                  <div className="flex flex-wrap gap-1">
                    {(u.tenants || []).map(t => (
                      <span key={t.tenantId} className="badge-blue"
                        style={{ background: t.tenantColor + '33', color: t.tenantColor }}>
                        {t.tenantName}
                      </span>
                    ))}
                    {!u.tenants?.length && <span className="text-xs text-gray-600">—</span>}
                  </div>
                )},
                { key: 'active', label: 'Status', render: u => <span className={u.active ? 'badge-green' : 'badge-gray'}>{u.active ? 'Aktivan' : 'Neaktivan'}</span> },
                { key: 'last_login', label: 'Poslednji login', render: u => <span className="text-xs text-gray-600">{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('sr') : '—'}</span> },
                { key: 'actions', label: '', render: u => (
                  <div className="flex gap-1">
                    <button className="btn-ghost py-1 px-2" onClick={() => setModal({ type: 'user', data: u })}><Edit size={13} /></button>
                    <button className="btn-ghost py-1 px-2 text-red-500" onClick={() => setDelConfirm({ type: 'user', data: u })}><Trash2 size={13} /></button>
                  </div>
                )},
              ]} rows={users} />
            </div>
          )}
        </div>
      )}

      {/* Modali */}
      <Modal open={!!modal} onClose={() => setModal(null)}
        title={modal?.type === 'tenant'
          ? (modal.data ? 'Uredi tenant' : 'Novi tenant')
          : (modal?.data ? 'Uredi operatera' : 'Novi operater')}>
        {modal?.type === 'tenant' && (
          <TenantForm tenant={modal.data} onSave={() => { setModal(null); fetchAll(); }} onClose={() => setModal(null)} />
        )}
        {modal?.type === 'user' && (
          <OperatorForm operator={modal.data} tenants={tenants} onSave={() => { setModal(null); fetchAll(); }} onClose={() => setModal(null)} />
        )}
      </Modal>

      <ConfirmDialog
        open={!!delConfirm}
        title={`Obriši ${delConfirm?.type === 'tenant' ? 'tenant' : 'operatera'}`}
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.data?.name || delConfirm?.data?.username}"?`}
        danger
        onConfirm={() => delConfirm.type === 'tenant' ? handleDeleteTenant(delConfirm.data.id) : handleDeleteUser(delConfirm.data.id)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
