// src/components/layout/Layout.jsx
import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Server, Activity, Terminal, BookOpen, Users,
  ChevronDown, LogOut, Shield, Menu, X, KeyRound, RefreshCw, Key, Clock, Bell, Mail, FileText, Database, Zap
} from 'lucide-react';
import clsx from 'clsx';
import useAuthStore from '../../store/authStore';
import api from '../../services/api';
import { Modal, Alert, Spinner } from '../ui';

const navItems = [
  { to: '/dashboard',  icon: Activity, label: 'Dashboard'   },
  { to: '/servers',    icon: Server,   label: 'Serveri'     },
  { to: '/ssh-keys',   icon: Key,      label: 'SSH Kljucevi'},
  { to: '/monitoring', icon: Activity, label: 'Monitoring'  },
  { to: '/scripts',    icon: BookOpen, label: 'Skripte'     },
  { to: '/schedules',  icon: Clock,    label: 'Zakazano'    },
  { to: '/execute',    icon: Terminal, label: 'Izvrsavanje' },
  { to: '/alerts',     icon: Bell,     label: 'Alarmi'      },
  { to: '/automation', icon: Zap,      label: 'Automatizacija' },
  { to: '/logs',       icon: FileText, label: 'Logovi'      },
];

const adminItems = [
  { to: '/admin/tenants', icon: Shield,   label: 'Tenanti'   },
  { to: '/admin/users',   icon: Users,    label: 'Operateri' },
  { to: '/admin/smtp',    icon: Mail,     label: 'SMTP'      },
  { to: '/admin/logs',    icon: FileText, label: 'Logovi (svi tenanti)' },
  { to: '/admin/backup',  icon: Database, label: 'Backup' },
];

// ── Change password modal ─────────────────────────────────────────────────────
function ChangePasswordModal({ open, onClose }) {
  const [form, setForm]       = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    setError('');
    if (!form.currentPassword || !form.newPassword) { setError('Sva polja su obavezna'); return; }
    if (form.newPassword.length < 10) { setError('Nova lozinka mora imati minimum 10 karaktera'); return; }
    if (form.newPassword !== form.confirmPassword) { setError('Nove lozinke se ne poklapaju'); return; }
    setSaving(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword:     form.newPassword,
      });
      setSuccess(true);
      setTimeout(() => {
        onClose();
        setSuccess(false);
        setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'Greska pri promeni lozinke');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setError('');
    setSuccess(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Promeni lozinku"
      footer={<>
        <button className="btn-secondary" onClick={handleClose}>Otkazaj</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving || success}>
          {saving ? <Spinner size={14} /> : 'Sacuvaj'}
        </button>
      </>}>
      <div className="space-y-3">
        {error   && <Alert type="error"   message={error} onClose={() => setError('')} />}
        {success && <Alert type="success" message="Lozinka uspesno promenjena!" />}
        <div>
          <label className="label">Trenutna lozinka</label>
          <input className="input" type="password" value={form.currentPassword}
            onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} />
        </div>
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
      </div>
    </Modal>
  );
}

