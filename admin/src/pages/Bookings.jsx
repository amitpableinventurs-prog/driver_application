import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import {
  Badge, DataTable, Empty, ErrorBox, FareLines, Field, Modal, Pager, PromptModal, Spinner, dateTime, rupees, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { MapView, toLatLng } from '@shared/map.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api, openBlob } from '../client.js';

const STATUSES = ['pending', 'searching', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_driver'];
const TYPES = ['hourly', 'oneway', 'outstation', 'monthly'];
const ACTIVE = ['pending', 'searching', 'accepted', 'arrived', 'in_progress'];

export function Bookings() {
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const list = useList((params) => api.get('/admin/bookings', params), { search: '', status: '', type: '' });
  useRealtime(api, { 'booking:updated': () => list.reload({ quiet: true }) });

  const exportCsv = () => run(() => {
    const query = new URLSearchParams(Object.entries(list.filters).filter(([, value]) => value));
    return openBlob(`/admin/bookings/export?${query}`, 'bookings.csv');
  });

  const columns = [
    { label: 'Booking', render: (b) => <strong>{b.bookingNo}</strong> },
    { label: 'Type', render: (b) => words(b.type) },
    { label: 'Customer', render: (b) => <>{b.customer?.name || 'Customer'}<div className="muted small">{b.customer?.phone}</div></> },
    { label: 'Driver', render: (b) => (b.driver ? <>{b.driver.name}<div className="muted small">{b.driver.phone}</div></> : <span className="muted">Unassigned</span>) },
    { label: 'City', render: (b) => b.city?.name },
    { label: 'When', render: (b) => dateTime(b.scheduledAt) },
    { label: 'Status', render: (b) => <Badge value={b.status} /> },
    { label: 'Fare', align: 'right', render: (b) => rupees(b.fareFinal?.total ?? b.fareEstimate?.total) },
  ];

  return (
    <>
      <div className="page-head">
        <div><h1>Bookings</h1><p>Search by booking number, customer or driver</p></div>
        <button className="btn" onClick={exportCsv} disabled={busy}><Download size={16} aria-hidden /> Export CSV</button>
      </div>
      <section className="card card-flush">
        <div className="filters">
          <input type="search" placeholder="Search" aria-label="Search bookings" value={list.filters.search} onChange={(e) => list.setFilter('search', e.target.value)} />
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{words(status)}</option>)}
          </select>
          <select aria-label="Type" value={list.filters.type} onChange={(e) => list.setFilter('type', e.target.value)}>
            <option value="">All types</option>
            {TYPES.map((type) => <option key={type} value={type}>{words(type)}</option>)}
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No bookings match" />
              : <DataTable columns={columns} rows={list.data.items} onRowClick={(b) => navigate(`/bookings/${b._id}`)} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}

function AssignModal({ bookingId, onClose, onDone }) {
  const candidates = useFetch(() => api.get(`/admin/bookings/${bookingId}/candidates`), [bookingId]);
  const [run, busy] = useAction();
  const assign = async (driverId) => {
    if (await run(() => api.post(`/admin/bookings/${bookingId}/assign`, { driverId }), 'Driver assigned')) { onDone(); onClose(); }
  };
  return (
    <Modal title="Assign a driver" onClose={onClose}>
      {candidates.loading ? <Spinner /> : candidates.error ? <ErrorBox error={candidates.error} />
        : !candidates.data.length ? <Empty title="No eligible drivers nearby" hint="Online, KYC approved drivers with the right skills appear here, nearest first." />
          : (
            <div className="stack">
              {candidates.data.map((driver) => (
                <div className="row-between" key={driver._id}>
                  <div><strong>{driver.name}</strong><div className="muted small">{driver.phone} · {driver.rating || 'New'} ★ · {driver.totalTrips} trips</div></div>
                  <button className="btn btn-primary" disabled={busy} onClick={() => assign(driver._id)}>Assign</button>
                </div>
              ))}
            </div>
          )}
    </Modal>
  );
}

function RefundModal({ booking, onClose, onDone }) {
  const [form, setForm] = useState({ amount: booking.fareFinal?.total || 0, note: '' });
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    const done = await run(() => api.post(`/admin/bookings/${booking._id}/refund`, { amount: Number(form.amount), note: form.note }), 'Refund sent to wallet');
    if (done) { onDone(); onClose(); }
  };
  return (
    <Modal title={`Refund ${booking.bookingNo}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Amount (₹)" hint={`Paid: ${rupees(booking.fareFinal?.total)}. A booking can be refunded once.`}>
          <input type="number" min="1" max={booking.fareFinal?.total} required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Reason"><input required minLength={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <div className="row-end"><button type="button" className="btn" onClick={onClose}>Back</button><button className="btn btn-danger" disabled={busy}>Refund to wallet</button></div>
      </form>
    </Modal>
  );
}

export function BookingDetail({ me }) {
  const { id } = useParams();
  const [dialog, setDialog] = useState(null);
  const [driverAt, setDriverAt] = useState(null);
  const { data, loading, error, reload } = useFetch(() => api.get(`/admin/bookings/${id}`), [id]);

  useRealtime(api, {
    'booking:updated': (event) => { if (event.bookingId === id) reload({ quiet: true }); },
    'driver:location': (event) => { if (event.driverId === data?.booking.driver?._id) setDriverAt(event); },
  }, { bookingId: id });

  const booking = data?.booking;
  const markers = useMemo(() => {
    if (!booking) return [];
    const pickup = toLatLng(booking.pickup);
    const drop = toLatLng(booking.drop);
    const driver = driverAt || toLatLng(booking.driver?.location && { location: booking.driver.location });
    return [
      { id: 'pickup', ...pickup, kind: 'pickup', label: 'P' },
      drop && { id: 'drop', ...drop, kind: 'drop', label: 'D' },
      driver && ACTIVE.includes(booking.status) && { id: 'driver', lat: driver.lat, lng: driver.lng, kind: 'driver' },
    ].filter(Boolean);
  }, [booking, driverAt]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;

  const { reviews, sos } = data;
  const canAssign = ['pending', 'searching'].includes(booking.status);
  const canRefund = booking.paymentStatus === 'paid' && me.permissions.includes('finance');
  const center = [markers[0].lat, markers[0].lng];

  return (
    <>
      <Link to="/bookings" className="link-back"><ArrowLeft size={15} aria-hidden /> Bookings</Link>
      <div className="page-head">
        <div className="row"><h1>{booking.bookingNo}</h1><Badge value={booking.status} /><Badge value={booking.paymentStatus} label={`Payment: ${words(booking.paymentStatus)}`} /></div>
        <div className="row">
          {canAssign && <button className="btn btn-primary" onClick={() => setDialog('assign')}>Assign driver</button>}
          {canRefund && <button className="btn" onClick={() => setDialog('refund')}>Refund</button>}
          {ACTIVE.includes(booking.status) && <button className="btn btn-danger" onClick={() => setDialog('cancel')}>Cancel booking</button>}
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <dl className="facts">
              <div><dt>Type</dt><dd>{words(booking.type)}</dd></div>
              <div><dt>City</dt><dd>{booking.city?.name}</dd></div>
              <div><dt>Scheduled</dt><dd>{dateTime(booking.scheduledAt)}</dd></div>
              <div><dt>Car</dt><dd>{booking.carSnapshot?.name} ({booking.carSnapshot?.registrationNumber})</dd></div>
              <div><dt>Transmission</dt><dd>{words(booking.carSnapshot?.transmission)}</dd></div>
              <div><dt>Payment</dt><dd>{words(booking.paymentMethod)}</dd></div>
              <div><dt>Pickup</dt><dd>{booking.pickup?.address}</dd></div>
              {booking.drop?.address && <div><dt>Drop</dt><dd>{booking.drop.address}</dd></div>}
              {booking.notes && <div><dt>Customer note</dt><dd>{booking.notes}</dd></div>}
              {booking.cancellation?.by && <div><dt>Cancelled by</dt><dd>{words(booking.cancellation.by)}: {booking.cancellation.reason}</dd></div>}
            </dl>
          </section>
          <MapView center={center} zoom={13} markers={markers} fitMarkers height={300} />
          {reviews.length > 0 && (
            <section className="card stack">
              <h2>Ratings</h2>
              {reviews.map((review) => <p key={review._id}><strong>{review.rating} ★</strong> from {review.fromRole}{review.comment ? `: ${review.comment}` : ''}</p>)}
            </section>
          )}
          {sos.length > 0 && (
            <section className="card stack">
              <h2>SOS on this booking</h2>
              {sos.map((alert) => <div className="row-between" key={alert._id}><span>{words(alert.raisedByRole)} at {dateTime(alert.createdAt)}</span><Badge value={alert.status} /></div>)}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="card stack">
            <h2>People</h2>
            <div><div className="muted small">Customer</div><Link to={`/customers/${booking.customer?._id}`}>{booking.customer?.name || 'Customer'}</Link><div className="small">{booking.customer?.phone}</div></div>
            <div>
              <div className="muted small">Driver</div>
              {booking.driver ? <><Link to={`/drivers/${booking.driver._id}`}>{booking.driver.name}</Link><div className="small">{booking.driver.phone}</div></> : <span className="muted">Not assigned</span>}
              {booking.assignedByAdmin && <div className="muted small">Assigned by {booking.assignedByAdmin.name}</div>}
            </div>
          </section>
          <section className="card stack">
            <h2>{booking.fareFinal?.total !== undefined ? 'Final fare' : 'Estimated fare'}</h2>
            <FareLines fare={booking.fareFinal?.total !== undefined ? booking.fareFinal : booking.fareEstimate} />
            <hr className="divider" />
            <dl className="fare">
              <div><dt>Commission</dt><dd>{rupees(booking.commission)}</dd></div>
              <div><dt>Driver earning</dt><dd>{rupees(booking.driverEarning)}</dd></div>
            </dl>
            {booking.couponCode && <p className="small muted">Coupon {booking.couponCode}</p>}
          </section>
          <section className="card stack">
            <h2>Timeline</h2>
            <ul className="timeline">
              {booking.statusHistory.map((entry) => (
                <li key={`${entry.status}${entry.at}`}><span>{words(entry.status)}</span><span className="muted">{dateTime(entry.at)}</span></li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {dialog === 'assign' && <AssignModal bookingId={id} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'refund' && <RefundModal booking={booking} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'cancel' && (
        <PromptModal
          title={`Cancel ${booking.bookingNo}`}
          label="Reason (sent to the customer)"
          confirmLabel="Cancel booking"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => { await api.post(`/admin/bookings/${id}/cancel`, { reason }); await reload(); return true; }}
        />
      )}
    </>
  );
}
