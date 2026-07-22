// src/pages/admin/Backup.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, Download, Trash2, Upload, RotateCcw,
  AlertTriangle, Loader2
} from 'lucide-react';
import api from '../../services/api';
import { Modal, Alert, Spinner, ConfirmDialog } from '../../components/ui';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RestoreModal({ backup, onClose, onDone }) {
  const [summary, setSummary]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [error, setError]         = useState('');
  const [initiated, setInitiated] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(() => {
    api.get('/admin/backup/summary')
       .then(({ data }) => setSummary(data))
       .catch(() => setError('Ne mogu da učitam trenutno stanje baze'))
       .finally(() => setLoading(false));
  }, []);

  const handleRestore = async () => {
    if (confirmText !== 'RESTORE') return;
    setRestoring(true); setError('');
    try {
      await api.post(`/admin/backup/${backup.filename}/restore`, { confirmText });
      setInitiated(true);
      pollHealth();
    } catch (err) {
      setError(err.response?.data?.detail || 'Restore nije uspeo');
      setRestoring(false);
    }
  };

  const pollHealth = () => {
    setCheckingHealth(true);
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch('/health');
        if (res.ok) {
          clearInterval(interval);
          setCheckingHealth(false);
          setTimeout(() => { window.location.href = '/login'; }, 1500);
        }
      } catch {}
      if (attempts > 60) { clearInterval(interval); setCheckingHealth(false); }
    }, 3000);
  };

  return (
    <Modal open={true} onClose={initiated ? () => {} : onClose} title="Vrati bazu iz backup-a">
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size={24} className="text-brand-500" /></div>
      ) : initiated ? (
        <div className="text-center py-6 space-y-3">
          {checkingHealth ? (
            <>
              <Loader2 size={32} className="mx-auto text-brand-500 animate-spin" />
              <p className="text-sm text-gray-300">Restore u toku — aplikacija se restartuje...</p>
              <p className="text-xs text-gray-600">Ovo obično traje 30-60 sekundi. Stranica će se sama osvežiti.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-green-400">Aplikacija je ponovo online!</p>
              <p className="text-xs text-gray-600">Preusmeravam na login...</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {error && <Alert type="error" message={error} />}

          <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 flex gap-2">
            <AlertTriangle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-300">
              <p className="font-medium">Ovo će OBRISATI sve trenutne podatke i zameniti ih sadržajem iz backup fajla.</p>
              <p className="text-xs text-red-400/80 mt-1">Ova akcija se ne može poništiti. Aplikacija će biti nedostupna dok se restore ne završi.</p>
            </div>
          </div>

          <div className="text-sm">
            <p className="text-gray-400 mb-1">Backup fajl:</p>
            <p className="font-mono text-xs text-gray-300">{backup.filename}</p>
            <p className="text-xs text-gray-600">{new Date(backup.createdAt).toLocaleString('sr')} · {formatSize(backup.sizeBytes)}</p>
          </div>

          {summary && (
            <div className="text-sm">
              <p className="text-gray-400 mb-1.5">Trenutno u bazi (biće zamenjeno):</p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Tenanti:</span> <span className="text-gray-200">{summary.tenants ?? '—'}</span></div>
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Serveri:</span> <span className="text-gray-200">{summary.servers ?? '—'}</span></div>
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Korisnici:</span> <span className="text-gray-200">{summary.users ?? '—'}</span></div>
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Skripte:</span> <span className="text-gray-200">{summary.scripts ?? '—'}</span></div>
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Izvršavanja:</span> <span className="text-gray-200">{summary.executions ?? '—'}</span></div>
                <div className="bg-gray-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">SSH ključevi:</span> <span className="text-gray-200">{summary.sshKeys ?? '—'}</span></div>
              </div>
            </div>
          )}

          <div>
            <label className="label">Da bi potvrdio, upiši <span className="font-mono text-red-400">RESTORE</span> ispod:</label>
            <input className="input" value={confirmText} onChange={e => setConfirmText(e.target.value)}
              placeholder="RESTORE" autoComplete="off" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={onClose} disabled={restoring}>Otkaži</button>
            <button className="btn-danger" onClick={handleRestore} disabled={confirmText !== 'RESTORE' || restoring}>
              {restoring ? <Spinner size={14} /> : 'Vrati bazu (nepovratno)'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Backup() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [delConfirm, setDelConfirm] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const fetchBackups = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/backup');
      setBackups(data);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchBackups(); }, [fetchBackups]);

  const handleCreate = async () => {
    setCreating(true); setError(''); setSuccess('');
    try {
      await api.post('/admin/backup');
      setSuccess('Backup uspešno kreiran.');
      fetchBackups();
    } catch (err) {
      setError(err.response?.data?.detail || 'Backup nije uspeo');
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = (filename) => {
    window.open(`/api/admin/backup/${filename}/download`, '_blank');
  };

  const handleDelete = async (filename) => {
    try {
      await api.delete(`/admin/backup/${filename}`);
      setBackups(prev => prev.filter(b => b.filename !== filename));
      setDelConfirm(null);
    } catch (err) {
      setDelConfirm(null);
      setError(err.response?.data?.detail || 'Brisanje nije uspelo');
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError(''); setSuccess('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post('/admin/backup/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSuccess('Backup fajl otpremljen.');
      fetchBackups();
    } catch (err) {
      setError(err.response?.data?.detail || 'Otpremanje nije uspelo');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
          <Database size={18} /> Backup i restore baze
        </h1>
        <p className="text-sm text-gray-500">Ručno pravljenje i vraćanje kompletne baze podataka</p>
      </div>

      {error   && <Alert type="error"   message={error}   onClose={() => setError('')} />}
      {success && <Alert type="success" message={success} onClose={() => setSuccess('')} />}

      <div className="card flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-200">Napravi backup sada</p>
          <p className="text-xs text-gray-500">Pravi kompletnu kopiju baze (pg_dump), traje par sekundi</p>
        </div>
        <button className="btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? <Spinner size={14} /> : <><Database size={14} /> Backup sada</>}
        </button>
      </div>

      <div className="card flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-200">Otpremi backup fajl</p>
          <p className="text-xs text-gray-500">Za vraćanje backup-a preuzetog ranije ili sa drugog servera</p>
        </div>
        <button className="btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <Spinner size={14} /> : <><Upload size={14} /> Otpremi</>}
        </button>
        <input ref={fileInputRef} type="file" accept=".dump" className="hidden" onChange={handleUpload} />
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-sm font-medium text-gray-300">Sačuvani backup-i ({backups.length})</p>
        </div>
        {loading ? (
          <div className="flex justify-center py-8"><Spinner size={24} className="text-brand-500" /></div>
        ) : backups.length === 0 ? (
          <div className="py-8 text-center text-gray-600 text-sm">Nema sačuvanih backup-a</div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {backups.map(b => (
              <div key={b.filename} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-300 font-mono truncate">{b.filename}</p>
                  <p className="text-xs text-gray-600">
                    {new Date(b.createdAt).toLocaleString('sr')} · {formatSize(b.sizeBytes)}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button className="btn-ghost py-1 px-2" onClick={() => handleDownload(b.filename)} title="Preuzmi">
                    <Download size={14} />
                  </button>
                  <button className="btn-ghost py-1 px-2 text-yellow-500 hover:text-yellow-400"
                    onClick={() => setRestoreTarget(b)} title="Vrati bazu iz ovog backup-a">
                    <RotateCcw size={14} />
                  </button>
                  <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                    onClick={() => setDelConfirm(b)} title="Obriši">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {restoreTarget && (
        <RestoreModal
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={() => setRestoreTarget(null)}
        />
      )}

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši backup"
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.filename}"?`}
        danger
        onConfirm={() => handleDelete(delConfirm.filename)}
        onCancel={() => setDelConfirm(null)}
      />
    </div>
  );
}
