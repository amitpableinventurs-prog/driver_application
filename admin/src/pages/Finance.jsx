import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, DataTable, Empty, ErrorBox, Field, Pager, PromptModal, Spinner, dateOnly, dateTime, rupees, useFetch, useList, words,
} from '@shared/ui.jsx';
import { api } from '../client.js';
import { signed } from '../components/Wallet.jsx';

export function Payouts() {
  const list = useList((query) => api.get('/admin/payouts', query), { status: 'requested' });
  const [action, setAction] = useState(null);

  const columns = [
    { label: 'Driver', render: (p) => <><Link to={`/drivers/${p.driver?._id}`}>{p.driver?.name}</Link><div className="muted small">{p.driver?.phone}</div></> },
    { label: 'Requested', render: (p) => dateTime(p.createdAt) },
    { label: 'Bank', render: (p) => <>{p.bankSnapshot?.accountHolder}<div className="muted small">{p.bankSnapshot?.accountNumber} · {p.bankSnapshot?.ifsc}</div></> },
    { label: 'Status', render: (p) => <Badge value={p.status} /> },
    { label: 'Reference', render: (p) => p.reference || p.note || '—' },
    { label: 'Amount', align: 'right', render: (p) => <strong>{rupees(p.amount)}</strong> },
    {
      label: 'Action',
      render: (p) => (p.status === 'requested' ? (
        <div className="row">
          <button className="btn btn-primary" onClick={() => setAction({ type: 'paid', payout: p })}>Mark paid</button>
          <button className="btn" onClick={() => setAction({ type: 'reject', payout: p })}>Reject</button>
        </div>
      ) : '—'),
    },
  ];

  const payout = action?.payout;
  return (
    <>
      <div className="page-head"><div><h1>Driver payouts</h1><p>The amount is held from the driver wallet when requested. Rejecting returns it.</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All</option>
            {['requested', 'paid', 'rejected'].map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No payouts here" />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
      {action?.type === 'paid' && (
        <PromptModal
          title={`Mark ${rupees(payout.amount)} as paid`}
          label="Bank or UPI reference"
          confirmLabel="Mark paid"
          placeholder="UTR number"
          onClose={() => setAction(null)}
          onSubmit={async (reference) => { await api.post(`/admin/payouts/${payout._id}/mark-paid`, { reference }); await list.reload(); return true; }}
        />
      )}
      {action?.type === 'reject' && (
        <PromptModal
          title={`Reject ${rupees(payout.amount)} payout`}
          label="Reason (shown to the driver)"
          confirmLabel="Reject and return to wallet"
          danger
          onClose={() => setAction(null)}
          onSubmit={async (note) => { await api.post(`/admin/payouts/${payout._id}/reject`, { note }); await list.reload(); return true; }}
        />
      )}
    </>
  );
}

const CATEGORIES = ['topup', 'trip_payment', 'trip_earning', 'cash_commission', 'cancellation_fee', 'cancellation_compensation', 'refund', 'referral_bonus', 'payout', 'payout_reversal', 'dues_payment', 'admin_adjustment'];

export function Transactions() {
  const list = useList((query) => api.get('/admin/transactions', query), { ownerRole: '', category: '' });
  const columns = [
    { label: 'When', render: (t) => dateTime(t.createdAt) },
    { label: 'Who', render: (t) => <>{t.ownerInfo?.name || 'Unknown'}<div className="muted small">{words(t.ownerRole)} · {t.ownerInfo?.phone}</div></> },
    { label: 'Type', render: (t) => words(t.category) },
    { label: 'Booking', render: (t) => (t.booking ? <Link to={`/bookings/${t.booking._id}`}>{t.booking.bookingNo}</Link> : '—') },
    { label: 'Note', render: (t) => t.note || '—' },
    { label: 'Amount', align: 'right', render: signed },
    { label: 'Balance', align: 'right', render: (t) => rupees(t.balanceAfter) },
  ];
  return (
    <>
      <div className="page-head"><div><h1>Transactions</h1><p>Every wallet movement, customer and driver</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <select aria-label="Owner" value={list.filters.ownerRole} onChange={(e) => list.setFilter('ownerRole', e.target.value)}>
            <option value="">Customers and drivers</option>
            <option value="customer">Customers</option>
            <option value="driver">Drivers</option>
          </select>
          <select aria-label="Type" value={list.filters.category} onChange={(e) => list.setFilter('category', e.target.value)}>
            <option value="">All types</option>
            {CATEGORIES.map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No transactions yet" />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}

const isoDay = (date) => date.toISOString().slice(0, 10);

export function Reports() {
  const [range, setRange] = useState({ from: isoDay(new Date(Date.now() - 29 * 86400000)), to: isoDay(new Date()) });
  const { data, loading, error, reload } = useFetch(
    () => api.get('/admin/reports/revenue', { from: `${range.from}T00:00:00+05:30`, to: `${range.to}T23:59:59+05:30` }),
    [range.from, range.to],
  );
  const columns = [
    { label: 'Date', render: (d) => dateOnly(d.date) },
    { label: 'Bookings', align: 'right', key: 'bookings' },
    { label: 'Completed', align: 'right', key: 'completed' },
    { label: 'Cancelled', align: 'right', key: 'cancelled' },
    { label: 'Gross fares', align: 'right', render: (d) => rupees(d.gross) },
    { label: 'Discounts', align: 'right', render: (d) => rupees(d.discount) },
    { label: 'Tax', align: 'right', render: (d) => rupees(d.tax) },
    { label: 'Commission', align: 'right', render: (d) => rupees(d.commission) },
    { label: 'Driver earnings', align: 'right', render: (d) => rupees(d.driverEarnings) },
  ];
  return (
    <>
      <div className="page-head">
        <div><h1>Revenue report</h1><p>Grouped by booking date in IST</p></div>
        <div className="row">
          <Field label="From"><input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        </div>
      </div>
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <div className="tiles">
            <div className="tile"><span>Gross fares</span><strong>{rupees(data.totals.gross)}</strong><small>{data.totals.completed} completed trips</small></div>
            <div className="tile"><span>Commission</span><strong>{rupees(data.totals.commission)}</strong></div>
            <div className="tile"><span>Tax collected</span><strong>{rupees(data.totals.tax)}</strong></div>
            <div className="tile"><span>Discounts given</span><strong>{rupees(data.totals.discount)}</strong></div>
            <div className="tile"><span>Driver earnings</span><strong>{rupees(data.totals.driverEarnings)}</strong></div>
          </div>
          <section className="card card-flush"><DataTable rowKey="date" columns={columns} rows={[...data.days].reverse()} /></section>
        </>
      )}
    </>
  );
}