// ── Tenant selector ───────────────────────────────────────────────────────────
function TenantSelector({ tenants, activeTenant, setActiveTenant, onRefresh, loading }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-3 py-3 border-b border-gray-800">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <p className="text-xs text-gray-600">Aktivni tenant</p>
        <button onClick={onRefresh} className="text-gray-700 hover:text-gray-400 transition-colors" title="Osvezi listu tenanata">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm transition-colors">
          {activeTenant ? (
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: activeTenant.color || '#6366f1' }} />
          ) : (
            <span className="w-2 h-2 rounded-full flex-shrink-0 bg-gray-600" />
          )}
          <span className="flex-1 text-left text-gray-100 truncate">
            {activeTenant?.name || '— Odaberi tenant —'}
          </span>
          <ChevronDown size={14} className="text-gray-500 flex-shrink-0" />
        </button>

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden z-20 max-h-48 overflow-y-auto">
            {tenants.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-600">Nema tenanata — kreiraj u Admin panelu</div>
            ) : (
              tenants.map(t => (
                <button key={t.id}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-left',
                    activeTenant?.id === t.id ? 'bg-brand-900/50 text-brand-300' : 'text-gray-300 hover:bg-gray-700'
                  )}
                  onClick={() => { setActiveTenant(t); setOpen(false); }}>
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color || '#6366f1' }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {activeTenant?.id === t.id && <span className="text-xs text-brand-500">✓</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Glavna Layout komponenta ──────────────────────────────────────────────────
export default function Layout({ children }) {
  const { user, tenants, activeTenant, setActiveTenant, logout } = useAuthStore();
  const navigate = useNavigate();

  const [sideOpen,     setSideOpen]     = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [refreshing,   setRefreshing]   = useState(false);

  const isSuperadmin = user?.role === 'superadmin';

  // Osvezi listu tenanata (korisno kad superadmin doda novi tenant)
  const refreshTenants = async () => {
    setRefreshing(true);
    try {
      const { data } = await api.get('/auth/me');
      // Azuriraj store sa novim tenantima
      useAuthStore.setState({ tenants: data.tenants || [] });
      // Ako aktivni tenant nije vise u listi, resetuj
      if (activeTenant && !data.tenants.find(t => t.id === activeTenant.id)) {
        setActiveTenant(data.tenants[0] || null);
      }
      // Ako nema aktivnog a ima tenanata, postavi prvi
      if (!activeTenant && data.tenants.length > 0) {
        setActiveTenant(data.tenants[0]);
      }
    } catch {}
    setRefreshing(false);
  };

  // Automatski osvezi kad nema aktivnog tenanta a ima ih u listi
  useEffect(() => {
    if (!activeTenant && tenants.length > 0) {
      setActiveTenant(tenants[0]);
    }
  }, [tenants]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const NavItem = ({ to, icon: Icon, label }) => (
    <NavLink to={to} onClick={() => setSideOpen(false)}
      className={({ isActive }) =>
        clsx('flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
          isActive
            ? 'bg-brand-600 text-white'
            : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800')}>
      <Icon size={16} />
      {label}
    </NavLink>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {sideOpen && (
        <div className="fixed inset-0 z-20 bg-black/60 lg:hidden" onClick={() => setSideOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={clsx(
        'fixed lg:static inset-y-0 left-0 z-30 w-60 flex-shrink-0 flex flex-col',
        'bg-gray-950 border-r border-gray-800 transition-transform duration-200',
        sideOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      )}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-800">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <Server size={14} className="text-white" />
          </div>
          <span className="font-semibold text-gray-100 text-sm">Server Manager</span>
          <button className="ml-auto lg:hidden text-gray-500" onClick={() => setSideOpen(false)}>
            <X size={18} />
          </button>
        </div>

        {/* Tenant selector — prikazuje se i superadminu i operateru */}
        <TenantSelector
          tenants={tenants}
          activeTenant={activeTenant}
          setActiveTenant={setActiveTenant}
          onRefresh={refreshTenants}
          loading={refreshing}
        />

        {/* Navigacija */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {navItems.map(item => <NavItem key={item.to} {...item} />)}

          {isSuperadmin && (
            <>
              <div className="pt-4 pb-1 px-1">
                <p className="text-xs font-medium text-gray-600 uppercase tracking-wider">Admin</p>
              </div>
              {adminItems.map(item => <NavItem key={item.to} {...item} />)}
            </>
          )}
        </nav>

        {/* User meni */}
        <div className="p-3 border-t border-gray-800">
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
              <div className="w-7 h-7 rounded-full bg-brand-600/30 flex items-center justify-center text-xs font-medium text-brand-400 flex-shrink-0">
                {user?.username?.[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-xs font-medium text-gray-200 truncate">{user?.username}</p>
                <p className="text-xs text-gray-600">{isSuperadmin ? 'Superadmin' : 'Operater'}</p>
              </div>
              <ChevronDown size={14} className="text-gray-600 flex-shrink-0" />
            </button>

            {userMenuOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden z-10">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                  onClick={() => { setChangePwOpen(true); setUserMenuOpen(false); }}>
                  <KeyRound size={14} className="text-gray-500" />
                  Promeni lozinku
                </button>
                <div className="border-t border-gray-700" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 hover:bg-gray-700 transition-colors"
                  onClick={handleLogout}>
                  <LogOut size={14} />
                  Odjava
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 lg:hidden">
          <button onClick={() => setSideOpen(true)} className="text-gray-400">
            <Menu size={20} />
          </button>
          <span className="font-medium text-sm">Server Manager</span>
        </div>
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 lg:p-6 min-w-0">
          {children}
        </main>
      </div>

      <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />
    </div>
  );
}
