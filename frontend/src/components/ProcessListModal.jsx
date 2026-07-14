// src/components/ProcessListModal.jsx
import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { Modal, Alert, Spinner } from './ui';

export default function ProcessListModal({ server, tenantId, onClose }) {
  const [procList,    setProcList]    = useState([]);
  const [osType,      setOsType]      = useState('linux');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');

  useEffect(() => {
    if (!server || !tenantId) return;
    let cancelled = false;

    setLoading(true);
    setError('');
    setProcList([]);

    api.get(`/tenants/${tenantId}/servers/${server.id}/processes`)
       .then(({ data }) => {
         if (cancelled) return;
         setProcList(data.processes || []);
         setOsType(data.osType || 'linux');
       })
       .catch(err => {
         if (cancelled) return;
         setError(err.response?.data?.detail || 'Greška pri dohvatanju procesa');
       })
       .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [server?.id, tenantId]);

  return (
    <Modal
      open={!!server}
      onClose={onClose}
      title={`Procesi — ${server?.name || ''}`}>
      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size={24} className="text-brand-500" />
        </div>
      )}
      {!loading && error && <Alert type="error" message={error} />}
      {!loading && !error && (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1.5 pr-2">PID</th>
                <th className="text-left py-1.5 pr-2">Naziv</th>
                <th className="text-right py-1.5 pr-2">
                  {osType === 'windows' ? 'CPU vreme (s)' : 'CPU %'}
                </th>
                <th className="text-right py-1.5">
                  {osType === 'windows' ? 'RAM (MB)' : 'RAM %'}
                </th>
              </tr>
            </thead>
            <tbody>
              {procList.map(p => (
                <tr key={p.pid} className="border-b border-gray-800/50 text-gray-300">
                  <td className="py-1.5 pr-2 text-gray-500">{p.pid}</td>
                  <td className="py-1.5 pr-2 truncate max-w-[180px]">{p.name}</td>
                  <td className="py-1.5 pr-2 text-right">{p.cpu?.toFixed(1)}</td>
                  <td className="py-1.5 text-right">{p.mem?.toFixed(1)}</td>
                </tr>
              ))}
              {procList.length === 0 && (
                <tr><td colSpan={4} className="text-center text-gray-600 py-4">Nema podataka</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
