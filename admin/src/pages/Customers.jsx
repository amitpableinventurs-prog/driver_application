import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  Badge, DataTable, Empty, ErrorBox, Pager, PromptModal, Spinner, dateOnly, dateTime, rupees, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { api } from '../client.js';
import { TransactionsCard, WalletModal } from '../components/Wallet.jsx';

export function Customers() {
  const navigate = useNavigate();
  const list = useList((query) => api.get('/admin/customers', query), { search: '', status: '' });
  const columns = [
    { label: 'Customer', render: (c) => <><strong>{c.name || 'Not set'}</strong><div className="muted small">{c.phone}</div></> },
    { label: 'Email', render: (c) => c.email || '—' },
    { label: 'Status', render: (c) => <Badge value={c.status} /> },
    { label: 'Joined', render: (c) => dateOnly(c.createdAt) },
    { label: 'Trips', align: 'right', render: (c) => c.totalBookings },
    { label: 'Wallet', align: 'right', render: (c) => rupees(c.walletBalance) },
  ];
  return (
    <>
      <div className="page-head"><div><h1>Customers</h1><p>Everyone who has signed in to the app or customer panel</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <input type="search" placeholder="Name or phone" aria-label="Search customers" value={list.filters.search} onChange={(e) => list.setFilter('search', e.target.value)} />
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {['active', 'blocked', 'deleted'].map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No customers match" />
              : <DataTable columns={columns} rows={list.data.items} onRowClick={(c) => navigate(`/customers/${c._id}`)} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}

export function CustomerDetail({ me }) {
  const { id } = useParams();
  const [dialog, setDialog] = useState(null);
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useFetch(() => api.get(`/admin/customers/${id}`), [id]);
  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const { customer, cars, bookings, transactions } = data;

  const unblock = async () => { if (await run(() => api.patch(`/admin/customers/${id}/status`, { status: 'active' }), 'Customer unblocked')) reload(); };

  return (
    <>
      <Link to="/customers" className="link-back"><ArrowLeft size={15} aria-hidden /> Customers</Link>
      <div className="page-head">
        <div className="row"><h1>{customer.name || customer.phone}</h1><Badge value={customer.status} /></div>
        <div className="row">
          {me.permissions.includes('finance') && <button className="btn" onClick={() => setDialog('wallet')}>Adjust wallet</button>}
          {customer.status === 'active' && <button className="btn btn-danger" onClick={() => setDialog('block')}>Block</button>}
          {customer.status === 'blocked' && <button className="btn btn-primary" disabled={busy} onClick={unblock}>Unblock</button>}
        </div>
      </div>
      <div className="detail-grid">
        <div className="stack">
          <section className="card card-flush">
            <div className="card-head" style={{ padding: '16px 18px 0' }}><h2>Recent bookings</h2></div>
            {bookings.length === 0 ? <Empty title="No bookings yet" /> : (
              <DataTable
                rows={bookings}
                columns={[
                  { label: 'Booking', render: (b) => <Link to={`/bookings/${b._id}`}>{b.bookingNo}</Link> },
                  { label: 'Driver', render: (b) => b.driver?.name || '—' },
                  { label: 'When', render: (b) => dateTime(b.scheduledAt) },
                  { label: 'Status', render: (b) => <Badge value={b.status} /> },
                  { label: 'Fare', align: 'right', render: (b) => rupees(b.fareFinal?.total ?? b.fareEstimate?.total) },
                ]}
              />
            )}
          </section>
          <TransactionsCard transactions={transactions} />
        </div>
        <div className="stack">
          <section className="card">
            <dl className="facts">
              <div><dt>Phone</dt><dd>{customer.phone}</dd></div>
              <div><dt>Email</dt><dd>{customer.email || '—'}</dd></div>
              <div><dt>Wallet</dt><dd>{rupees(customer.walletBalance)}</dd></div>
              <div><dt>Rating</dt><dd>{customer.ratingCount ? `${customer.rating} ★` : 'No ratings'}</dd></div>
              <div><dt>Trips</dt><dd>{customer.totalBookings}</dd></div>
              <div><dt>Referral code</dt><dd>{customer.referralCode || '—'}</dd></div>
              <div><dt>Joined</dt><dd>{dateOnly(customer.createdAt)}</dd></div>
            </dl>
          </section>
          <section className="card stack">
            <h2>Cars</h2>
            {cars.length === 0 ? <p className="muted">No cars added</p> : cars.map((car) => (
              <div key={car._id}><strong>{car.name}</strong><div className="muted small">{car.registrationNumber} · {words(car.transmission)} · {words(car.category)}</div></div>
            ))}
          </section>
        </div>
      </div>
      {dialog === 'wallet' && <WalletModal path={`/admin/customers/${id}/wallet`} name={customer.name} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'block' && (
        <PromptModal
          title={`Block ${customer.name || 'customer'}`}
          label="Reason"
          confirmLabel="Block customer"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => { await api.patch(`/admin/customers/${id}/status`, { status: 'blocked', reason }); await reload(); return true; }}
        />
      )}
    </>
  );
}
