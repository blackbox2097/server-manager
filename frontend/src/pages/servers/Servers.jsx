// src/pages/servers/Servers.jsx
import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Edit, Trash2, Plug, Server, TerminalSquare, ArrowDown, ArrowUp, Cpu, RotateCw, ExternalLink, Search, Download } from 'lucide-react';
import api from '../../services/api';
import ws from '../../services/ws';
import useAuthStore from '../../store/authStore';
import {
  StatusBadge, Badge, MetricCell, DiskCell, Modal, ConfirmDialog,
  Alert, Spinner, Empty, Table, formatUptime, formatNetSpeed, exportToXlsx
} from '../../components/ui';
import { getServerColumns } from '../../utils/serverColumns';

const VIRT_LABELS = {
  none: 'Fizička',
  kvm: 'ProxMox VM',
  vmware: 'ESXi VM',
  microsoft: 'HyperV VM',
  oracle: 'VirtualBox VM',
  xen: 'Xen VM',
  unknown: 'Nepoznato',
};

const VIRT_COLORS = {
  kvm: 'purple',
  vmware: 'orange',
  microsoft: 'blue',
  oracle: 'gray',
  xen: 'gray',
  unknown: 'gray',
};
import ProcessListModal from '../../components/ProcessListModal';

// ── ServerForm je na nivou modula — nikad se ne re-kreira
// F mora biti VAN ServerForm — inače se re-kreira na svakom render-u
// i React unmountuje/mountuje svaki input unutar njega
function F({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

const ServerForm = memo(function ServerForm({ serverRef, tenantId, onSave, onClose, existingServers = [] }) {
  const server = serverRef.current;
  const isEdit = !!server?.id;

  const [form, setForm] = useState(() => ({
    name: '', description: '', hostname: '', ipAddress: '',
    osType: 'linux', osName: '', environment: 'production', tags: '',
    sshPort: 22, sshUser: 'root', sshAuthType: 'key', sshKeyId: '', sshPassword: '',
    sudoPassword: '',
    winrmPort: 5985, winrmHttps: false, winrmAuthType: 'local',
    winrmUser: 'Administrator', winrmPassword: '',
    connectionMethod: 'auto',
    hvApiHost: '', hvApiPort: 8006, hvAuthId: '', hvSecret: '', hvVerifyTls: true,
    pollIntervalSec: '',
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
      connectionMethod: server.connection_method || 'auto',
      hvApiHost: server.hv_api_host || '',
      hvApiPort: server.hv_api_port || 8006,
      hvAuthId:  server.hv_auth_id  || '',
      hvVerifyTls: server.hv_verify_tls ?? true,
      pollIntervalSec: server.poll_interval_sec ?? '',
    } : {}),
  }));

  const [sshKeys, setSshKeys] = useState([]);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [genKeyLoading, setGenKeyLoading] = useState(false);
  const [genKeyMsg,     setGenKeyMsg]     = useState(null); // { ok: bool, text: string }

  const loadSshKeys = () => {
    api.get(`/tenants/${tenantId}/ssh-keys`)
       .then(r => setSshKeys(r.data))
       .catch(() => {});
  };

  useEffect(() => { loadSshKeys(); }, [tenantId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleGenerateKey = async () => {
    setGenKeyLoading(true); setGenKeyMsg(null);
    try {
      const { data } = await api.post(`/tenants/${tenantId}/servers/${server.id}/generate-ssh-key`);
      loadSshKeys();
      set('sshAuthType', 'key');
      set('sshKeyId', data.sshKeyId);
      set('sshPassword', '');
      setGenKeyMsg({ ok: true, text: 'Ključ generisan, instaliran i verifikovan — server je prebačen na SSH ključ, lozinka je obrisana.' });
    } catch (err) {
      setGenKeyMsg({ ok: false, text: err.response?.data?.detail || 'Generisanje ključa nije uspelo — server ostaje na lozinci.' });
    } finally {
      setGenKeyLoading(false);
    }
  };

  // Meko upozorenje (ne blokira cuvanje) — vec postoji server sa istom IP adresom
  const ipDuplicateServer = form.ipAddress
    ? existingServers.find(s => s.ip_address === form.ipAddress && s.id !== server?.id)
    : null;

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
        hvSecret:      form.hvSecret      || undefined,
        pollIntervalSec: form.pollIntervalSec ? parseInt(form.pollIntervalSec, 10) : null,
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
          {ipDuplicateServer && (
            <p className="text-xs text-yellow-500 mt-1">
              ⚠ IP adresa već postoji na serveru "{ipDuplicateServer.name}" — dozvoljeno, ali proveri da nije greška.
            </p>
          )}
        </F>
        <F label="Hostname">
          <input className="input" value={form.hostname}
            onChange={e => set('hostname', e.target.value)}
            placeholder="web1.domena.local" />
        </F>
        <F label="OS tip">
          <select className="input" value={form.osType}
            onChange={e => {
              const newType = e.target.value;
              setForm(f => {
                let hvApiPort = f.hvApiPort;
                if (newType === 'esxi' && f.hvApiPort === 8006) hvApiPort = 443;
                if (newType === 'proxmox' && f.hvApiPort === 443) hvApiPort = 8006;
                return { ...f, osType: newType, hvApiPort: hvApiPort };
              });
            }}>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
            <option value="proxmox">Proxmox (hipervizor)</option>
            <option value="hyperv">Hyper-V (hipervizor)</option>
            <option value="esxi">ESXi (hipervizor)</option>
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
        <F label="Interval osvežavanja (s)">
          <input type="number" min="10" className="input" value={form.pollIntervalSec}
            onChange={e => set('pollIntervalSec', e.target.value)}
            placeholder="podrazumevano (30s)" />
        </F>
        <F label="Opis">
          <input className="input" value={form.description}
            onChange={e => set('description', e.target.value)} />
        </F>
      </div>

      {(form.osType === 'proxmox' || form.osType === 'esxi') && (
        <div className="border border-gray-800 rounded-lg p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            {form.osType === 'proxmox' ? 'Proxmox API pristup' : 'ESXi API pristup'}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <F label="API host">
              <input className="input" value={form.hvApiHost}
                onChange={e => set('hvApiHost', e.target.value)}
                placeholder="10.0.0.5" />
            </F>
            <F label="Port">
              <input className="input" type="number" value={form.hvApiPort}
                onChange={e => set('hvApiPort', parseInt(e.target.value) || (form.osType === 'proxmox' ? 8006 : 443))} />
            </F>
          </div>
          <F label={form.osType === 'proxmox' ? 'Token ID' : 'Korisnik'}>
            <input className="input" value={form.hvAuthId}
              onChange={e => set('hvAuthId', e.target.value)}
              placeholder={form.osType === 'proxmox' ? 'root@pam!servermanager' : 'root'} />
          </F>
          <F label={form.osType === 'proxmox' ? 'Token secret' : 'Lozinka'}>
            <input className="input" type="password" value={form.hvSecret}
              onChange={e => set('hvSecret', e.target.value)}
              placeholder={isEdit ? '(ostavi prazno da zadržiš stari)' : ''} />
          </F>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={form.hvVerifyTls}
              onChange={e => set('hvVerifyTls', e.target.checked)} />
            Verifikuj TLS sertifikat
          </label>
        </div>
      )}
      {(form.osType === 'linux' || form.osType === 'windows' || form.osType === 'hyperv') && (
        <div className="border border-gray-800 rounded-lg p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            SSH konfiguracija{(form.osType === 'windows' || form.osType === 'hyperv') ? ' (zahteva OpenSSH Server na Windows mašini)' : ''}
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
          {isEdit && form.osType === 'linux' &&
           (form.sshAuthType === 'password' || form.sshAuthType === 'key_and_password') && (
            <div className="pt-1">
              <button type="button" className="btn btn-secondary text-sm"
                onClick={handleGenerateKey} disabled={genKeyLoading}>
                {genKeyLoading
                  ? <><Spinner size={14} /> Generišem i testiram ključ…</>
                  : 'Generiši SSH ključ automatski i pređi sa lozinke'}
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Generiše novi ključ, instalira ga na server i PROVERI da radi — tek onda briše lozinku.
                Ako provera ne uspe, server ostaje netaknut na lozinci.
              </p>
              {genKeyMsg && (
                <p className={`text-xs mt-1 ${genKeyMsg.ok ? 'text-green-500' : 'text-red-500'}`}>
                  {genKeyMsg.text}
                </p>
              )}
            </div>
          )}
          <F label="Sudo lozinka (opciono — za pokretanje skripti sa root pravima)">
            <input className="input" type="password" value={form.sudoPassword}
              onChange={e => set('sudoPassword', e.target.value)}
              placeholder={isEdit && server?.has_sudo_password ? '(postavljena — ostavi prazno da zadržiš)' : '(prazno = bez sudo-a)'} />
          </F>
        </div>
      )}

      {form.osType === 'windows' && (
        <div className="space-y-3">
          <div className="border border-gray-800 rounded-lg p-3 space-y-3">
            <F label="Metod konekcije">
              <select className="input" value={form.connectionMethod}
                onChange={e => set('connectionMethod', e.target.value)}>
                <option value="auto">Auto (preporuceno) - SSH, WinRM kao rezerva</option>
                <option value="ssh">Samo SSH</option>
                <option value="winrm">Samo WinRM</option>
              </select>
            </F>
          </div>
          <div className="border border-gray-800 rounded-lg p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">WinRM konfiguracija</p>
          <p className="text-xs text-gray-600">
            SSH je primarni metod konekcije. WinRM polja ispod su opciona -- koriste se samo kao
            rezerva ako SSH konekcija ne uspe. Nije neophodno popuniti ih ako ste sigurni da je
            OpenSSH server dostupan na ovom serveru.
          </p>
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
                placeholder={form.winrmAuthType === 'domain' ? 'DOMEN\\korisnik' : 'Administrator'} />
              {form.winrmAuthType === 'domain' && (
                <p className="text-xs text-gray-600 mt-1">Format: DOMEN\korisnik (NTLM autentifikacija)</p>
              )}
            </F>
            <F label="Lozinka">
              <input className="input" type="password" value={form.winrmPassword}
                onChange={e => set('winrmPassword', e.target.value)}
                placeholder={isEdit ? '(ostavi prazno da zadržiš staru)' : ''} />
            </F>
          </div>
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
  const [searchParams, setSearchParams] = useSearchParams();

  const [servers,    setServers]    = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
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
  useEffect(() => {
    const unsub = ws.on('metrics', (data) => {
      setServers(prev => prev.map(s => s.id !== data.serverId ? s : {
        ...s, status: data.status, last_error: data.error || null,
        cpu_percent: data.metrics?.cpu ?? s.cpu_percent,
        ram_percent: data.metrics?.ram ?? s.ram_percent,
        disk_percent: data.metrics?.disk ?? s.disk_percent,
        disks: data.metrics?.disks ?? s.disks,
        uptime_seconds: data.metrics?.uptime ?? s.uptime_seconds,
      }));
    });
    return unsub;
  }, []);

  // Prefil "Dodaj server" forme kad se stigne sa VM liste ("Dodaj kao server" dugme)
  useEffect(() => {
    const addName = searchParams.get('addName');
    if (!addName || !canManage) return;
    const addOs = searchParams.get('addOs') || '';
    openAddPrefilled({
      name: addName,
      ip_address: searchParams.get('addIp') || '',
      os_type: /win/i.test(addOs) ? 'windows' : 'linux',
    });
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, canManage]);

  const openAdd = useCallback(() => {
    editServerRef.current = null;
    setModalTitle('Dodaj server');
    setModalOpen(true);
  }, []);

  const openAddPrefilled = useCallback((prefill) => {
    editServerRef.current = prefill;
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

  const hypervisors    = servers.filter(s => ['proxmox', 'hyperv', 'esxi'].includes(s.os_type));
  const regularServers = servers.filter(s => !['proxmox', 'hyperv', 'esxi'].includes(s.os_type));

  const q = searchQuery.trim().toLowerCase();
  const statusFilter = searchParams.get('status') || '';
  const matchesSearch = (s) => !q || [s.name, s.ip_address, s.hostname, s.description, ...(s.tags || [])]
    .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
  const matchesStatus = (s) => !statusFilter || s.status === statusFilter;
  const filteredHypervisors    = hypervisors.filter(s => matchesSearch(s) && matchesStatus(s));
  const filteredRegularServers = regularServers.filter(s => matchesSearch(s) && matchesStatus(s));

  const handleExport = async () => {
    const cols = [
      { label: 'Naziv', get: s => s.name },
      { label: 'IP adresa', get: s => s.ip_address },
      { label: 'Tip OS', get: s => s.os_type },
      { label: 'Status', get: s => s.status },
      { label: 'Okruženje', get: s => s.environment },
      { label: 'Tagovi', get: s => (s.tags || []).join('; ') },
      { label: 'Opis', get: s => s.description },
    ];
    await exportToXlsx(`serveri-${activeTenant?.name || 'export'}`, cols, [...filteredHypervisors, ...filteredRegularServers], 'Serveri');
  };

  const columns = getServerColumns({
    navigate, openProcesses, handleTest, testing, testResult, restarting,
    openEdit, setDelConfirm, setRestartConfirm, canTerminal, canManage,
  });

  const hypervisorColumns = columns.filter(c => c.key !== 'procs');
  const regularColumns = columns.filter(c => c.key !== 'vms');

  if (!tenantId) return <div className="text-gray-500 text-sm p-4">Odaberi tenant.</div>;
  if (loading)   return <div className="flex justify-center py-12"><Spinner size={28} className="text-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between sticky top-0 z-10 bg-gray-950 py-2 border-b border-gray-800/50">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Serveri</h1>
          <p className="text-sm text-gray-500">
            {(q || statusFilter) ? `${filteredHypervisors.length + filteredRegularServers.length} od ${servers.length}` : `${servers.length}`} servera u {activeTenant?.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-sm w-32 flex-shrink-0" value={statusFilter} onChange={e => setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            if (e.target.value) next.set('status', e.target.value); else next.delete('status');
            return next;
          })}>
            <option value="">Svi statusi</option>
            <option value="online">Online</option>
            <option value="warning">Upozorenje</option>
            <option value="offline">Offline</option>
          </select>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input className="input pl-8 py-1.5 text-sm w-48" placeholder="Pretraga..."
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {servers.length > 0 && (
            <button className="btn-secondary flex-shrink-0" onClick={handleExport} title="Izvezi u CSV">
              <Download size={16} />
            </button>
          )}
          {canManage && (
            <button className="btn-primary flex-shrink-0 whitespace-nowrap" onClick={openAdd}>
              <Plus size={16} /> Dodaj server
            </button>
          )}
        </div>
      </div>

      {servers.length === 0 ? (
        <Empty icon={Server} title="Nema servera"
          subtitle="Dodaj prvi server u ovaj tenant"
          action={canManage && (
            <button className="btn-primary" onClick={openAdd}>
              <Plus size={14} /> Dodaj server
            </button>
          )} />
      ) : (filteredHypervisors.length === 0 && filteredRegularServers.length === 0) ? (
        <Empty icon={Search} title="Nema rezultata" subtitle={q ? `Ništa ne odgovara pretrazi "${searchQuery}"` : 'Nijedan server ne odgovara izabranom filteru'} />
      ) : (
        <div className="space-y-4">
          {filteredHypervisors.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Hipervizori</p>
              <div className="card p-0 overflow-hidden">
                <Table columns={hypervisorColumns} rows={filteredHypervisors} />
              </div>
            </div>
          )}
          {filteredRegularServers.length > 0 && (
            <div>
              {filteredHypervisors.length > 0 && (
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Serveri</p>
              )}
              <div className="card p-0 overflow-hidden">
                <Table columns={regularColumns} rows={filteredRegularServers} />
              </div>
            </div>
          )}
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={modalTitle}>
        <ServerForm
          serverRef={editServerRef}
          tenantId={tenantId}
          onSave={handleSave}
          onClose={closeModal}
          existingServers={servers}
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
