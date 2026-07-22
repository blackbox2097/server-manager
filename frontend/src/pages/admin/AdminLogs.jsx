// src/pages/admin/AdminLogs.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { FileText, Search, Download, ChevronDown, ChevronUp, Filter, X } from 'lucide-react';
import clsx from 'clsx';
import api from '../../services/api';
import { Spinner, Empty } from '../../components/ui';
import { LogRow, actionLabel } from '../servers/Logs';

const CATEGORIES = [
  { label: 'Sve',          prefix: ''             },
  { label: 'Serveri',      prefix: 'server.'      },
  { label: 'Skripte',      prefix: 'script.'      },
  { label: 'Zakazivanje',  prefix: 'schedule.'    },
  { label: 'Prijave',      prefix: 'auth.'        },
  { label: 'Terminal',     prefix: 'terminal.'    },
  { label: 'Tenant/Korisnici', prefix: 'tenant.'  },
  { label: 'Backup',       prefix: 'backup.'      },
];

export default function AdminLogs() {
  const [logs,     setLogs]     = useState([]);
  const [tenants,  setTenants]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore,  setHasMore]  = useState(true);
  const [exporting, setExporting] = useState(false);

  const [category, setCategory]   = useState('');
  const [tenantId, setTenantId]   = useState('');
  const [successFilter, setSuccessFilter] = useState('');
  const [search,   setSearch]     = useState('');
  const [dateFrom, setDateFrom]   = useState('');
  const [dateTo,   setDateTo]     = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const PAGE_SIZE = 50;

  useEffect(() => {
    api.get('/admin/tenants').then(({ data }) => setTenants(data)).catch(() => {});
  }, []);

  const buildParams = (offset) => {
    const p = new URLSearchParams();
    if (category)      p.set('action', category);
    if (tenantId)       p.set('tenantId', tenantId);
    if (successFilter) p.set('success', successFilter);
    if (search)          p.set('search', search);
    if (dateFrom)         p.set('dateFrom', dateFrom);
    if (dateTo)            p.set('dateTo', dateTo + 'T23:59:59');
    p.set('limit', PAGE_SIZE);
    p.set('offset', offset);
    return p;
  };

  const fetchLogs = useCallback(async (reset = true) => {
    reset ? setLoading(true) : setLoadingMore(true);
    try {
      const offset = reset ? 0 : logs.length;
      const { data } = await api.get(`/admin/audit?${buildParams(offset)}`);
      setLogs(prev => reset ? data : [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, tenantId, successFilter, dateFrom, dateTo]);

  useEffect(() => { fetchLogs(true); }, [category, tenantId, successFilter, dateFrom, dateTo]); // eslint-disable-line

  useEffect(() => {
    const t = setTimeout(() => fetchLogs(true), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = buildParams(0);
      params.delete('limit'); params.delete('offset');
      const res = await api.get(`/admin/audit/export?${params}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `logovi_svi_tenanti_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Izvoz nije uspeo');
    } finally {
      setExporting(false);
    }
  };

  const activeFilterCount = [category, tenantId, successFilter, search, dateFrom, dateTo].filter(Boolean).length;
  const clearFilters = () => { setCategory(''); setTenantId(''); setSuccessFilter(''); setSearch(''); setDateFrom(''); setDateTo(''); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
            <FileText size={18} /> Logovi — svi tenanti
          </h1>
          <p className="text-sm text-gray-500">Globalni pregled aktivnosti, poslednjih 30 dana</p>
        </div>
        <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? <Spinner size={14} /> : <><Download size={14} /> Izvezi CSV</>}
        </button>
      </div>

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
          <div className="border-t border-gray-800 p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="label">Tenant</label>
              <select className="input" value={tenantId} onChange={e => setTenantId(e.target.value)}>
                <option value="">Svi</option>
                {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
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
              <button className="btn-ghost text-xs col-span-2 md:col-span-5 justify-center" onClick={clearFilters}>
                <X size={13} /> Ocisti filtere
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>
      ) : logs.length === 0 ? (
        <Empty icon={FileText} title="Nema logova" subtitle="Nema zabelezenih aktivnosti za odabrane filtere" />
      ) : (
        <div className="card p-0 overflow-hidden">
          {logs.map(log => <LogRow key={log.id} log={log} showTenant />)}
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
