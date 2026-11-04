import { useEffect, useState } from 'react';
import {
  Badge, DataTable, Empty, ErrorBox, Field, Modal, Pager, Spinner, dateTime, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { api } from '../client.js';

const GROUPS = [
  ['Money', [
    ['commissionPercent', 'Commission (%)', 'Taken from the fare before tax'],
    ['taxPercent', 'Tax (%)', 'Applied after discount'],
    ['minPayoutAmount', 'Minimum payout (₹)'],
    ['driverMinWalletBalance', 'Driver dues limit (₹)', 'Negative number. Below this a driver cannot go online.'],
  ]],
  ['Dispatch', [
    ['searchRadiusKm', 'Search radius (km)'],
    ['maxDriversPerDispatch', 'Drivers offered at once'],
    ['searchTimeoutSeconds', 'Search timeout (seconds)', 'Instant bookings give up after this'],
    ['dispatchLeadMinutes', 'Dispatch lead (minutes)', 'How early a scheduled booking is offered'],
    ['minScheduleLeadMinutes', 'Minimum schedule lead (minutes)'],
  ]],
  ['Cancellation', [
    ['freeCancelMinutes', 'Free cancel window (minutes)', 'After a driver accepts'],
    ['cancellationFee', 'Cancellation fee (₹)'],
    ['cancellationDriverSharePercent', 'Driver share of fee (%)'],
  ]],
  ['Night and referral', [
    ['nightStartHour', 'Night starts (hour, 0 to 23)'],
    ['nightEndHour', 'Night ends (hour, 0 to 23)'],
    ['referralRewardReferrer', 'Reward to referrer (₹)'],
    ['referralRewardReferee', 'Reward to new customer (₹)'],
  ]],
];
const CONTACT = [['supportPhone', 'Support phone'], ['supportEmail', 'Support email'], ['sosPhone', 'Emergency number']];

export function Settings() {
  const { data, loading, error, reload } = useFetch(() => api.get('/admin/settings'), []);
  const [values, setValues] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (data) setValues(data); }, [data]);

  if (loading && !values) return <Spinner />;
  if (error && !values) return <ErrorBox error={error} onRetry={reload} />;
  if (!values) return null;

  const save = (event) => {
    event.preventDefault();
    const payload = {};
    GROUPS.flatMap(([, fields]) => fields).forEach(([key]) => { payload[key] = Number(values[key]); });
    CONTACT.forEach(([key]) => { payload[key] = values[key] || ''; });
    run(() => api.put('/admin/settings', payload), 'Settings saved');
  };

  return (
    <form onSubmit={save}>
      <div className="page-head">
        <div><h1>Settings</h1><p>Applied to new bookings straight away</p></div>
        <button className="btn btn-primary" disabled={busy}>Save settings</button>
      </div>
      <div className="stack">
        {GROUPS.map(([title, fields]) => (
          <section className="card" key={title}>
            <h2 style={{ marginBottom: 12 }}>{title}</h2>
            <div className="form-grid">
              {fields.map(([key, label, hint]) => (
                <Field key={key} label={label} hint={hint}>
                  <input type="number" step="1" required value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
                </Field>
              ))}
            </div>
          </section>
        ))}
        <section className="card">
          <h2 style={{ marginBottom: 12 }}>Contact</h2>
          <div className="form-grid">
            {CONTACT.map(([key, label]) => (
              <Field key={key} label={label}><input value={values[key] || ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></Field>
            ))}
          </div>
        </section>
      </div>
    </form>
  );
}

function AdminForm({ admin, roles, onClose, onDone }) {
  const [form, setForm] = useState({ name: admin?.name || '', email: admin?.email || '', role: admin?.role || 'support', password: '', status: admin?.status || 'active' });
  const [run, busy] = useAction();
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const submit = async (event) => {
    event.preventDefault();
    const save = () => {
      if (!admin) return api.post('/admin/admins', { name: form.name, email: form.email, role: form.role, password: form.password });
      const body = { name: form.name, role: form.role, status: form.status };
      if (form.password) body.password = form.password;
      return api.patch(`/admin/admins/${admin._id}`, body);
    };
    if (await run(save, 'Saved')) { onDone(); onClose(); }
  };
  return (
    <Modal title={admin ? `Edit ${admin.name}` : 'Add team member'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name"><input required minLength={2} value={form.name} onChange={set('name')} /></Field>
        {!admin && <Field label="Email"><input type="email" required value={form.email} onChange={set('email')} /></Field>}
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>{roles.map((role) => <option key={role.key} value={role.key}>{role.label}</option>)}</select>
        </Field>
        {admin && (
          <Field label="Status">
            <select value={form.status} onChange={set('status')}><option value="active">Active</option><option value="disabled">Disabled</option></select>
          </Field>
        )}
        <Field label={admin ? 'New password' : 'Password'} hint={admin ? 'Leave blank to keep the current password' : 'At least 8 characters'}>
          <input type="password" autoComplete="new-password" minLength={8} required={!admin} value={form.password} onChange={set('password')} />
        </Field>
        <div className="row-end"><button type="button" className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

export function AdminUsers() {
  const list = useList((query) => api.get('/admin/admins', query));
  const roles = useFetch(() => api.get('/admin/roles'), []);
  const [editing, setEditing] = useState(null);
  const roleName = (key) => roles.data?.find((role) => role.key === key)?.label || words(key);

  const columns = [
    { label: 'Name', render: (a) => <strong>{a.name}</strong> },
    { label: 'Email', key: 'email' },
    { label: 'Role', render: (a) => roleName(a.role) },
    { label: 'Status', render: (a) => <Badge value={a.status} /> },
    { label: 'Last login', render: (a) => dateTime(a.lastLoginAt) },
    { label: 'Action', render: (a) => <button className="btn" onClick={() => setEditing(a)}>Edit</button> },
  ];

  return (
    <>
      <div className="page-head">
        <div><h1>Team</h1><p>Each role sees only the sections it needs</p></div>
        <button className="btn btn-primary" disabled={!roles.data} onClick={() => setEditing('new')}>Add team member</button>
      </div>
      <section className="card card-flush">
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
      {roles.data && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginBottom: 10 }}>What each role can do</h2>
          <dl className="facts">
            {roles.data.map((role) => <div key={role.key}><dt>{role.label}</dt><dd style={{ fontWeight: 400 }}>{role.permissions.map(words).join(', ')}</dd></div>)}
          </dl>
        </section>
      )}
      {editing && (
        <AdminForm admin={editing === 'new' ? null : editing} roles={roles.data} onClose={() => setEditing(null)} onDone={() => list.reload({ quiet: true })} />
      )}
    </>
  );
}

export function AuditLogs() {
  const list = useList((query) => api.get('/admin/audit-logs', query), { entity: '' });
  const columns = [
    { label: 'When', render: (l) => dateTime(l.createdAt) },
    { label: 'Admin', key: 'adminName' },
    { label: 'Action', render: (l) => words(l.action) },
    { label: 'Entity', render: (l) => words(l.entity) },
    { label: 'Details', render: (l) => <span className="small muted" style={{ overflowWrap: 'anywhere' }}>{l.meta ? JSON.stringify(l.meta).slice(0, 120) : '—'}</span> },
    { label: 'IP', key: 'ip' },
  ];
  return (
    <>
      <div className="page-head"><div><h1>Audit log</h1><p>Every admin change, including who viewed KYC documents</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <input type="search" placeholder="Filter by entity, e.g. driver" aria-label="Filter by entity" value={list.filters.entity} onChange={(e) => list.setFilter('entity', e.target.value)} />
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No activity recorded" />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}
