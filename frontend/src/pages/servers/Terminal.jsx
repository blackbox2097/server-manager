// src/pages/servers/Terminal.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import 'xterm/css/xterm.css';
import useAuthStore from '../../store/authStore';
import api from '../../services/api';
import { Spinner } from '../../components/ui';

export default function TerminalPage() {
  const { serverId } = useParams();
  const navigate      = useNavigate();
  const { accessToken, activeTenant } = useAuthStore();

  const containerRef = useRef(null);
  const termRef       = useRef(null);
  const fitRef        = useRef(null);
  const wsRef          = useRef(null);

  const [serverName, setServerName] = useState('');
  const [status, setStatus]         = useState('connecting'); // connecting | connected | closed | error

  useEffect(() => {
    // Dohvati ime servera za prikaz u naslovu
    if (activeTenant) {
      api.get(`/tenants/${activeTenant.id}/servers`)
         .then(r => {
           const s = r.data.find(x => x.id === serverId);
           if (s) setServerName(s.name);
         })
         .catch(() => {});
    }
  }, [serverId, activeTenant]);

  const connect = () => {
    if (!containerRef.current || !activeTenant) return;
    setStatus('connecting');

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      theme: {
        background: '#0a0e14',
        foreground: '#e6e6e6',
        cursor: '#6366f1',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current  = fit;

    // Sacekaj da kontejner dobije stvarnu sirinu pre prvog fit()-a
    // (sprecava da terminal "zapamti" preveliku pocetnu sirinu)
    requestAnimationFrame(() => {
      fit.fit();
      wsRef.current?.readyState === WebSocket.OPEN &&
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/terminal/${activeTenant.id}/${serverId}?token=${accessToken}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => term.write(e.data);

    ws.onclose = (e) => {
      setStatus('closed');
      if (e.reason) term.write(`\r\n\x1b[33m[Konekcija zatvorena: ${e.reason}]\x1b[0m\r\n`);
    };
    ws.onerror = () => setStatus('error');

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // ResizeObserver umesto window 'resize' — hvata i promene layout-a
    // (npr. otvaranje sidebar-a), ne samo promenu velicine prozora
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  };

  useEffect(() => {
    const cleanup = connect();
    return () => {
      cleanup && cleanup();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, activeTenant]);

  const reconnect = () => {
    wsRef.current?.close();
    termRef.current?.dispose();
    setTimeout(connect, 100);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <button className="btn-ghost py-1.5 px-2 flex-shrink-0" onClick={() => navigate('/servers')}>
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-100 truncate">
              Terminal {serverName && `— ${serverName}`}
            </h1>
            <p className="text-xs text-gray-500 flex items-center gap-1.5">
              <span className={
                status === 'connected' ? 'w-2 h-2 rounded-full bg-green-500 flex-shrink-0' :
                status === 'connecting' ? 'w-2 h-2 rounded-full bg-yellow-500 animate-pulse flex-shrink-0' :
                'w-2 h-2 rounded-full bg-red-500 flex-shrink-0'
              } />
              {status === 'connected'  && 'Povezano'}
              {status === 'connecting' && 'Povezivanje...'}
              {status === 'closed'     && 'Konekcija zatvorena'}
              {status === 'error'      && 'Greška konekcije'}
            </p>
          </div>
        </div>
        {(status === 'closed' || status === 'error') && (
          <button className="btn-secondary flex-shrink-0" onClick={reconnect}>
            <RotateCcw size={14} /> Poveži ponovo
          </button>
        )}
      </div>

      <div className="flex-1 bg-[#0a0e14] rounded-lg border border-gray-800 p-2 overflow-hidden relative min-w-0 min-h-0">
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e14]/80 z-10">
            <Spinner size={24} className="text-brand-500" />
          </div>
        )}
        <div ref={containerRef} className="relative h-full w-full min-w-0 overflow-hidden" />
      </div>
    </div>
  );
}
