// src/services/ws.js
let socket      = null;
let reconnTimer = null;
let reconnDelay = 1000;
const listeners = {};

function on(event, cb) {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(cb);
  return () => listeners[event].delete(cb);
}

function emit(event, data) {
  (listeners[event] || new Set()).forEach(cb => { try { cb(data); } catch {} });
}

function connect(token) {
  if (socket?.readyState === WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

  socket.onopen = () => {
    emit('connected', {});
    reconnDelay = 1000;
    if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  };

  socket.onmessage = (e) => {
    try {
      const { event, data } = JSON.parse(e.data);
      emit(event, data);
    } catch {}
  };

  socket.onclose = (e) => {
    emit('disconnected', { code: e.code });
    if (e.code !== 1000) {
      reconnDelay = Math.min(30000, reconnDelay * 2);
      reconnTimer = setTimeout(() => connect(token), reconnDelay);
    }
  };

  socket.onerror = () => {};
}

function disconnect() {
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  reconnDelay = 1000;
  socket?.close(1000);
  socket = null;
}

function ping() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'ping' }));
  }
}

export default { connect, disconnect, on, ping };
