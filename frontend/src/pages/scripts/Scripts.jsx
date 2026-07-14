// src/pages/scripts/Scripts.jsx
import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, BookOpen, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Modal, ConfirmDialog, Alert, Spinner, Empty, Table } from '../../components/ui';

function ScriptForm({ script, tenantId, onSave, onClose }) {
  const isEdit = !!script?.id;
  const [form, setForm] = useState({
    name: '', description: '', osType: 'linux', content: '',
    ...(script || {}), osType: script?.os_type || 'linux', content: script?.content || '',
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const handleSave = async () => {
    if (!form.name || !form.content) { setError('Naziv i sadržaj su obavezni'); return; }
    setSaving(true);
    try {
      if (isEdit) await api.put(`/tenants/${tenantId}/scripts/${script.id}`, form);
      else        await api.post(`/tenants/${tenantId}/scripts`, form);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Greška');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {error && <Alert type="error" message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Naziv *</label>
          <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
        <div><label className="label">OS tip</label>
          <select className="input" value={form.osType} onChange={e => setForm(f => ({ ...f, osType: e.target.value }))}>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
            <option value="both">Oba</option>
          </select></div>
      </div>
      <div><label className="label">Opis</label>
        <input className="input" value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
      <div><label className="label">Sadržaj skripte *</label>
        <textarea className="input font-mono text-xs h-56 resize-y" value={form.content}
          onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
          placeholder="#!/bin/bash&#10;echo 'Hello'" /></div>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj' : 'Dodaj skriptu')}
        </button>
      </div>
    </div>
  );
}

export default function Scripts() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId   = activeTenant?.id;
  const canManage  = hasPerm('perm_scripts_manage');
  const navigate   = useNavigate();

  const [scripts,    setScripts]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(null);
  const [delConfirm, setDelConfirm] = useState(null);

  const fetch = async () => {
    if (!tenantId) return;
    const { data } = await api.get(`/tenants/${tenantId}/scripts`);
    setScripts(data); setLoading(false);
  };
  useEffect(() => { fetch(); }, [tenantId]);

  const handleDelete = async (id) => {
    await api.delete(`/tenants/${tenantId}/scripts/${id}`);
    setScripts(prev => prev.filter(s => s.id !== id));
    setDelConfirm(null);
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Biblioteka skripti</h1>
          <p className="text-sm text-gray-500">{scripts.length} skripti</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setModal('add')}>
            <Plus size={15} /> Nova skripta
          </button>
        )}
      </div>

      {scripts.length === 0 ? (
        <Empty icon={BookOpen} title="Nema sačuvanih skripti"
          subtitle="Kreiraj predložak koji možeš ponovo koristiti"
          action={canManage && <button className="btn-primary" onClick={() => setModal('add')}><Plus size={14} /> Nova skripta</button>} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table columns={[
            { key: 'name', label: 'Naziv', render: s => (
              <div>
                <div className="font-medium text-gray-200">{s.name}</div>
                {s.description && <div className="text-xs text-gray-600 mt-0.5">{s.description}</div>}
              </div>
            )},
            { key: 'os_type', label: 'OS', render: s => (
              <span className="badge-gray">{s.os_type === 'linux' ? '🐧 Linux' : s.os_type === 'windows' ? '🪟 Windows' : 'Oba'}</span>
            )},
            { key: 'created', label: 'Kreiran', render: s => <span className="text-xs text-gray-600">{new Date(s.created_at).toLocaleDateString('sr')}</span> },
            { key: 'created_by', label: 'Autor', render: s => <span className="text-xs text-gray-500">{s.created_by_name || '—'}</span> },
            { key: 'actions', label: '', render: s => (
              <div className="flex gap-1">
                <button className="btn-ghost py-1 px-2 text-brand-400"
                  onClick={() => navigate('/execute', { state: { script: s } })}
                  title="Pokreni">
                  <Play size={13} />
                </button>
                {canManage && !s.is_builtin && <>
                  <button className="btn-ghost py-1 px-2" onClick={() => setModal(s)}><Edit size={13} /></button>
                  <button className="btn-ghost py-1 px-2 text-red-500" onClick={() => setDelConfirm(s)}><Trash2 size={13} /></button>
                </>}
              </div>
            )},
          ]} rows={scripts} />
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)}
        title={modal === 'add' ? 'Nova skripta' : `Uredi: ${modal?.name}`}>
        {modal && <ScriptForm script={modal === 'add' ? null : modal} tenantId={tenantId}
          onSave={() => { setModal(null); fetch(); }} onClose={() => setModal(null)} />}
      </Modal>

      <ConfirmDialog open={!!delConfirm} title="Obriši skriptu"
        message={`Obrisati "${delConfirm?.name}"?`} danger
        onConfirm={() => handleDelete(delConfirm.id)} onCancel={() => setDelConfirm(null)} />
    </div>
  );
}
