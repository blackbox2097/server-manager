// src/pages/servers/Logs.jsx
import React, { useState, useEffect, useCallback } from 'react';
import {
  FileText, Search, Download, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Filter, X
} from 'lucide-react';
import clsx from 'clsx';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import { Spinner, Empty } from '../../components/ui';

const CATEGORIES = [
  { label: 'Sve',        prefix: ''            },
  { label: 'Serveri',    prefix: 'server.'      },
  { label: 'Skripte',    prefix: 'script.'      },
  { label: 'Zakazivanje',prefix: 'schedule.'    },
  { label: 'Prijave',    prefix: 'auth.'        },
  { label: 'Terminal',   prefix: 'terminal.'    },
  { label: 'SSH kljucevi', prefix: 'sshkey.'    },
  { label: 'Tenant/Korisnici', prefix: 'tenant.' },
];

export function actionLabel(action) {
  const map = {
    'auth.login': 'Prijava', 'auth.login_failed': 'Neuspela prijava',
    'auth.logout': 'Odjava', 'auth.password_change': 'Promena lozinke',
    'server.create': 'Server dodat', 'server.update': 'Server izmenjen', 'server.delete': 'Server obrisan',
    'server.status_online': 'Server online', 'server.status_offline': 'Server offline', 'server.status_warning': 'Server upozorenje',
    'script.create': 'Skripta dodata', 'script.update': 'Skripta izmenjena', 'script.delete': 'Skripta obrisana',
    'schedule.create': 'Zakazivanje dodato', 'schedule.update': 'Zakazivanje izmenjeno',
    'schedule.delete': 'Zakazivanje obrisano', 'schedule.toggle': 'Zakazivanje pauzirano/aktivirano',
    'terminal.connect': 'Terminal otvoren', 'terminal.disconnect': 'Terminal zatvoren',
    'sshkey.create': 'SSH kljuc dodat', 'sshkey.delete': 'SSH kljuc obrisan',
    'tenant.create': 'Tenant kreiran', 'tenant.update': 'Tenant izmenjen', 'tenant.delete': 'Tenant obrisan',
    'user.create': 'Operater kreiran', 'user.update': 'Operater izmenjen', 'user.delete': 'Operater obrisan',
    'user.tenant_assign': 'Dodela tenanata', 'smtp.update': 'SMTP izmenjen',
  };
  return map[action] || action;
}

