// src/pages/admin/SmtpSettings.jsx
import React, { useState, useEffect } from 'react';
import { Mail, Send } from 'lucide-react';
import api from '../../services/api';
import { Alert, Spinner } from '../../components/ui';

export default function SmtpSettings() {
  const [form, setForm] = useState({
    host: '', port: 587, username: '', password: '',
    fromEmail: '', fromName: 'Server Manager', useTls: true,
  });
  const [passwordSet, setPasswordSet] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const [testEmail, setTestEmail]     = useState('');
  const [testing,   setTesting]       = useState(false);
  const [testResult, setTestResult]   = useState(null);

  useEffect(() => {
    api.get('/admin/smtp-settings')
       .then(({ data }) => {
         if (data.configured) {
           setForm(f => ({
             ...f,
             host: data.host || '', port: data.port || 587,
             username: data.username || '', password: '',
             fromEmail: data.from_email || '', fromName: data.from_name || 'Server Manager',
             useTls: data.use_tls ?? true,
           }));
           setPasswordSet(data.passwordSet);
         }
       })
       .catch(() => {})
       .finally(() => setLoading(false));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.host || !form.fromEmail) { setError('Host i "šalje sa" adresa su obavezni'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = { ...form, password: form.password || undefined };
      const { data } = await api.put('/admin/smtp-settings', payload);
      setPasswordSet(data.passwordSet);
      setForm(f => ({ ...f, password: '' }));
      setSuccess('Podešavanja sačuvana.');
    } catch (err) {
      setError(err.response?.data?.detail || 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!testEmail) return;
    setTesting(true); setTestResult(null);
    try {
      await api.post('/admin/smtp-settings/test', { to: testEmail });
      setTestResult({ ok: true, msg: `Test email poslat na ${testEmail}` });
    } catch (err) {
      setTestResult({ ok: false, msg: err.response?.data?.detail || 'Slanje nije uspelo' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
          <Mail size={18} /> SMTP podešavanja
        </h1>
        <p className="text-sm text-gray-500">Server za slanje email alarma i izveštaja — globalno za celu aplikaciju</p>
      </div>

      <div className="card space-y-3">
        {error   && <Alert type="error"   message={error}   onClose={() => setError('')} />}
        {success && <Alert type="success" message={success} onClose={() => setSuccess('')} />}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">SMTP host *</label>
            <input className="input" value={form.host} onChange={e => set('host', e.target.value)}
              placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input" type="number" value={form.port}
              onChange={e => set('port', parseInt(e.target.value) || 587)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Korisničko ime</label>
            <input className="input" value={form.username} onChange={e => set('username', e.target.value)} />
          </div>
          <div>
            <label className="label">Lozinka {passwordSet && <span className="text-gray-600">(postavljena)</span>}</label>
            <input className="input" type="password" value={form.password}
              onChange={e => set('password', e.target.value)}
              placeholder={passwordSet ? 'Ostavi prazno da zadržiš staru' : ''} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Šalje sa (email) *</label>
            <input className="input" type="email" value={form.fromEmail}
              onChange={e => set('fromEmail', e.target.value)} placeholder="alerts@firma.com" />
          </div>
          <div>
            <label className="label">Šalje kao (naziv)</label>
            <input className="input" value={form.fromName} onChange={e => set('fromName', e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="accent-brand-500" checked={form.useTls}
            onChange={e => set('useTls', e.target.checked)} />
          <span className="text-sm text-gray-300">Koristi TLS (preporučeno, port 587)</span>
        </label>

        <div className="flex justify-end pt-2">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <Spinner size={14} /> : 'Sačuvaj'}
          </button>
        </div>
      </div>

      <div className="card space-y-3">
        <p className="text-sm font-medium text-gray-300">Test slanje</p>
        {testResult && <Alert type={testResult.ok ? 'success' : 'error'} message={testResult.msg} />}
        <div className="flex gap-2">
          <input className="input flex-1" type="email" placeholder="tvoj-email@primer.com"
            value={testEmail} onChange={e => setTestEmail(e.target.value)} />
          <button className="btn-secondary flex-shrink-0" onClick={handleTest} disabled={testing || !testEmail}>
            {testing ? <Spinner size={14} /> : <><Send size={14} /> Pošalji test</>}
          </button>
        </div>
      </div>
    </div>
  );
}
