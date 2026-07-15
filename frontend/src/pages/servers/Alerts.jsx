// src/pages/servers/Alerts.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Bell, Plus, Trash2, Mail } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Alert, Spinner, ConfirmDialog } from '../../components/ui';

const TRIGGERS = [
  { key: 'alertOnOffline',          dbKey: 'alert_on_offline',           label: 'Server ode offline' },
  { key: 'alertOnRecovery',         dbKey: 'alert_on_recovery',          label: 'Server se oporavi (vrati online)' },
  { key: 'alertOnWarning',          dbKey: 'alert_on_warning',           label: 'Visoko opterećenje (CPU/RAM/Disk > 90%)' },
  { key: 'alertOnExecutionFailure', dbKey: 'alert_on_execution_failure', label: 'Neuspešno izvršavanje skripte' },
  { key: 'alertOnExecutionReport',  dbKey: 'alert_on_execution_report',  label: 'Izveštaj posle SVAKOG izvršavanja skripte' },
];

export default function Alerts() {
  const { activeTenant, hasPerm } = useAuthStore();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_servers_manage');

  const [settings,   setSettings]   = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [newEmail,   setNewEmail]   = useState('');
  const [addingEmail, setAddingEmail] = useState(false);
  const [delConfirm, setDelConfirm] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [sRes, rRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/alert-settings`),
        api.get(`/tenants/${tenantId}/alert-recipients`),
      ]);
      setSettings(sRes.data);
      setRecipients(rRes.data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const updateSetting = async (dbKey, apiKey, value) => {
    setSettings(prev => ({ ...prev, [dbKey]: value }));
    setSaving(true); setError('');
    try {
      await api.put(`/tenants/${tenantId}/alert-settings`, { [apiKey]: value });
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju');
      setSettings(prev => ({ ...prev, [dbKey]: !value }));
    } finally {
      setSaving(false);
    }
  };

  const handleAddEmail = async () => {
    if (!newEmail.trim()) return;
    setAddingEmail(true); setError('');
    try {
      const { data } = await api.post(`/tenants/${tenantId}/alert-recipients`, { email: newEmail.trim() });
      setRecipients(prev => [...prev, data]);
      setNewEmail('');
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri dodavanju');
    } finally {
      setAddingEmail(false);
    }
  };

  const handleDeleteEmail = async (r) => {
    try {
      await api.delete(`/tenants/${tenantId}/alert-recipients/${r.id}`);
      setRecipients(prev => prev.filter(x => x.id !== r.id));
      setDelConfirm(null);
    } catch (err) {
      setDelConfirm(null);
      setError(err.response?.data?.detail || 'Greška pri brisanju');
    }
  };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
          <Bell size={18} /> Email alarmi
        </h1>
        <p className="text-sm text-gray-500">Podešavanja za {activeTenant?.name}</p>
      </div>

      {error && <Alert type="error" message={error} onClose={() => setError('')} />}

      {!canManage && (
        <Alert type="info" message="Nemaš dozvolu za izmenu ovih podešavanja — prikaz samo za čitanje." />
      )}

      <div className="card space-y-3">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-sm font-medium text-gray-200">Email alarmi uključeni</p>
            <p className="text-xs text-gray-500">Glavni prekidač — ako je isključen, ništa se ne šalje</p>
          </div>
          <input type="checkbox" className="accent-brand-500 w-4 h-4" checked={settings?.alerts_enabled || false}
            disabled={!canManage}
            onChange={e => updateSetting('alerts_enabled', 'alertsEnabled', e.target.checked)} />
        </label>
      </div>

      <div className="card space-y-3">
        <p className="text-sm font-medium text-gray-300">Kada slati alarme</p>
        {TRIGGERS.map(t => (
          <label key={t.key} className="flex items-center justify-between cursor-pointer py-1">
            <span className="text-sm text-gray-400">{t.label}</span>
            <input type="checkbox" className="accent-brand-500 w-4 h-4"
              checked={settings?.[t.dbKey] || false}
              disabled={!canManage || !settings?.alerts_enabled}
              onChange={e => updateSetting(t.dbKey, t.key, e.target.checked)} />
          </label>
        ))}
      </div>

      <div className="card space-y-3">
        <p className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
          <Mail size={14} /> Primaoci ({recipients.length})
        </p>
        {recipients.length === 0 && (
          <p className="text-xs text-gray-600">Nema dodatih email adresa — alarmi se neće slati čak ni ako su uključeni.</p>
        )}
        <div className="space-y-1.5">
          {recipients.map(r => (
            <div key={r.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
              <span className="text-sm text-gray-300">{r.email}</span>
              {canManage && (
                <button className="btn-ghost py-1 px-1.5 text-red-500 hover:text-red-400"
                  onClick={() => setDelConfirm(r)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <div className="flex gap-2 pt-1">
            <input className="input flex-1" type="email" placeholder="operater@firma.com"
              value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddEmail()} />
            <button className="btn-secondary flex-shrink-0" onClick={handleAddEmail} disabled={addingEmail || !newEmail.trim()}>
              {addingEmail ? <Spinner size={14} /> : <><Plus size={14} /> Dodaj</>}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!delConfirm}
        title="Ukloni primaoca"
        message={`Ukloniti "${delConfirm?.email}" sa liste primalaca alarma?`}
        danger
        onConfirm={() => handleDeleteEmail(delConfirm)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
