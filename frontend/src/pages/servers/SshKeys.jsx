// src/pages/servers/SshKeys.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Key, Copy, Check } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import {
  Modal, ConfirmDialog, Alert, Spinner, Empty, Table
} from '../../components/ui';

function SshKeyForm({ tenantId, onSave, onClose }) {
  const [name,        setName]        = useState('');
  const [description, setDescription] = useState('');
  const [keyType,     setKeyType]     = useState('ed25519');
  const [privateKey,  setPrivateKey]  = useState('');
  const [publicKey,   setPublicKey]   = useState('');
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');

  const handleSave = async () => {
    if (!name.trim()) { setError('Naziv je obavezan'); return; }
    if (!privateKey.trim()) { setError('Privatni ključ je obavezan'); return; }
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('name', name);
      if (description) fd.append('description', description);
      fd.append('keyType', keyType);
      fd.append('privateKeyContent', privateKey);
      if (publicKey) fd.append('publicKeyContent', publicKey);
      await api.post(`/tenants/${tenantId}/ssh-keys`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onSave();
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju ključa');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <Alert type="error" message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Naziv *</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
            placeholder="npr. prod-deploy-key" />
        </div>
        <div>
          <label className="label">Tip ključa</label>
          <select className="input" value={keyType} onChange={e => setKeyType(e.target.value)}>
            <option value="ed25519">ED25519</option>
            <option value="rsa">RSA</option>
            <option value="ecdsa">ECDSA</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">Opis</label>
        <input className="input" value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="label">Privatni ključ * (sadržaj .pem / id_ed25519 fajla)</label>
        <textarea
          className="input font-mono text-xs h-32 resize-none"
          value={privateKey}
          onChange={e => setPrivateKey(e.target.value)}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
          spellCheck={false}
        />
        <p className="text-xs text-gray-600 mt-1">Ključ se čuva enkriptovan (AES-256-GCM) u bazi.</p>
      </div>
      <div>
        <label className="label">Javni ključ (opciono — za prikaz fingerprint-a)</label>
        <textarea
          className="input font-mono text-xs h-16 resize-none"
          value={publicKey}
          onChange={e => setPublicKey(e.target.value)}
          placeholder="ssh-ed25519 AAAAC3Nz... komentar"
          spellCheck={false}
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : 'Sačuvaj ključ'}
        </button>
      </div>
    </div>
  );
}

function FingerprintCell({ fingerprint }) {
  const [copied, setCopied] = useState(false);
  if (!fingerprint) return <span className="text-gray-600 text-xs">—</span>;

  const copy = () => {
    navigator.clipboard.writeText(fingerprint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 font-mono transition-colors"
      onClick={copy} title="Kopiraj fingerprint">
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
      {fingerprint.slice(0, 24)}...
    </button>
  );
}

export default function SshKeys() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_keys_manage');

  const [keys,       setKeys]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modalOpen,  setModalOpen]  = useState(false);
  const [delConfirm, setDelConfirm] = useState(null);

  const fetchKeys = useCallback(async () => {
    if (!tenantId) return;
    try {
      const { data } = await api.get(`/tenants/${tenantId}/ssh-keys`);
      setKeys(data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const handleSave = () => { setModalOpen(false); fetchKeys(); };

  const handleDelete = async (key) => {
    try {
      await api.delete(`/tenants/${tenantId}/ssh-keys/${key.id}`);
      setKeys(prev => prev.filter(k => k.id !== key.id));
      setDelConfirm(null);
    } catch (err) {
      setDelConfirm(null);
      alert(err.response?.data?.detail || 'Greška pri brisanju ključa');
    }
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">SSH Ključevi</h1>
          <p className="text-sm text-gray-500">{keys.length} ključeva u {activeTenant?.name}</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={16} /> Novi ključ
          </button>
        )}
      </div>

      {!canManage && (
        <Alert type="info" message="Nemaš dozvolu za upravljanje SSH ključevima u ovom tenantu." />
      )}

      {keys.length === 0 ? (
        <Empty icon={Key} title="Nema SSH ključeva"
          subtitle="Dodaj ključ da bi ga mogao koristiti pri dodavanju servera"
          action={canManage && (
            <button className="btn-primary" onClick={() => setModalOpen(true)}>
              <Plus size={14} /> Novi ključ
            </button>
          )} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'name', label: 'Naziv', render: k => (
                <div>
                  <div className="font-medium text-gray-200">{k.name}</div>
                  {k.description && <div className="text-xs text-gray-600">{k.description}</div>}
                </div>
              )},
              { key: 'type',   label: 'Tip',        render: k => <span className="badge-gray uppercase text-xs">{k.key_type}</span> },
              { key: 'fp',     label: 'Fingerprint', render: k => <FingerprintCell fingerprint={k.fingerprint} /> },
              { key: 'usage',  label: 'Korišćen na', render: k => (
                <span className="text-xs text-gray-500">{k.usage_count} server{k.usage_count === 1 ? 'u' : 'a'}</span>
              )},
              { key: 'created', label: 'Dodat',      render: k => (
                <span className="text-xs text-gray-600">{new Date(k.created_at).toLocaleDateString('sr')}</span>
              )},
              ...(canManage ? [{
                key: 'actions', label: '', render: k => (
                  <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                    onClick={() => setDelConfirm(k)} title="Obriši">
                    <Trash2 size={14} />
                  </button>
                )
              }] : []),
            ]}
            rows={keys}
          />
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Novi SSH ključ">
        {modalOpen && (
          <SshKeyForm tenantId={tenantId} onSave={handleSave} onClose={() => setModalOpen(false)} />
        )}
      </Modal>

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši SSH ključ"
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.name}"? ${delConfirm?.usage_count > 0 ? 'Ključ je u upotrebi i brisanje neće uspeti dok ga ne ukloniš sa servera.' : ''}`}
        danger
        onConfirm={() => handleDelete(delConfirm)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
