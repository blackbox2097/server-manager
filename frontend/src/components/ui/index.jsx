// src/components/ui/index.jsx
// Zajednički UI komponente

import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, AlertCircle, CheckCircle, Info, XCircle, AlertTriangle, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import clsx from 'clsx';

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner({ size = 16, className }) {
  return <Loader2 size={size} className={clsx('animate-spin', className)} />;
}

// ── Status badge za server ────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const map = {
    online:  { cls: 'badge-green',  label: 'Online'      },
    offline: { cls: 'badge-red',    label: 'Offline'     },
    warning: { cls: 'badge-yellow', label: 'Upozorenje'  },
    unknown: { cls: 'badge-gray',   label: 'Nepoznato'   },
  };
  const { cls, label } = map[status] || map.unknown;
  return (
    <span className={cls}>
      <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1" />
      {label}
    </span>
  );
}

// ── Meter bar (CPU/RAM/Disk) ──────────────────────────────────────────────────
export function MeterBar({ value, className }) {
  const color = value >= 90 ? 'bg-red-500'
              : value >= 75 ? 'bg-yellow-500'
              : 'bg-green-500';
  return (
    <div className={clsx('meter-bar', className)}>
      <div className={clsx('meter-fill', color)} style={{ width: `${Math.min(100, value || 0)}%` }} />
    </div>
  );
}

// ── Metric cell ───────────────────────────────────────────────────────────────
export function MetricCell({ value, label }) {
  if (value == null) return <span className="text-gray-600 text-xs">—</span>;
  return (
    <div className="min-w-[72px]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500">{label}</span>
        <span className="text-xs font-medium">{Math.round(value)}%</span>
      </div>
      <MeterBar value={value} />
    </div>
  );
}

// ── Disk meter — prikazuje root/sistemski disk kao glavni broj (ne najpunjeniji),
// sa upozorenjem ako je NEKI DRUGI drajv kritičan. Detalji po drajvu preko hover
// popup-a koji se renderuje u portalu (van tabele), da ga tabela ne bi sekla.
export function DiskCell({ value, disks }) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);

  if (value == null) return <span className="text-gray-600 text-xs">—</span>;

  const list = Array.isArray(disks) ? disks : [];
  const hasBreakdown = list.length > 1;

  // Primarni broj = root ("/") ili sistemski (C:) disk ako postoji u listi,
  // inace najpunjeniji (worst-case) — isto kao ranije
  const primary = list.find(d => d.name === '/' || d.name === 'C:');
  const displayValue = primary ? primary.percent : value;
  const displayName  = primary ? primary.name : null;

  // Da li NEKI DRUGI drajv (osim onog koji se prikazuje) ima kriticno stanje?
  const hiddenCritical = list.some(d => d !== primary && d.percent >= 90);

  const handleEnter = () => {
    if (!hasBreakdown) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left });
    setHover(true);
  };

  return (
    <div ref={triggerRef} className="min-w-[72px]" onMouseEnter={handleEnter} onMouseLeave={() => setHover(false)}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 flex items-center gap-1">
          Disk{displayName && <span className="text-gray-600 font-mono">({displayName})</span>}
          {hiddenCritical && <AlertTriangle size={11} className="text-red-500" title="Drugi disk je kritičan — pogledaj detalje" />}
        </span>
        <span className="text-xs font-medium">{Math.round(displayValue)}%</span>
      </div>
      <MeterBar value={displayValue} />

      {hasBreakdown && hover && createPortal(
        <div
          className="fixed z-[100] bg-gray-800 border border-gray-700 rounded-lg p-2 shadow-xl min-w-[160px]"
          style={{ top: pos.top, left: pos.left }}>
          {list
            .slice()
            .sort((a, b) => b.percent - a.percent)
            .map(d => (
              <div key={d.name} className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-xs text-gray-400 font-mono">{d.name}</span>
                <span className={`text-xs font-medium ${d.percent >= 90 ? 'text-red-400' : d.percent >= 75 ? 'text-yellow-400' : 'text-gray-300'}`}>
                  {Math.round(d.percent)}%
                </span>
              </div>
            ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Alert box ─────────────────────────────────────────────────────────────────
export function Alert({ type = 'info', message, onClose }) {
  const map = {
    info:    { Icon: Info,         cls: 'bg-blue-900/30 border-blue-800 text-blue-300'   },
    success: { Icon: CheckCircle,  cls: 'bg-green-900/30 border-green-800 text-green-300' },
    warning: { Icon: AlertCircle,  cls: 'bg-yellow-900/30 border-yellow-800 text-yellow-300' },
    error:   { Icon: XCircle,      cls: 'bg-red-900/30 border-red-800 text-red-300'      },
  };
  const { Icon, cls } = map[type];
  return (
    <div className={clsx('flex items-start gap-3 border rounded-lg p-3 text-sm', cls)}>
      <Icon size={16} className="flex-shrink-0 mt-0.5" />
      <span className="flex-1">{message}</span>
      {onClose && <button onClick={onClose} className="flex-shrink-0 opacity-60 hover:opacity-100">✕</button>}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="font-semibold text-gray-100">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="p-4 border-t border-gray-800 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
export function ConfirmDialog({ open, title, message, onConfirm, onCancel, danger }) {
  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onCancel}>Otkaži</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>Potvrdi</button>
      </>}>
      <p className="text-sm text-gray-300">{message}</p>
    </Modal>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
export function Empty({ icon: Icon, title, subtitle, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && <Icon size={40} className="text-gray-700 mb-3" />}
      <p className="text-sm font-medium text-gray-400">{title}</p>
      {subtitle && <p className="text-xs text-gray-600 mt-1">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────
export function Table({ columns, rows, onRowClick, defaultSort }) {
  const [sortKey, setSortKey] = useState(defaultSort?.key ?? null);
  const [sortDir, setSortDir] = useState(defaultSort?.dir ?? 'asc');

  const handleSort = (col) => {
    if (col.sortable === false) return;
    const key = col.sortKey || col.key;
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const getValue = (col, row) => col.sortValue ? col.sortValue(row) : row[col.sortKey || col.key];

  const sortedRows = (() => {
    if (!sortKey) return rows;
    const col = columns.find(c => (c.sortKey || c.key) === sortKey);
    if (!col) return rows;
    const sorted = [...rows].sort((a, b) => {
      const av = getValue(col, a);
      const bv = getValue(col, b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
    return sortDir === 'asc' ? sorted : sorted.reverse();
  })();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            {columns.map(col => {
              const key = col.sortKey || col.key;
              const isActive = sortKey === key;
              return (
                <th key={col.key}
                    onClick={() => handleSort(col)}
                    className={clsx('text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider',
                      col.sortable !== false && 'cursor-pointer select-none hover:text-gray-300 transition-colors')}>
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable !== false && (
                      isActive
                        ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                        : <ChevronsUpDown size={12} className="opacity-30" />
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr key={row.id || i}
                className={clsx('border-b border-gray-800/50 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-gray-800/50')}
                onClick={() => onRowClick?.(row)}>
              {columns.map(col => (
                <td key={col.key} className="py-2.5 px-3 text-gray-300">
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Uptime formater ───────────────────────────────────────────────────────────
export function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatNetSpeed(kbps) {
  if (kbps == null) return '—';
  if (kbps < 1) return '0 KB/s';
  if (kbps < 1024) return `${kbps.toFixed(1)} KB/s`;
  return `${(kbps / 1024).toFixed(1)} MB/s`;
}
