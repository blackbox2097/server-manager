// src/pages/admin/Users.jsx
import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, Users as UsersIcon, Key } from 'lucide-react';
import api from '../../services/api';
import { Modal, ConfirmDialog, Alert, Spinner, Empty, Table } from '../../components/ui';
import clsx from 'clsx';

const PERMS = [
  { key: 'permScriptsRun',    label: 'Pokretanje skripti' },
  { key: 'permScriptsManage', label: 'Upravljanje skriptama' },
  { key: 'permServersManage', label: 'Upravljanje serverima' },
  { key: 'permKeysManage',    label: 'SSH ključevi' },
];

// ── Forma za kreiranje/editovanje operatera ───────────────────────────────────
function UserForm({ operator, tenants, onSave, onClose }) {
  const isEdit = !!operator?.id;
  const [form, setForm] = useState({
    username: '', password: '', fullName: '', email: '', authType: 'local',
    ...(operator ? {
      username: operator.username,
      fullName: operator.full_name || '',
      email:    operator.email || '',
      authType: operator.auth_type,
    } : {}),
  });
  const [assignments, setAssignments] = useState(
    operator?.tenants?.map(t => ({
      tenantId:           t.tenantId,
      permScriptsRun:     t.permScriptsRun     || false,
      permScriptsManage:  t.permScriptsManage  || false,
      permServersManage:  t.permServersManage  || false,
      permKeysManage:     t.permKeysManage     || false,
    })) || []
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const hasTenant = (id) => assignments.some(a => a.tenantId === id);
  const getA      = (id) => assignments.find(a => a.tenantId === id) || {};

  const toggleTenant = (tenantId) => {
    setAssignments(prev =>
      hasTenant(tenantId)
        ? prev.filter(a => a.tenantId !== tenantId)
        : [...prev, { tenantId, permScriptsRun: false, permScriptsManage: false, permServersManage: false, permKeysManage: false }]
    );
  };

  const setPerm = (tenantId, perm, val) => {
    setAssignments(prev => prev.map(a => a.tenantId === tenantId ? { ...a, [perm]: val } : a));
  };

  const handleSave = async () => {
    if (!form.username) { setError('Username je obavezan'); return; }
    if (!isEdit && form.authType === 'local' && (!form.password || form.password.length < 10)) {
      setError('Lozinka mora imati minimum 10 karaktera'); return;
    }
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

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} />}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Username *</label>
          <input className="input" value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            disabled={isEdit} />
        </div>
        <div>
          <label className="label">Puno ime</label>
          <input className="input" value={form.fullName}
            onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        </div>
        <div>
          <label className="label">Tip autentikacije</label>
          <select className="input" value={form.authType}
            onChange={e => setForm(f => ({ ...f, authType: e.target.value }))}>
            <option value="local">Lokalni nalog</option>
            <option value="ldap">LDAP / Active Directory</option>
          </select>
        </div>
      </div>

      {form.authType === 'local' && (
        <div>
          <label className="label">
            {isEdit ? 'Nova lozinka (ostavi prazno da zadržiš trenutnu)' : 'Lozinka * (minimum 10 karaktera)'}
          </label>
          <input className="input" type="password" value={form.password || ''}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder={isEdit ? '••••••••••' : ''} />
        </div>
      )}

      {/* Dodela tenanata i dozvola */}
      <div>
        <p className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-2">
          <Key size={12} /> Tenanti i dozvole
        </p>
        {tenants.length === 0 ? (
          <p className="text-xs text-gray-600 px-2">Nema tenanata — najpre kreiraj tenante.</p>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {tenants.map(t => {
              const active = hasTenant(t.id);
              const a      = getA(t.id);
              return (
                <div key={t.id} className={clsx('border rounded-lg overflow-hidden transition-colors',
                  active ? 'border-brand-700' : 'border-gray-800')}>
                  <div className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-800/50"
                    onClick={() => toggleTenant(t.id)}>
                    <input type="checkbox" className="accent-brand-500" checked={active} onChange={() => {}} />
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: t.color }} />
                    <span className="text-sm text-gray-200 flex-1">{t.name}</span>
                  </div>
                  {active && (
                    <div className="px-3 pb-2.5 pt-1.5 bg-gray-900/50 border-t border-gray-800 grid grid-cols-2 gap-1.5">
                      {PERMS.map(p => (
                        <label key={p.key} className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" className="accent-brand-500"
                            checked={!!a[p.key]}
                            onChange={e => setPerm(t.id, p.key, e.target.checked)} />
                          <span className="text-xs text-gray-400">{p.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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

// ── Forma za promenu lozinke ──────────────────────────────────────────────────
function ChangePasswordForm({ operator, onSave, onClose }) {
  const [form, setForm]   = useState({ newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const handleSave = async () => {
    if (!form.newPassword) { setError('Lozinka je obavezna'); return; }
    if (form.newPassword.length < 10) { setError('Minimum 10 karaktera'); return; }
    if (form.newPassword !== form.confirmPassword) { setError('Lozinke se ne poklapaju'); return; }
    setSaving(true); setError('');
    try {
      await api.put(`/admin/users/${operator.id}`, { password: form.newPassword });
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Greška');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {error && <Alert type="error" message={error} />}
      <p className="text-sm text-gray-400">Promena lozinke za korisnika <strong className="text-gray-200">{operator.username}</strong></p>
      <div>
        <label className="label">Nova lozinka (minimum 10 karaktera)</label>
        <input className="input" type="password" value={form.newPassword}
          onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} />
      </div>
      <div>
        <label className="label">Potvrdi novu lozinku</label>
        <input className="input" type="password" value={form.confirmPassword}
          onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : 'Promeni lozinku'}
        </button>
      </div>
    </div>
  );
}

// ── Glavna stranica ───────────────────────────────────────────────────────────
export default function Users() {
  const [users,      setUsers]      = useState([]);
  const [tenants,    setTenants]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(null);  // null | 'add' | {user} | 'pw:{user}'
  const [delConfirm, setDelConfirm] = useState(null);

  const fetchAll = async () => {
    const [u, t] = await Promise.all([api.get('/admin/users'), api.get('/admin/tenants')]);
    setUsers(u.data.filter(u => u.role === 'operator'));
    setTenants(t.data.filter(t => t.active));
    setLoading(false);
  };
  useEffect(() => { fetchAll(); }, []);

  const handleDelete = async (id) => {
    await api.delete(`/admin/users/${id}`);
    setUsers(prev => prev.filter(u => u.id !== id));
    setDelConfirm(null);
  };

  if (loading) return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Operateri</h1>
          <p className="text-sm text-gray-500">{users.length} operatera ukupno</p>
        </div>
        <button className="btn-primary" onClick={() => setModal('add')}>
          <Plus size={15} /> Novi operater
        </button>
      </div>

      {users.length === 0 ? (
        <Empty icon={UsersIcon} title="Nema operatera"
          subtitle="Kreiraj prvog operatera i dodeli mu tenante"
          action={<button className="btn-primary" onClick={() => setModal('add')}><Plus size={14} /> Novi operater</button>} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'username', label: 'Korisnik', render: u => (
                <div>
                  <div className="font-medium text-gray-200">{u.username}</div>
                  <div className="text-xs text-gray-600">{u.full_name || u.email || u.auth_type}</div>
                </div>
              )},
              { key: 'tenants', label: 'Tenanti', render: u => (
                <div className="flex flex-wrap gap-1">
                  {(u.tenants || []).map(t => (
                    <span key={t.tenantId} className="badge text-xs px-1.5 py-0.5 rounded"
                      style={{ background: (t.tenantColor || '#6366f1') + '33', color: t.tenantColor || '#6366f1', border: '1px solid ' + (t.tenantColor || '#6366f1') + '55' }}>
                      {t.tenantName}
                    </span>
                  ))}
                  {!u.tenants?.length && <span className="text-xs text-gray-600">Nema dodeljenih tenanata</span>}
                </div>
              )},
              { key: 'auth_type', label: 'Auth', render: u => (
                <span className="badge-gray">{u.auth_type === 'ldap' ? 'LDAP' : 'Lokalni'}</span>
              )},
              { key: 'active', label: 'Status', render: u => (
                <span className={u.active ? 'badge-green' : 'badge-gray'}>
                  {u.active ? 'Aktivan' : 'Neaktivan'}
                </span>
              )},
              { key: 'last_login', label: 'Poslednji login', render: u => (
                <span className="text-xs text-gray-600">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('sr') : '—'}
                </span>
              )},
              { key: 'actions', label: '', render: u => (
                <div className="flex gap-1">
                  <button className="btn-ghost py-1 px-2" onClick={() => setModal(u)} title="Uredi">
                    <Edit size={13} />
                  </button>
                  <button className="btn-ghost py-1 px-2 text-brand-400 hover:text-brand-300"
                    onClick={() => setModal({ _changePw: true, ...u })} title="Promeni lozinku">
                    <Key size={13} />
                  </button>
                  <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                    onClick={() => setDelConfirm(u)} title="Obriši">
                    <Trash2 size={13} />
                  </button>
                </div>
              )},
            ]}
            rows={users}
          />
        </div>
      )}

      {/* Edit / kreiraj modal */}
      <Modal
        open={!!modal && !modal?._changePw}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Novi operater' : `Uredi: ${modal?.username}`}>
        {modal && !modal._changePw && (
          <UserForm
            operator={modal === 'add' ? null : modal}
            tenants={tenants}
            onSave={() => { setModal(null); fetchAll(); }}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>

      {/* Promena lozinke modal */}
      <Modal
        open={!!modal?._changePw}
        onClose={() => setModal(null)}
        title="Promeni lozinku">
        {modal?._changePw && (
          <ChangePasswordForm
            operator={modal}
            onSave={() => { setModal(null); fetchAll(); }}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>

      {/* Brisanje */}
      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši operatera"
        message={`Da li si siguran da hoćeš da obrišeš operatera "${delConfirm?.username}"?`}
        danger
        onConfirm={() => handleDelete(delConfirm.id)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
