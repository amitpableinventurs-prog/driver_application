import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Badge, Empty, ErrorBox, Field, Modal, Pager, Spinner, dateTime, useAction, useFetch, useList, words } from '@shared/ui.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from '../client.js';

function NewTicket({ bookingId, onClose }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ subject: '', category: bookingId ? 'booking' : 'other', message: '' });
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    const body = bookingId ? { ...form, bookingId } : form;
    const ticket = await run(() => api.post('/customer/tickets', body), 'We have your request');
    if (ticket) navigate(`/support/${ticket._id}`);
  };
  return (
    <Modal title="Contact support" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Topic">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {['booking', 'payment', 'driver', 'app', 'account', 'other'].map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
        </Field>
        <Field label="Subject"><input required minLength={3} maxLength={150} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <Field label="How can we help?"><textarea rows={4} required minLength={3} maxLength={2000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
        <div className="row-end"><button type="button" className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy}>Send</button></div>
      </form>
    </Modal>
  );
}

export function Support() {
  const [params, setParams] = useSearchParams();
  const bookingId = params.get('booking');
  const [open, setOpen] = useState(Boolean(bookingId));
  const list = useList((query) => api.get('/customer/tickets', query));
  const config = useFetch(() => api.get('/common/config'), []);
  const close = () => { setOpen(false); setParams({}); };

  return (
    <main className="page page-narrow">
      <div className="row-between page-title">
        <div><h1>Help and support</h1>{config.data?.supportPhone && <p>Call us on <a href={`tel:${config.data.supportPhone}`}>{config.data.supportPhone}</a></p>}</div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>New request</button>
      </div>
      <section className="card card-flush">
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No requests yet" hint="Questions about a trip or payment? We reply here." />
              : list.data.items.map((ticket) => (
                <Link key={ticket._id} className="trip-row" to={`/support/${ticket._id}`}>
                  <div><strong>{ticket.subject}</strong><div className="muted small">{ticket.ticketNo} · {dateTime(ticket.updatedAt)}</div></div>
                  <Badge value={ticket.status} />
                </Link>
              ))}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
      {open && <NewTicket bookingId={bookingId} onClose={close} />}
    </main>
  );
}

export function TicketThread() {
  const { id } = useParams();
  const { data: ticket, loading, error, reload } = useFetch(() => api.get(`/customer/tickets/${id}`), [id]);
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  useRealtime(api, { notification: (item) => { if (item.data?.ticketId === id) reload({ quiet: true }); } });

  if (loading && !ticket) return <main className="page"><Spinner /></main>;
  if (error && !ticket) return <main className="page"><ErrorBox error={error} onRetry={reload} /></main>;

  const send = async (event) => {
    event.preventDefault();
    if (await run(() => api.post(`/customer/tickets/${id}/messages`, { text }))) { setText(''); reload({ quiet: true }); }
  };

  return (
    <main className="page page-narrow">
      <Link to="/support" className="row small muted" style={{ marginBottom: 8, textDecoration: 'none' }}><ArrowLeft size={15} aria-hidden /> Help and support</Link>
      <div className="row-between page-title">
        <div><h1>{ticket.subject}</h1><p>{ticket.ticketNo}</p></div>
        <Badge value={ticket.status} />
      </div>
      <section className="card stack">
        <div className="thread">
          {ticket.messages.map((message) => (
            <div key={message._id} className={`bubble ${message.from === 'user' ? 'bubble-mine' : ''}`}>
              {message.text}
              <small>{message.from === 'user' ? 'You' : 'Driver IN support'} · {dateTime(message.at)}</small>
            </div>
          ))}
        </div>
        {ticket.status === 'closed' ? <p className="muted">This request is closed.</p> : (
          <form className="stack" onSubmit={send}>
            <textarea rows={2} required aria-label="Your reply" placeholder="Write a reply" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row-end"><button className="btn btn-primary" disabled={busy}>Send</button></div>
          </form>
        )}
      </section>
    </main>
  );
}
