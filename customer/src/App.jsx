import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Bell, CarFront, CircleUserRound, LifeBuoy, ListChecks, Wallet as WalletIcon } from 'lucide-react';
import { ErrorBox, Field, Spinner, useAction, useFetch, useToast } from '@shared/ui.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from './client.js';
import { AccountContext } from './account.js';
import Book from './pages/Book.jsx';
import { TripDetail, Trips } from './pages/Trips.jsx';
import Wallet from './pages/Wallet.jsx';
import Garage from './pages/Garage.jsx';
import { Account, CmsPage, Notifications } from './pages/Account.jsx';
import { Support, TicketThread } from './pages/Support.jsx';

const NAV = [
  { to: '/', label: 'Book', icon: CarFront, end: true },
  { to: '/trips', label: 'My trips', icon: ListChecks },
  { to: '/wallet', label: 'Wallet', icon: WalletIcon },
  { to: '/support', label: 'Help', icon: LifeBuoy },
  { to: '/account', label: 'Account', icon: CircleUserRound },
];

const Brand = () => <span className="brand-mark"><CarFront size={22} /> Driver IN</span>;

function Login() {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [run, busy] = useAction();

  const send = async (event) => {
    event.preventDefault();
    const result = await run(() => api.post('/auth/otp/send', { phone, role: 'customer' }));
    if (result) { setDevOtp(result.devOtp || ''); setStep('otp'); }
  };
  const verify = (event) => {
    event.preventDefault();
    run(async () => {
      const body = { phone, role: 'customer', otp };
      if (referralCode.trim()) body.referralCode = referralCode.trim();
      const { accessToken, refreshToken } = await api.post('/auth/otp/verify', body);
      api.setSession({ accessToken, refreshToken });
    });
  };

  return (
    <div className="auth-page">
      <div className="card auth-card stack">
        <div><Brand /><p className="muted">A verified driver for your own car</p></div>
        {step === 'phone' ? (
          <form className="stack" onSubmit={send}>
            <Field label="Mobile number">
              <input inputMode="numeric" autoComplete="tel-national" maxLength={10} pattern="[6-9][0-9]{9}" title="10 digit mobile number" required value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>Send OTP</button>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p>Enter the 6 digit OTP sent to <strong>{phone}</strong></p>
            {devOtp && <p className="dev-hint">Development mode, OTP: <strong>{devOtp}</strong></p>}
            <Field label="OTP">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Referral code (new customers)"><input value={referralCode} onChange={(e) => setReferralCode(e.target.value)} /></Field>
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>Verify and continue</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setStep('phone'); setOtp(''); }}>Change number</button>
          </form>
        )}
      </div>
    </div>
  );
}

function NameGate({ onDone }) {
  const [name, setName] = useState('');
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    if (await run(() => api.patch('/customer/me', { name }))) onDone();
  };
  return (
    <div className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>What should we call you?</h1>
        <p className="muted">Your driver sees this name.</p>
        <Field label="Full name"><input required minLength={2} maxLength={80} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn btn-primary btn-block btn-lg" disabled={busy}>Continue</button>
      </form>
    </div>
  );
}

function Shell() {
  const toast = useToast();
  const me = useFetch(() => api.get('/customer/me'), []);
  const [unread, setUnread] = useState(0);
  const refreshUnread = useCallback(() => {
    api.get('/customer/notifications', { limit: 1 }).then((data) => setUnread(data.unread)).catch(() => {});
  }, []);

  useEffect(() => { refreshUnread(); }, [refreshUnread]);
  useRealtime(api, {
    notification: (item) => { toast(item.title); refreshUnread(); me.reload({ quiet: true }); },
  });

  const account = useMemo(() => ({ me: me.data, reloadMe: () => me.reload({ quiet: true }), refreshUnread }), [me.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me.loading && !me.data) return <Spinner />;
  if (me.error && !me.data) return <ErrorBox error={me.error} onRetry={me.reload} />;
  if (!me.data.name) return <NameGate onDone={() => me.reload()} />;

  return (
    <AccountContext.Provider value={account}>
      <header className="app-head">
        <div className="app-head-inner">
          <Link to="/"><Brand /></Link>
          <nav className="app-nav" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}><Icon size={16} aria-hidden /> {label}</NavLink>)}
          </nav>
          <Link className="bell" to="/notifications" aria-label={`Notifications, ${unread} unread`}>
            <Bell size={20} aria-hidden />{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}
          </Link>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Book />} />
        <Route path="/trips" element={<Trips />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/garage" element={<Garage />} />
        <Route path="/support" element={<Support />} />
        <Route path="/support/:id" element={<TicketThread />} />
        <Route path="/account" element={<Account />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/pages/:slug" element={<CmsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <nav className="bottom-nav" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}><Icon size={20} aria-hidden /> {label}</NavLink>)}
      </nav>
    </AccountContext.Provider>
  );
}

export default function App() {
  const session = useSyncExternalStore(api.subscribe, () => api.session);
  return session ? <Shell /> : <Login />;
}
