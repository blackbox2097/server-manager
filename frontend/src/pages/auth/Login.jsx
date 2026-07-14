// src/pages/auth/Login.jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, Eye, EyeOff } from 'lucide-react';
import useAuthStore from '../../store/authStore';
import { Alert, Spinner } from '../../components/ui';

export default function Login() {
  const [form, setForm]     = useState({ username: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');
  const { login }   = useAuthStore();
  const navigate    = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password) { setError('Popuni oba polja'); return; }
    setError(''); setLoading(true);
    try {
      await login(form.username, form.password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Greška pri prijavi');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-brand-600 rounded-xl flex items-center justify-center mb-3">
            <Server size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-semibold text-gray-100">Server Manager</h1>
          <p className="text-sm text-gray-500 mt-1">Prijavi se na platformu</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          {error && <Alert type="error" message={error} onClose={() => setError('')} />}

          <div>
            <label className="label">Korisničko ime</label>
            <input className="input" type="text" autoFocus autoComplete="username"
              placeholder="superadmin"
              value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
          </div>

          <div>
            <label className="label">Lozinka</label>
            <div className="relative">
              <input className="input pr-10" type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••••"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              <button type="button" className="absolute right-3 top-2.5 text-gray-500 hover:text-gray-300"
                onClick={() => setShowPw(v => !v)}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" className="btn-primary w-full justify-center py-2.5" disabled={loading}>
            {loading ? <Spinner size={16} /> : 'Prijavi se'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-700 mt-6">
          Server Manager v1.0
        </p>
      </div>
    </div>
  );
}
