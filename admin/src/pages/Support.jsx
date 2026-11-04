import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  Badge, DataTable, Empty, ErrorBox, Pager, PromptModal, Spinner, dateTime, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from '../client.js';

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

export function Tickets() {
  const navigate = useNavigate();
  const list = useList((query) => api.get('/admin/tickets', query), { search: '', status: '' });
  useRealtime(api, { 'ticket:new': () => list.reload({ quiet: true }) });
  const columns = [
    { label: 'Ticket', render: (t) => <strong>{t.ticketNo}</strong> },
    { label: 'Subject', key: 'subject' },
    { label: 'From', render: (t) => <>{t.raisedByName || 'User'}<div className="muted small">{words(t.role)} · {t.raisedByPhone}</div></> },
    { label: 'Category', render: (t) => words(t.category) },
    { label: 'Status', render: (t) => <Badge value={t.status} /> },
    { label: 'Updated', render: (t) => dateTime(t.updatedAt) },
  ];
  return (
    <>
      <div className="page-head"><div><h1>Support tickets</h1><p>From the customer panel and both mobile apps</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <input type="search" placeholder="Ticket, subject, name or phone" aria-label="Search tickets" value={list.filters.search} onChange={(e) => list.setFilter('search', e.target.value)} />
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {TICKET_STATUSES.map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No tickets match" />
              : <DataTable columns={columns} rows={list.data.items} onRowClick={(t) => navigate(`/tickets/${t._id}`)} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const { data: ticket, loading, error, reload } = useFetch(() => api.get(`/admin/tickets/${id}`), [id]);
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  if (loading && !ticket) return <Spinner />;
  if (error && !ticket) return <ErrorBox error={error} onRetry={reload} />;

  const reply = async (event) => {
    event.preventDefault();
    if (await run(() => api.post(`/admin/tickets/${id}/reply`, { text }), 'Reply sent')) { setText(''); reload({ quiet: true }); }
  };
  const setStatus = async (status) => { if (await run(() => api.patch(`/admin/tickets/${id}`, { status }), 'Status updated')) reload({ quiet: true }); };

  return (
    <>
      <Link to="/tickets" className="link-back"><ArrowLeft size={15} aria-hidden /> Tickets</Link>
      <div className="page-head">
        <div>
          <div className="row"><h1>{ticket.subject}</h1><Badge value={ticket.status} /></div>
          <p>{ticket.ticketNo} · {ticket.raisedByName} ({words(ticket.role)}, {ticket.raisedByPhone}){ticket.booking ? ' · ' : ''}{ticket.booking && <Link to={`/bookings/${ticket.booking._id}`}>{ticket.booking.bookingNo}</Link>}</p>
        </div>
        <select aria-label="Ticket status" style={{ width: 160 }} value={ticket.status} disabled={busy} onChange={(e) => setStatus(e.target.value)}>
          {TICKET_STATUSES.map((value) => <option key={value} value={value}>{words(value)}</option>)}
        </select>
      </div>
      <section className="card stack">
        <div className="thread">
          {ticket.messages.map((message) => (
            <div key={message._id} className={`bubble ${message.from === 'admin' ? 'bubble-mine' : ''}`}>
              {message.text}
              <small>{message.from === 'admin' ? message.adminName : ticket.raisedByName || 'User'} · {dateTime(message.at)}</small>
            </div>
          ))}
        </div>
        <form className="stack" onSubmit={reply}>
          <textarea rows={3} required aria-label="Reply" placeholder="Write a reply" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row-end"><button className="btn btn-primary" disabled={busy}>Send reply</button></div>
        </form>
      </section>
    </>
  );
}

export function Sos() {
  const list = useList((query) => api.get('/admin/sos', query), { status: 'open' });
  const [resolving, setResolving] = useState(null);
  useRealtime(api, { 'sos:new': () => list.reload({ quiet: true }) });
  const columns = [
    { label: 'Raised', render: (a) => dateTime(a.createdAt) },
    { label: 'Booking', render: (a) => <Link to={`/bookings/${a.booking?._id}`}>{a.booking?.bookingNo}</Link> },
    { label: 'By', render: (a) => words(a.raisedByRole) },
    { label: 'Customer', render: (a) => <>{a.booking?.customer?.name}<div className="muted small">{a.booking?.customer?.phone}</div></> },
    { label: 'Driver', render: (a) => <>{a.booking?.driver?.name || '—'}<div className="muted small">{a.booking?.driver?.phone}</div></> },
    { label: 'Location', render: (a) => (a.lat ? <a href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=16/${a.lat}/${a.lng}`} target="_blank" rel="noreferrer">Open map</a> : '—') },
    { label: 'Message', render: (a) => a.message || a.resolutionNote || '—' },
    { label: 'Status', render: (a) => <Badge value={a.status} /> },
    { label: 'Action', render: (a) => (a.status === 'open' ? <button className="btn btn-primary" onClick={() => setResolving(a)}>Resolve</button> : '—') },
  ];
  return (
    <>
      <div className="page-head"><div><h1>SOS alerts</h1><p>Call both parties first, then record what happened</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No alerts" hint="New alerts appear here instantly." />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
      {resolving && (
        <PromptModal
          title="Resolve SOS"
          label="What happened and what was done"
          confirmLabel="Resolve"
          onClose={() => setResolving(null)}
          onSubmit={async (resolutionNote) => { await api.post(`/admin/sos/${resolving._id}/resolve`, { resolutionNote }); await list.reload(); return true; }}
        />
      )}
    </>
  );
}

export function Reviews() {
  const list = useList((query) => api.get('/admin/reviews', query), { maxRating: '' });
  const [run, busy] = useAction();
  const toggle = async (review) => {
    if (await run(() => api.patch(`/admin/reviews/${review._id}`, { hidden: !review.hidden }), review.hidden ? 'Review restored' : 'Review hidden')) list.reload({ quiet: true });
  };
  const columns = [
    { label: 'When', render: (r) => dateTime(r.createdAt) },
    { label: 'Booking', render: (r) => <Link to={`/bookings/${r.booking?._id}`}>{r.booking?.bookingNo}</Link> },
    { label: 'From', render: (r) => (r.fromRole === 'customer' ? r.customer?.name : r.driver?.name) },
    { label: 'About', render: (r) => (r.fromRole === 'customer' ? r.driver?.name : r.customer?.name) },
    { label: 'Rating', render: (r) => `${r.rating} ★` },
    { label: 'Comment', render: (r) => r.comment || '—' },
    { label: 'Action', render: (r) => <button className="btn" disabled={busy} onClick={() => toggle(r)}>{r.hidden ? 'Restore' : 'Hide'}</button> },
  ];
  return (
    <>
      <div className="page-head"><div><h1>Reviews</h1><p>Hiding a review removes it from the average rating</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <select aria-label="Rating" value={list.filters.maxRating} onChange={(e) => list.setFilter('maxRating', e.target.value)}>
            <option value="">All ratings</option>
            <option value="2">2 stars or lower</option>
            <option value="3">3 stars or lower</option>
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No reviews yet" />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}
