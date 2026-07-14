// src/pages/admin/Tenants.jsx
import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, Shield } from 'lucide-react';
import api from '../../services/api';
import { Modal, ConfirmDialog, Alert, Spinner, Empty, Table } from '../../components/ui';

function TenantForm({ tenant, onSave, onClose }) {
  const isEdit = !!tenant?.id;
  const [form, setForm] = useState({
    name: '', slug: '', color: '#378ADD', description: '',
    ...(tenant || {}),
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

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
      <div>
        <label className="label">Naziv *</label>
        <input className="input" value={form.name}
          onChange={e => setForm(f => ({
            ...f,
            name: e.target.value,
            slug: isEdit ? f.slug : e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
          }))} />
      </div>
      <div>
        <label className="label">Slug * (url-friendly, npr. acme-corp)</label>
        <input className="input" value={form.slug}
          onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase() }))}
          disabled={isEdit} />
      </div>
      <div>
        <label className="label">Opis</label>
        <input className="input" value={form.description || ''}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
      </div>
      <div>
        <label className="label">Boja</label>
        <div className="flex items-center gap-3">
          <input type="color" className="h-10 w-14 rounded-lg border border-gray-700 bg-gray-800 cursor-pointer px-1"
            value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
          <span className="text-sm text-gray-400">{form.color}</span>
        </div>
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

export default function Tenants() {
  const [tenants,    setTenants]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(null);
  const [delConfirm, setDelConfirm] = useState(null);

  const fetch = async () => {
    const { data } = await api.get('/admin/tenants');
    setTenants(data); setLoading(false);
  };
  useEffect(() => { fetch(); }, []);

  const handleDelete = async (id) => {
    await api.delete(`/admin/tenants/${id}`);
    setTenants(prev => prev.filter(t => t.id !== id));
    setDelConfirm(null);
  };

  if (loading) return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Tenanti</h1>
          <p className="text-sm text-gray-500">{tenants.length} tenanata ukupno</p>
        </div>
        <button className="btn-primary" onClick={() => setModal('add')}>
          <Plus size={15} /> Novi tenant
        </button>
      </div>

      {tenants.length === 0 ? (
        <Empty icon={Shield} title="Nema tenanata"
          subtitle="Kreiraj prvi tenant"
          action={<button className="btn-primary" onClick={() => setModal('add')}><Plus size={14} /> Novi tenant</button>} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'name', label: 'Tenant', render: t => (
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: t.color }} />
                  <div>
                    <div className="font-medium text-gray-200">{t.name}</div>
                    <div className="text-xs text-gray-600">{t.slug}</div>
                  </div>
                </div>
              )},
              { key: 'description', label: 'Opis', render: t => <span className="text-sm text-gray-500">{t.description || '—'}</span> },
              { key: 'server_count', label: 'Serveri', render: t => <span className="text-gray-400">{t.server_count || 0}</span> },
              { key: 'operator_count', label: 'Operateri', render: t => <span className="text-gray-400">{t.operator_count || 0}</span> },
              { key: 'active', label: 'Status', render: t => (
                <span className={t.active ? 'badge-green' : 'badge-gray'}>
                  {t.active ? 'Aktivan' : 'Neaktivan'}
                </span>
              )},
              { key: 'actions', label: '', render: t => (
                <div className="flex gap-1">
                  <button className="btn-ghost py-1 px-2" onClick={() => setModal(t)} title="Uredi">
                    <Edit size={13} />
                  </button>
                  <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400" onClick={() => setDelConfirm(t)} title="Obriši">
                    <Trash2 size={13} />
                  </button>
                </div>
              )},
            ]}
            rows={tenants}
          />
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)}
        title={modal === 'add' ? 'Novi tenant' : `Uredi: ${modal?.name}`}>
        {modal && (
          <TenantForm
            tenant={modal === 'add' ? null : modal}
            onSave={() => { setModal(null); fetch(); }}
            onClose={() => setModal(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši tenant"
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.name}"? Svi serveri i podaci ovog tenanta biće deaktivirani.`}
        danger
        onConfirm={() => handleDelete(delConfirm.id)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