export function LogRow({ log, showTenant = false }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = log.details && Object.keys(log.details).length > 0;

  return (
    <div className="border-b border-gray-800/50">
      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/30 transition-colors">
        <span className={log.success ? 'text-green-500' : 'text-red-500'} title={log.success ? 'Uspesno' : 'Neuspesno'}>
          {log.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-200">{actionLabel(log.action)}</span>
            {showTenant && log.tenant_name && <span className="badge-gray text-xs">{log.tenant_name}</span>}
            {log.resource_id && <span className="text-xs text-gray-600 font-mono">{log.resource_id.slice(0, 8)}</span>}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {log.username || 'sistem'} {log.ip_address && `· ${log.ip_address}`}
            {log.error_message && <span className="text-red-500"> · {log.error_message}</span>}
          </div>
        </div>
        <span className="text-xs text-gray-600 flex-shrink-0">
          {new Date(log.occurred_at).toLocaleString('sr', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </span>
        {hasDetails && (
          <button className="text-gray-600 hover:text-gray-400 flex-shrink-0" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      {expanded && hasDetails && (
        <div className="px-4 pb-3 pl-10">
          <pre className="text-xs text-gray-500 bg-gray-900 rounded-lg p-2 overflow-x-auto">
            {JSON.stringify(log.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function Logs() {
  const { activeTenant } = useAuthStore();
  const tenantId = activeTenant?.id;

  const [logs,     setLogs]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore,  setHasMore]  = useState(true);

  const [category, setCategory] = useState('');
  const [successFilter, setSuccessFilter] = useState(''); // '', 'true', 'false'
  const [search,   setSearch]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const PAGE_SIZE = 50;

  const buildParams = (offset) => {
    const p = new URLSearchParams();
    if (category)      p.set('action', category);
    if (successFilter) p.set('success', successFilter);
    if (search)         p.set('search', search);
    if (dateFrom)        p.set('dateFrom', dateFrom);
    if (dateTo)          p.set('dateTo', dateTo + 'T23:59:59');
    p.set('limit', PAGE_SIZE);
    p.set('offset', offset);
    return p;
  };

  const fetchLogs = useCallback(async (reset = true) => {
    if (!tenantId) return;
    reset ? setLoading(true) : setLoadingMore(true);
    try {
      const offset = reset ? 0 : logs.length;
      const { data } = await api.get(`/tenants/${tenantId}/logs?${buildParams(offset)}`);
      setLogs(prev => reset ? data : [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, category, successFilter, search, dateFrom, dateTo]);

  useEffect(() => { fetchLogs(true); }, [tenantId, category, successFilter, dateFrom, dateTo]); // eslint-disable-line

  // debounce za slobodan tekst pretragu
  useEffect(() => {
    const t = setTimeout(() => fetchLogs(true), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = buildParams(0);
      params.delete('limit'); params.delete('offset');
      const res = await api.get(`/tenants/${tenantId}/logs/export?${params}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `logovi_${activeTenant?.name || tenantId}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Izvoz nije uspeo');
    } finally {
      setExporting(false);
    }
  };

  const activeFilterCount = [category, successFilter, search, dateFrom, dateTo].filter(Boolean).length;
  const clearFilters = () => { setCategory(''); setSuccessFilter(''); setSearch(''); setDateFrom(''); setDateTo(''); };

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
            <FileText size={18} /> Logovi
          </h1>
          <p className="text-sm text-gray-500">Aktivnosti u {activeTenant?.name} — poslednjih 30 dana</p>
        </div>
        <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? <Spinner size={14} /> : <><Download size={14} /> Izvezi CSV</>}
        </button>
      </div>

      {/* Kategorije */}
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map(c => (
          <button key={c.label} type="button"
            className={clsx('text-xs px-2.5 py-1 rounded-md border transition-colors',
              category === c.prefix
                ? 'bg-brand-900/50 border-brand-700 text-brand-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700')}
            onClick={() => setCategory(c.prefix)}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Napredni filteri */}
      <div className="card p-0 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-400 hover:bg-gray-800/30"
          onClick={() => setShowFilters(v => !v)}>
          <span className="flex items-center gap-2">
            <Filter size={14} /> Napredni filteri
            {activeFilterCount > 0 && <span className="badge-gray text-xs">{activeFilterCount}</span>}
          </span>
          {showFilters ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showFilters && (
          <div className="border-t border-gray-800 p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="label">Pretraga</label>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-gray-600" />
                <input className="input pl-7" placeholder="korisnik, ID, tekst..."
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Status</label>
              <select className="input" value={successFilter} onChange={e => setSuccessFilter(e.target.value)}>
                <option value="">Svi</option>
                <option value="true">Uspesno</option>
                <option value="false">Neuspesno</option>
              </select>
            </div>
            <div>
              <label className="label">Od datuma</label>
              <input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="label">Do datuma</label>
              <input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            {activeFilterCount > 0 && (
              <button className="btn-ghost text-xs col-span-2 md:col-span-4 justify-center" onClick={clearFilters}>
                <X size={13} /> Ocisti filtere
              </button>
            )}
          </div>
        )}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>
      ) : logs.length === 0 ? (
        <Empty icon={FileText} title="Nema logova" subtitle="Nema zabelezenih aktivnosti za odabrane filtere" />
      ) : (
        <div className="card p-0 overflow-hidden">
          {logs.map(log => <LogRow key={log.id} log={log} />)}
          {hasMore && (
            <div className="p-3 flex justify-center border-t border-gray-800">
              <button className="btn-secondary text-sm" onClick={() => fetchLogs(false)} disabled={loadingMore}>
                {loadingMore ? <Spinner size={14} /> : 'Ucitaj vise'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
