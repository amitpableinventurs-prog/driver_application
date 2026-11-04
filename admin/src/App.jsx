import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  BadgePercent, Banknote, CarFront, ChartColumn, FileText, Gauge, History, IdCard, LifeBuoy, LogOut, Map as MapIcon, MapPin, Megaphone, Menu,
  ReceiptIndianRupee, Settings as SettingsIcon, ShieldAlert, Star, Tags, UserCog, Users, Image as ImageIcon,
} from 'lucide-react';
import { ErrorBox, Field, Spinner, useAction, useFetch, useToast } from '@shared/ui.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from './client.js';
import Dashboard from './pages/Dashboard.jsx';
import { BookingDetail, Bookings } from './pages/Bookings.jsx';
import { DriverDetail, Drivers } from './pages/Drivers.jsx';
import { CustomerDetail, Customers } from './pages/Customers.jsx';
import LiveMap from './pages/LiveMap.jsx';
import { Payouts, Reports, Transactions } from './pages/Finance.jsx';
import { Reviews, Sos, TicketDetail, Tickets } from './pages/Support.jsx';
import { Banners, Broadcasts, Cities, Coupons, Pages, Pricing } from './pages/Catalog.jsx';
import { AdminUsers, AuditLogs, Settings } from './pages/System.jsx';

const NAV = [
  { group: 'Operations', items: [
    { to: '/', label: 'Dashboard', icon: Gauge, perm: 'dashboard', end: true },
    { to: '/bookings', label: 'Bookings', icon: CarFront, perm: 'bookings' },
    { to: '/live', label: 'Live map', icon: MapIcon, perm: 'drivers' },
    { to: '/drivers', label: 'Drivers', icon: IdCard, perm: 'drivers', count: 'pendingKyc' },
    { to: '/customers', label: 'Customers', icon: Users, perm: 'customers' },
  ] },
  { group: 'Support', items: [
    { to: '/sos', label: 'SOS alerts', icon: ShieldAlert, perm: 'support', count: 'openSos' },
    { to: '/tickets', label: 'Tickets', icon: LifeBuoy, perm: 'support', count: 'openTickets' },
    { to: '/reviews', label: 'Reviews', icon: Star, perm: 'bookings' },
  ] },
  { group: 'Finance', items: [
    { to: '/payouts', label: 'Payouts', icon: Banknote, perm: 'finance', count: 'pendingPayouts' },
    { to: '/transactions', label: 'Transactions', icon: ReceiptIndianRupee, perm: 'finance' },
    { to: '/reports', label: 'Revenue report', icon: ChartColumn, perm: 'finance' },
  ] },
  { group: 'Catalog', items: [
    { to: '/cities', label: 'Cities', icon: MapPin, perm: 'pricing' },
    { to: '/pricing', label: 'Pricing', icon: Tags, perm: 'pricing' },
    { to: '/coupons', label: 'Coupons', icon: BadgePercent, perm: 'coupons' },
  ] },
  { group: 'Content', items: [
    { to: '/banners', label: 'Banners', icon: ImageIcon, perm: 'content' },
    { to: '/pages', label: 'Pages', icon: FileText, perm: 'content' },
    { to: '/broadcasts', label: 'Broadcasts', icon: Megaphone, perm: 'content' },
  ] },
  { group: 'System', items: [
    { to: '/settings', label: 'Settings', icon: SettingsIcon, perm: 'settings' },
    { to: '/admins', label: 'Team', icon: UserCog, perm: 'admins' },
    { to: '/audit', label: 'Audit log', icon: History, perm: 'audit' },
  ] },
];

