// src/App.jsx
import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import useAuthStore from './store/authStore';
import ws from './services/ws';
import Layout    from './components/layout/Layout';
import Login     from './pages/auth/Login';
import Dashboard from './pages/dashboard/Dashboard';
import Monitoring from './pages/dashboard/Monitoring';
import Servers   from './pages/servers/Servers';
import TerminalPage from './pages/servers/Terminal';
import SshKeys   from './pages/servers/SshKeys';
import Alerts    from './pages/servers/Alerts';
import Logs      from './pages/servers/Logs';
import Scripts   from './pages/scripts/Scripts';
import Schedules from './pages/scripts/Schedules';
import Execute   from './pages/scripts/Execute';
import Tenants   from './pages/admin/Tenants';
import Users     from './pages/admin/Users';
import SmtpSettings from './pages/admin/SmtpSettings';
import AdminLogs from './pages/admin/AdminLogs';
import Backup    from './pages/admin/Backup';
import Automation from './pages/automation/Automation';

function ProtectedRoute({ children, superadminOnly }) {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/login" replace />;
  if (superadminOnly && user.role !== 'superadmin') return <Navigate to="/dashboard" replace />;
  return children;
}

function Page({ component: C, superadminOnly }) {
  return (
    <ProtectedRoute superadminOnly={superadminOnly}>
      <Layout><C /></Layout>
    </ProtectedRoute>
  );
}

export default function App() {
  const { user, accessToken } = useAuthStore();

  useEffect(() => {
    if (accessToken && user) ws.connect(accessToken);
    return () => ws.disconnect();
  }, [accessToken]);

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/dashboard"     element={<Page component={Dashboard}  />} />
      <Route path="/monitoring"    element={<Page component={Monitoring} />} />
      <Route path="/servers"       element={<Page component={Servers}    />} />
      <Route path="/servers/:serverId/terminal" element={<Page component={TerminalPage} />} />
      <Route path="/ssh-keys"      element={<Page component={SshKeys}    />} />
      <Route path="/alerts"        element={<Page component={Alerts}     />} />
      <Route path="/logs"          element={<Page component={Logs}       />} />
      <Route path="/scripts"       element={<Page component={Scripts}    />} />
      <Route path="/schedules"     element={<Page component={Schedules}  />} />
      <Route path="/execute"       element={<Page component={Execute}    />} />
      <Route path="/admin/tenants" element={<Page component={Tenants}    superadminOnly />} />
      <Route path="/admin/users"   element={<Page component={Users}      superadminOnly />} />
      <Route path="/admin/smtp"    element={<Page component={SmtpSettings} superadminOnly />} />
      <Route path="/admin/logs"    element={<Page component={AdminLogs}  superadminOnly />} />
      <Route path="/admin/backup"  element={<Page component={Backup}     superadminOnly />} />
      <Route path="/automation"    element={<Page component={Automation} />} />
      <Route path="*"              element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
