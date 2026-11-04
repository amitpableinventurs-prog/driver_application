import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Copy } from 'lucide-react';
import { Empty, ErrorBox, Field, Modal, Pager, Spinner, dateTime, rupees, useAction, useFetch, useToast } from '@shared/ui.jsx';
import { assetUrl } from '@shared/api.js';
import { api } from '../client.js';
import { useAccount } from '../account.js';

export function Account() {
  const toast = useToast();
  const { me, reloadMe } = useAccount();
  const referral = useFetch(() => api.get('/customer/referral'), []);
  const [form, setForm] = useState({ name: me.name, email: me.email || '' });
  const [confirming, setConfirming] = useState(false);
  const [run, busy] = useAction();

  const save = async (event) => {
    event.preventDefault();
    const body = { name: form.name };
    if (form.email) body.email = form.email;
    if (await run(() => api.patch('/customer/me', body), 'Profile saved')) reloadMe();
  };
  const upload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const data = new FormData();
    data.append('file', file);
    if (await run(() => api.upload('/customer/me/avatar', data), 'Photo updated')) reloadMe();
  };
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(me.referralCode); toast('Code copied'); } catch { toast('Copy failed', 'bad'); }
  };
  const remove = () => run(async () => { await api.del('/customer/me'); api.setSession(null); });

  const links = [['/garage', 'Cars and addresses'], ['/pages/faq', 'FAQ'], ['/pages/about', 'About Driver IN'], ['/pages/terms', 'Terms and conditions'], ['/pages/privacy', 'Privacy policy']];

  return (
    <main className="page page-narrow">
      <div className="page-title"><h1>Account</h1></div>
      <div className="stack">
        <form className="card stack" onSubmit={save}>
          <div className="row">
            {me.avatar ? <img className="avatar" src={assetUrl(me.avatar)} alt="" /> : <span className="avatar">{me.name[0]}</span>}
            <div>
              <strong>{me.phone}</strong>
              <label className="small" style={{ display: 'block', color: 'var(--brand-ink)', cursor: 'pointer' }}>
                Change photo
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={upload} />
              </label>
            </div>
          </div>
          <Field label="Name"><input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <div className="row-end"><button className="btn btn-primary" disabled={busy}>Save</button></div>
        </form>

        {referral.data && (
          <section className="card stack">
            <h2>Refer a friend</h2>
            <p className="muted small">You get {rupees(referral.data.youEarn)} and your friend gets {rupees(referral.data.friendEarns)} after their first trip.</p>
            <div className="code-box"><span>{referral.data.code}</span><button type="button" className="btn btn-icon" onClick={copyCode} aria-label="Copy code"><Copy size={16} /></button></div>
          </section>
        )}

        <section className="card card-flush">
          {links.map(([to, label]) => (
            <Link key={to} to={to} className="trip-row"><span>{label}</span><ChevronRight size={18} aria-hidden /></Link>
          ))}
        </section>

        <div className="row-between">
          <button className="btn" onClick={() => api.logout()}>Sign out</button>
          <button className="btn btn-ghost" style={{ color: 'var(--bad)' }} onClick={() => setConfirming(true)}>Delete my account</button>
        </div>
      </div>
      {confirming && (
        <Modal title="Delete your account?" onClose={() => setConfirming(false)}>
          <div className="stack">
            <p>Your profile is removed and any wallet balance is lost. This cannot be undone.</p>
            <div className="row-end">
              <button className="btn" onClick={() => setConfirming(false)}>Keep my account</button>
              <button className="btn btn-danger" disabled={busy} onClick={remove}>Delete account</button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

export function Notifications() {
  const { refreshUnread } = useAccount();
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch(() => api.get('/customer/notifications', { page }), [page]);

  useEffect(() => {
    if (!data?.unread) return;
    api.post('/customer/notifications/read').then(refreshUnread).catch(() => {});
  }, [data, refreshUnread]);

  return (
    <main className="page page-narrow">
      <div className="page-title"><h1>Notifications</h1></div>
      <section className="card card-flush">
        {error ? <ErrorBox error={error} onRetry={reload} />
          : loading && !data ? <Spinner />
            : !data.items.length ? <Empty title="No notifications yet" />
              : data.items.map((item) => (
                <div key={item._id} className={`note-row ${item.readAt ? '' : 'note-unread'}`}>
                  <strong>{item.title}</strong>
                  <div className="small">{item.body}</div>
                  <div className="muted small">{dateTime(item.createdAt)}</div>
                </div>
              ))}
        <Pager data={data} onPage={setPage} />
      </section>
    </main>
  );
}

export function CmsPage() {
  const { slug } = useParams();
  const { data, loading, error, reload } = useFetch(() => api.get(`/common/pages/${slug}`), [slug]);
  return (
    <main className="page page-narrow">
      {loading ? <Spinner /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
        <article className="card stack"><h1>{data.title}</h1><p className="prose">{data.content}</p></article>
      )}
    </main>
  );
}