const ROUTES = [
  ['/', Dashboard, 'dashboard'], ['/bookings', Bookings, 'bookings'], ['/bookings/:id', BookingDetail, 'bookings'],
  ['/live', LiveMap, 'drivers'], ['/drivers', Drivers, 'drivers'], ['/drivers/:id', DriverDetail, 'drivers'],
  ['/customers', Customers, 'customers'], ['/customers/:id', CustomerDetail, 'customers'],
  ['/sos', Sos, 'support'], ['/tickets', Tickets, 'support'], ['/tickets/:id', TicketDetail, 'support'], ['/reviews', Reviews, 'bookings'],
  ['/payouts', Payouts, 'finance'], ['/transactions', Transactions, 'finance'], ['/reports', Reports, 'finance'],
  ['/cities', Cities, 'pricing'], ['/pricing', Pricing, 'pricing'], ['/coupons', Coupons, 'coupons'],
  ['/banners', Banners, 'content'], ['/pages', Pages, 'content'], ['/broadcasts', Broadcasts, 'content'],
  ['/settings', Settings, 'settings'], ['/admins', AdminUsers, 'admins'], ['/audit', AuditLogs, 'audit'],
];

const Brand = () => <span className="brand-mark"><CarFront size={22} /> Driver IN</span>;

function Login() {
  const [form, setForm] = useState({ email: '', password: '' });
  const [run, busy] = useAction();
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      const { accessToken, refreshToken, user } = await api.post('/auth/admin/login', form);
      api.setSession({ accessToken, refreshToken, user });
    });
  };
  return (
    <div className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <div><Brand /><p className="muted">Admin panel</p></div>
        <Field label="Email"><input type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <button className="btn btn-primary btn-block btn-lg" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Shell({ me }) {
  const location = useLocation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const counts = useFetch(() => (me.permissions.includes('dashboard') ? api.get('/admin/dashboard') : Promise.resolve(null)), []);
  const can = (permission) => me.permissions.includes(permission);

  useEffect(() => setOpen(false), [location.pathname]);
  useRealtime(api, {
    'sos:new': (alert) => { toast(`SOS on ${alert.bookingNo}`, 'bad'); counts.reload({ quiet: true }); },
    'ticket:new': () => counts.reload({ quiet: true }),
    'kyc:submitted': () => counts.reload({ quiet: true }),
    'payout:requested': () => counts.reload({ quiet: true }),
  });

  const live = counts.data?.counts || {};
  const home = can('dashboard') ? '/' : ROUTES.find(([, , perm]) => can(perm))?.[0];

  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <Link to={home} style={{ padding: 0 }}><Brand /></Link>
        <nav aria-label="Main">
          {NAV.map(({ group, items }) => {
            const visible = items.filter((item) => can(item.perm));
            if (!visible.length) return null;
            return (
              <div key={group}>
                <div className="side-group">{group}</div>
                {visible.map(({ to, label, icon: Icon, end, count }) => (
                  <NavLink key={to} to={to} end={end}>
                    <Icon size={17} aria-hidden /> {label}
                    {count && live[count] > 0 && <span className="count">{live[count]}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <strong>{me.name}</strong>
          <div>{me.roleLabel}</div>
          <button onClick={() => api.logout()}><LogOut size={14} aria-hidden /> Sign out</button>
        </div>
      </aside>
      <div>
        <div className="topbar">
          <button className="btn btn-icon" onClick={() => setOpen(!open)} aria-label="Menu"><Menu size={20} /></button>
          <Brand />
        </div>
        <main className="main">
          {live.openSos > 0 && location.pathname !== '/sos' && can('support') && (
            <div className="alert-strip" role="alert"><ShieldAlert size={18} aria-hidden /> {live.openSos} open SOS alert{live.openSos > 1 ? 's' : ''} <Link to="/sos">Review now</Link></div>
          )}
          <Routes>
            {ROUTES.filter(([, , perm]) => can(perm)).map(([path, Page]) => <Route key={path} path={path} element={<Page me={me} />} />)}
            <Route path="*" element={<Navigate to={home || '/'} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Authenticated() {
  const me = useFetch(() => api.get('/admin/me'), []);
  if (me.loading) return <Spinner />;
  if (me.error) return <ErrorBox error={me.error} onRetry={me.reload} />;
  return <Shell me={me.data} />;
}

export default function App() {
  const session = useSyncExternalStore(api.subscribe, () => api.session);
  return session ? <Authenticated /> : <Login />;
}
