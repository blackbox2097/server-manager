// src/pages/servers/Servers.jsx
import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit, Trash2, Plug, Server, TerminalSquare, ArrowDown, ArrowUp, Cpu, RotateCw } from 'lucide-react';
import api from '../../services/api';
import useAuthStore from '../../store/authStore';
import {
  StatusBadge, MetricCell, Modal, ConfirmDialog,
  Alert, Spinner, Empty, Table, formatUptime, formatNetSpeed
} from '../../components/ui';
import ProcessListModal from '../../components/ProcessListModal';

// ── ServerForm je na nivou modula — nikad se ne re-kreira
// F mora biti VAN ServerForm — inače se re-kreira na svakom render-u
// i React unmountuje/mountuje svaki input unutar njega
function F({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

const ServerForm = memo(function ServerForm({ serverRef, tenantId, onSave, onClose }) {
  const server = serverRef.current;
  const isEdit = !!server?.id;

  const [form, setForm] = useState(() => ({
    name: '', description: '', hostname: '', ipAddress: '',
    osType: 'linux', osName: '', environment: 'production', tags: '',
    sshPort: 22, sshUser: 'root', sshAuthType: 'key', sshKeyId: '', sshPassword: '',
    sudoPassword: '',
    winrmPort: 5985, winrmHttps: false, winrmAuthType: 'local',
    winrmUser: 'Administrator', winrmPassword: '',
    ...(server ? {
      name:          server.name          || '',
      description:   server.description   || '',
      hostname:      server.hostname      || '',
      ipAddress:     server.ip_address    || '',
      osType:        server.os_type       || 'linux',
      osName:        server.os_name       || '',
      environment:   server.environment   || 'production',
      tags:          (server.tags || []).join(', '),
      sshPort:       server.ssh_port      || 22,
      sshUser:       server.ssh_user      || '',
      sshAuthType:   server.ssh_auth_type || 'key',
      sshKeyId:      server.ssh_key_id    || '',
      sudoPassword:  '',  // nikad ne prikazuj postojeću
      winrmPort:     server.winrm_port    || 5985,
      winrmHttps:    server.winrm_https   || false,
      winrmAuthType: server.winrm_auth_type || 'local',
      winrmUser:     server.winrm_user    || '',
    } : {}),
  }));

  const [sshKeys, setSshKeys] = useState([]);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    api.get(`/tenants/${tenantId}/ssh-keys`)
       .then(r => setSshKeys(r.data))
       .catch(() => {});
  }, [tenantId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name || !form.ipAddress) { setError('Naziv i IP adresa su obavezni'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        sshPassword:   form.sshPassword   || undefined,
        sudoPassword:  form.sudoPassword  || undefined,
        winrmPassword: form.winrmPassword || undefined,
      };
      if (isEdit) await api.put(`/tenants/${tenantId}/servers/${server.id}`, payload);
      else        await api.post(`/tenants/${tenantId}/servers`, payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Greška pri čuvanju');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert type="error" message={error} />}

      <div className="grid grid-cols-2 gap-3">
        <F label="Naziv *">
          <input className="input" value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="web-prod-01" />
        </F>
        <F label="IP adresa *">
          <input className="input" value={form.ipAddress}
            onChange={e => set('ipAddress', e.target.value)}
            placeholder="10.0.1.10" />
        </F>
        <F label="Hostname">
          <input className="input" value={form.hostname}
            onChange={e => set('hostname', e.target.value)}
            placeholder="web1.domena.local" />
        </F>
        <F label="OS tip">
          <select className="input" value={form.osType}
            onChange={e => set('osType', e.target.value)}>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </F>
        <F label="OS naziv">
          <input className="input" value={form.osName}
            onChange={e => set('osName', e.target.value)}
            placeholder="Ubuntu 24.04" />
        </F>
        <F label="Okruženje">
          <select className="input" value={form.environment}
            onChange={e => set('environment', e.target.value)}>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="dev">Dev</option>
          </select>
        </F>
        <F label="Tagovi (odvojeni zarezom)">
          <input className="input" value={form.tags}
            onChange={e => set('tags', e.target.value)}
            placeholder="web, nginx, prod" />
        </F>
        <F label="Opis">
          <input className="input" value={form.description}
            onChange={e => set('description', e.target.value)} />
        </F>
      </div>

      {(form.osType === 'linux' || form.osType === 'windows') && (
        <div className="border border-gray-800 rounded-lg p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            SSH konfiguracija{form.osType === 'windows' ? ' (za terminal — zahteva OpenSSH Server na Windows mašini)' : ''}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <F label="Port">
              <input className="input" type="number" value={form.sshPort}
                onChange={e => set('sshPort', parseInt(e.target.value) || 22)} />
            </F>
            <F label="Korisnik">
              <input className="input" value={form.sshUser}
                onChange={e => set('sshUser', e.target.value)} />
            </F>
            <F label="Auth tip">
              <select className="input" value={form.sshAuthType}
                onChange={e => set('sshAuthType', e.target.value)}>
                <option value="key">SSH ključ</option>
                <option value="password">Lozinka</option>
                <option value="key_and_password">Ključ + lozinka</option>
              </select>
            </F>
          </div>
          {(form.sshAuthType === 'key' || form.sshAuthType === 'key_and_password') && (
            <F label="SSH ključ">
              <select className="input" value={form.sshKeyId}
                onChange={e => set('sshKeyId', e.target.value)}>
                <option value="">— Odaberi ključ —</option>
                {sshKeys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </F>
          )}
          {(form.sshAuthType === 'password' || form.sshAuthType === 'key_and_password') && (
            <F label="SSH lozinka">
              <input className="input" type="password" value={form.sshPassword}
                onChange={e => set('sshPassword', e.target.value)}
                placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : ''} />
            </F>
          )}
          <F label="Sudo lozinka (opciono — za pokretanje skripti sa root pravima)">
            <input className="input" type="password" value={form.sudoPassword}
              onChange={e => set('sudoPassword', e.target.value)}
              placeholder={isEdit && server?.has_sudo_password ? '(postavljena — ostavi prazno da zadržiš)' : '(prazno = bez sudo-a)'} />
          </F>
        </div>
      )}

      {form.osType === 'windows' && (
        <div className="border border-gray-800 rounded-lg p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">WinRM konfiguracija</p>
          <div className="grid grid-cols-3 gap-3">
            <F label="Port">
              <input className="input" type="number" value={form.winrmPort}
                onChange={e => set('winrmPort', parseInt(e.target.value) || 5985)} />
            </F>
            <F label="Auth tip">
              <select className="input" value={form.winrmAuthType}
                onChange={e => set('winrmAuthType', e.target.value)}>
                <option value="local">Lokalni nalog</option>
                <option value="domain">Domenski nalog</option>
              </select>
            </F>
            <F label="HTTPS">
              <select className="input" value={form.winrmHttps ? '1' : '0'}
                onChange={e => set('winrmHttps', e.target.value === '1')}>
                <option value="0">HTTP (5985)</option>
                <option value="1">HTTPS (5986)</option>
              </select>
            </F>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <F label="Korisnik">
              <input className="input" value={form.winrmUser}
                onChange={e => set('winrmUser', e.target.value)}
                placeholder="Administrator" />
            </F>
            <F label="Lozinka">
              <input className="input" type="password" value={form.winrmPassword}
                onChange={e => set('winrmPassword', e.target.value)}
                placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : ''} />
            </F>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onClose}>Otkaži</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner size={14} /> : (isEdit ? 'Sačuvaj izmene' : 'Dodaj server')}
        </button>
      </div>
    </div>
  );
}, () => true);  // Drugi argument memo-a: uvek true = nikad ne re-renderuj zbog propa

// ── Glavna komponenta ─────────────────────────────────────────────────────────
export default function Servers() {
  const { activeTenant, hasPerm } = useAuthStore();
  const navigate  = useNavigate();
  const tenantId  = activeTenant?.id;
  const canManage = hasPerm('perm_servers_manage');
  const canTerminal = hasPerm('perm_scripts_run');

  const [servers,    setServers]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modalOpen,  setModalOpen]  = useState(false);
  const [modalTitle, setModalTitle] = useState('Dodaj server');
  const [delConfirm, setDelConfirm] = useState(null);
  const [restartConfirm, setRestartConfirm] = useState(null);
  const [restarting, setRestarting] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [testing,    setTesting]    = useState(null);
  const [procModalServer, setProcModalServer] = useState(null);

  // useRef — čuva server koji se edituje, ne trigeruje re-render forme
  const editServerRef = useRef(null);

  const fetchServers = useCallback(async () => {
    if (!tenantId) return;
    try {
      const { data } = await api.get(`/tenants/${tenantId}/servers`);
      setServers(data);
    } catch {}
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  const openAdd = useCallback(() => {
    editServerRef.current = null;
    setModalTitle('Dodaj server');
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((s) => {
    editServerRef.current = s;
    setModalTitle(`Uredi: ${s.name}`);
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const handleSave = useCallback(() => {
    setModalOpen(false);
    fetchServers();
  }, [fetchServers]);

  const handleDelete = async (id) => {
    await api.delete(`/tenants/${tenantId}/servers/${id}`);
    setServers(prev => prev.filter(s => s.id !== id));
    setDelConfirm(null);
  };

  const handleRestart = async (server) => {
    setRestarting(server.id);
    setRestartConfirm(null);
    try {
      await api.post(`/tenants/${tenantId}/servers/${server.id}/restart`);
      alert(`Restart komanda poslata za "${server.name}" — server ce biti nedostupan par minuta.`);
    } catch (err) {
      alert(err.response?.data?.detail || 'Restart nije uspeo');
    } finally {
      setRestarting(null);
    }
  };

  const handleTest = async (server) => {
    setTesting(server.id);
    try {
      const { data } = await api.post(`/tenants/${tenantId}/servers/${server.id}/test`);
      setTestResult(prev => ({ ...prev, [server.id]: data }));
    } catch {
      setTestResult(prev => ({ ...prev, [server.id]: { ok: false } }));
    } finally {
      setTesting(null);
    }
  };

  const openProcesses = (server) => setProcModalServer(server);

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Serveri</h1>
          <p className="text-sm text-gray-500">{servers.length} servera u {activeTenant?.name}</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={openAdd}>
            <Plus size={16} /> Dodaj server
          </button>
        )}
      </div>

      {servers.length === 0 ? (
        <Empty icon={Server} title="Nema servera"
          subtitle="Dodaj prvi server u ovaj tenant"
          action={canManage && (
            <button className="btn-primary" onClick={openAdd}>
              <Plus size={14} /> Dodaj server
            </button>
          )} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table
            columns={[
              { key: 'name', label: 'Server', render: s => (
                <div>
                  <div className="font-medium text-gray-200">{s.name}</div>
                  <div className="text-xs text-gray-500">{s.ip_address} · {s.os_type === 'windows' ? '🪟 Windows' : '🐧 Linux'}</div>
                </div>
              )},
              { key: 'status', label: 'Status',   render: s => <StatusBadge status={s.status} /> },
              { key: 'cpu',    label: 'CPU',       render: s => <MetricCell value={s.cpu_percent}  label="CPU"  /> },
              { key: 'ram',    label: 'RAM',       render: s => <MetricCell value={s.ram_percent}  label="RAM"  /> },
              { key: 'disk',   label: 'Disk',      render: s => <MetricCell value={s.disk_percent} label="Disk" /> },
              { key: 'uptime', label: 'Uptime',    render: s => <span className="text-xs text-gray-500">{formatUptime(s.uptime_seconds)}</span> },
              { key: 'net',    label: 'Mreza',     render: s => (
                <div className="text-xs text-gray-500 space-y-0.5">
                  <div className="flex items-center gap-1">
                    <ArrowDown size={10} className="text-green-500" />
                    {formatNetSpeed(s.net_rx_kbps)}
                  </div>
                  <div className="flex items-center gap-1">
                    <ArrowUp size={10} className="text-blue-500" />
                    {formatNetSpeed(s.net_tx_kbps)}
                  </div>
                </div>
              )},
              { key: 'procs',  label: 'Procesi',   render: s => (
                <button
                  className="text-xs text-gray-500 hover:text-brand-400 hover:underline flex items-center gap-1 transition-colors disabled:cursor-not-allowed disabled:no-underline disabled:hover:text-gray-500"
                  onClick={() => openProcesses(s)}
                  disabled={s.process_count == null}
                  title={s.process_count == null ? 'Nema podataka' : 'Prikazi procese'}>
                  <Cpu size={11} />
                  {s.process_count ?? '—'}
                </button>
              )},
              { key: 'test',   label: 'Konekcija', render: s => (
                <div className="flex items-center gap-2">
                  <button className="btn-ghost text-xs py-1 px-2"
                    onClick={() => handleTest(s)} disabled={testing === s.id}>
                    {testing === s.id ? <Spinner size={12} /> : <Plug size={12} />}
                    <span className="ml-1">Test</span>
                  </button>
                  {testResult[s.id] && (
                    <span className={testResult[s.id].ok ? 'text-green-400 text-xs' : 'text-red-400 text-xs'}>
                      {testResult[s.id].ok ? '✓ OK' : '✗ Fail'}
                    </span>
                  )}
                </div>
              )},
              ...(canTerminal ? [{
                key: 'terminal', label: '', render: s => (
                  <button className="btn-ghost py-1 px-2 text-brand-400 hover:text-brand-300"
                    onClick={() => navigate(`/servers/${s.id}/terminal`)} title="Otvori terminal">
                    <TerminalSquare size={14} />
                  </button>
                )
              }] : []),
              ...(canManage ? [{
                key: 'actions', label: '', render: s => (
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost py-1 px-2 text-yellow-500 hover:text-yellow-400"
                      onClick={() => setRestartConfirm(s)} disabled={restarting === s.id} title="Restartuj server">
                      {restarting === s.id ? <Spinner size={14} /> : <RotateCw size={14} />}
                    </button>
                    <button className="btn-ghost py-1 px-2" onClick={() => openEdit(s)} title="Uredi">
                      <Edit size={14} />
                    </button>
                    <button className="btn-ghost py-1 px-2 text-red-500 hover:text-red-400"
                      onClick={() => setDelConfirm(s)} title="Obriši">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              }] : []),
            ]}
            rows={servers}
          />
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={modalTitle}>
        <ServerForm
          serverRef={editServerRef}
          tenantId={tenantId}
          onSave={handleSave}
          onClose={closeModal}
        />
      </Modal>

      <ProcessListModal
        server={procModalServer}
        tenantId={tenantId}
        onClose={() => setProcModalServer(null)}
      />

      <ConfirmDialog
        open={!!delConfirm}
        title="Obriši server"
        message={`Da li si siguran da hoćeš da obrišeš "${delConfirm?.name}"?`}
        danger
        onConfirm={() => handleDelete(delConfirm.id)}
        onCancel={() => setDelConfirm(null)}
      />

      <ConfirmDialog
        open={!!restartConfirm}
        title="Restartuj server"
        message={`Da li si siguran da hoćeš da restartuješ "${restartConfirm?.name}"? Ovo će prekinuti sve trenutne konekcije i procese na serveru, i server će biti nedostupan par minuta.`}
        danger
        onConfirm={() => handleRestart(restartConfirm)}
        onCancel={() => setRestartConfirm(null)}
      />
    </div>
  );
}
