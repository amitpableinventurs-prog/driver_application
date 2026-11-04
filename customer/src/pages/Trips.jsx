import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, LoaderCircle, Phone, ShieldAlert, Star } from 'lucide-react';
import {
  Badge, Empty, ErrorBox, FareLines, Field, Modal, Pager, PromptModal, Spinner, dateTime, rupees, useAction, useFetch, useList, useToast, words,
} from '@shared/ui.jsx';
import { assetUrl } from '@shared/api.js';
import { MapView, toLatLng } from '@shared/map.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api, completePayment } from '../client.js';
import { useAccount } from '../account.js';

const ACTIVE = ['pending', 'searching', 'accepted', 'arrived', 'in_progress'];
const STEPS = [['searching', 'Finding'], ['accepted', 'Assigned'], ['arrived', 'Arrived'], ['in_progress', 'On trip'], ['completed', 'Done']];
const fareOf = (booking) => booking.fareFinal?.total ?? booking.fareEstimate?.total;

export function Trips() {
  const list = useList((query) => api.get('/customer/bookings', query), { scope: 'all' });
  return (
    <main className="page page-narrow">
      <div className="page-title"><h1>My trips</h1></div>
      <div className="seg" role="group" aria-label="Filter trips" style={{ marginBottom: 12 }}>
        {[['all', 'All'], ['active', 'Active'], ['past', 'Past']].map(([value, label]) => (
          <button key={value} aria-pressed={list.filters.scope === value} onClick={() => list.setFilter('scope', value)}>{label}</button>
        ))}
      </div>
      <section className="card card-flush">
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No trips here"><Link className="btn btn-primary" to="/">Book a driver</Link></Empty>
              : list.data.items.map((booking) => (
                <Link key={booking._id} className="trip-row" to={`/trips/${booking._id}`}>
                  <div>
                    <strong>{words(booking.type)}</strong> <span className="muted small">{booking.bookingNo}</span>
                    <div className="small">{booking.pickup?.address}</div>
                    <div className="muted small">{dateTime(booking.scheduledAt)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div><strong>{rupees(fareOf(booking))}</strong></div>
                    <Badge value={booking.status} />
                  </div>
                </Link>
              ))}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </main>
  );
}

function Progress({ status }) {
  const reached = status === 'pending' ? -1 : STEPS.findIndex(([key]) => key === status);
  return (
    <div className="steps" aria-label={`Status: ${words(status)}`}>
      {STEPS.map(([key, label], index) => <div key={key} className={`step ${index <= reached ? 'done' : ''}`}>{label}</div>)}
    </div>
  );
}

function RateCard({ bookingId, onDone }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    const body = { rating };
    if (comment.trim()) body.comment = comment.trim();
    if (await run(() => api.post(`/customer/bookings/${bookingId}/rate`, body), 'Thanks for your feedback')) onDone();
  };
  return (
    <form className="card stack no-print" onSubmit={submit}>
      <h2>How was your driver?</h2>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((value) => (
          <button type="button" key={value} className={value <= rating ? 'on' : ''} role="radio" aria-checked={value === rating} aria-label={`${value} star${value > 1 ? 's' : ''}`} onClick={() => setRating(value)}><Star size={30} /></button>
        ))}
      </div>
      <Field label="Comment (optional)"><textarea rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <button className="btn btn-primary" disabled={busy || !rating}>Submit rating</button>
    </form>
  );
}

function Invoice({ bookingId, onClose }) {
  const { data, loading, error } = useFetch(() => api.get(`/customer/bookings/${bookingId}/invoice`), [bookingId]);
  return (
    <Modal title="Invoice" onClose={onClose}>
      {loading ? <Spinner /> : error ? <ErrorBox error={error} /> : (
        <div className="stack">
          <dl className="facts">
            <div><dt>Invoice</dt><dd>{data.invoiceNo}</dd></div>
            <div><dt>Date</dt><dd>{dateTime(data.issuedAt)}</dd></div>
            <div><dt>Billed to</dt><dd>{data.customer.name}</dd></div>
            <div><dt>Driver</dt><dd>{data.driver.name}</dd></div>
            <div><dt>Car</dt><dd>{data.car?.name} ({data.car?.registrationNumber})</dd></div>
            <div><dt>Payment</dt><dd>{words(data.paymentMethod)}, {words(data.paymentStatus)}</dd></div>
          </dl>
          <FareLines fare={data.fare} />
          <div className="row-end no-print"><button className="btn btn-primary" onClick={() => window.print()}>Print</button></div>
        </div>
      )}
    </Modal>
  );
}

export function TripDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { reloadMe } = useAccount();
  const [dialog, setDialog] = useState(null);
  const [rated, setRated] = useState(false);
  const [driverAt, setDriverAt] = useState(null);
  const [run, busy] = useAction();
  const { data: booking, loading, error, reload } = useFetch(() => api.get(`/customer/bookings/${id}`), [id]);

  useRealtime(api, {
    'booking:updated': (event) => { if (event.bookingId === id) { reload({ quiet: true }); reloadMe(); } },
    'driver:location': (event) => setDriverAt(event),
  }, { bookingId: id });

  const markers = useMemo(() => {
    if (!booking) return [];
    const pickup = toLatLng(booking.pickup);
    const drop = toLatLng(booking.drop);
    const driver = driverAt || toLatLng(booking.driver?.location && { location: booking.driver.location });
    return [
      { id: 'p', ...pickup, kind: 'pickup', label: 'P' },
      drop && { id: 'd', ...drop, kind: 'drop', label: 'D' },
      driver && ACTIVE.includes(booking.status) && { id: 'v', lat: driver.lat, lng: driver.lng, kind: 'driver' },
    ].filter(Boolean);
  }, [booking, driverAt]);

  if (loading && !booking) return <main className="page"><Spinner /></main>;
  if (error && !booking) return <main className="page"><ErrorBox error={error} onRetry={reload} /></main>;

  const isActive = ACTIVE.includes(booking.status);
  const canCancel = ['pending', 'searching', 'accepted', 'arrived'].includes(booking.status);
  const driverAssigned = ['accepted', 'arrived'].includes(booking.status);
  const fare = booking.status === 'completed' ? booking.fareFinal : booking.fareEstimate;
  const owes = booking.status === 'completed' && booking.paymentStatus === 'pending';

  const pay = async () => {
    const done = await run(async () => {
      const order = await api.post(`/customer/bookings/${id}/pay`);
      return completePayment(order);
    }, 'Payment received');
    if (done) reload({ quiet: true });
  };
  const sos = () => run(async () => {
    const position = await new Promise((resolve) => {
      if (!navigator.geolocation) resolve(null);
      else navigator.geolocation.getCurrentPosition(({ coords }) => resolve(coords), () => resolve(null), { timeout: 4000 });
    });
    const body = position ? { lat: position.latitude, lng: position.longitude } : {};
    const result = await api.post(`/customer/bookings/${id}/sos`, body);
    toast(`Safety team alerted. Emergency number: ${result.emergencyNumber}`, 'bad');
    setDialog(null);
  });

  return (
    <main className="page page-narrow">
      <Link to="/trips" className="row small muted no-print" style={{ marginBottom: 8, textDecoration: 'none' }}><ArrowLeft size={15} aria-hidden /> My trips</Link>
      <div className="row-between page-title">
        <div>
          <h1>{words(booking.type)} trip</h1>
          <p>{booking.bookingNo} · {dateTime(booking.scheduledAt)}</p>
        </div>
        <Badge value={booking.status} />
      </div>

      <div className="stack">
        {isActive && <section className="card"><Progress status={booking.status} /></section>}

        {booking.status === 'pending' && <section className="card"><strong>Scheduled.</strong> We will start finding your driver closer to the time.</section>}
        {booking.status === 'searching' && (
          <section className="card searching" role="status"><LoaderCircle className="spin" size={24} aria-hidden /><div><strong>Finding a verified driver near you</strong><div className="muted small">This usually takes a minute or two</div></div></section>
        )}
        {booking.status === 'no_driver' && <section className="card"><strong>No driver was available.</strong> You have not been charged. <Link to="/">Try again</Link></section>}
        {booking.status === 'cancelled' && (
          <section className="card">
            <strong>Cancelled by {booking.cancellation?.by}.</strong> {booking.cancellation?.reason}
            {booking.cancellation?.fee > 0 && <div className="small">Cancellation fee: {rupees(booking.cancellation.fee)}</div>}
          </section>
        )}

        {booking.startOtp && booking.status !== 'pending' && booking.status !== 'searching' && (
          <section className="otp-card">
            <div><div className="small">Share with your driver to start</div><strong>{booking.startOtp}</strong></div>
          </section>
        )}

        {booking.driver && (
          <section className="card driver-card">
            {booking.driver.avatar ? <img className="avatar" src={assetUrl(booking.driver.avatar)} alt="" /> : <span className="avatar">{booking.driver.name?.[0] || 'D'}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{booking.driver.name}</strong>
              <div className="muted small">
                {booking.driver.ratingCount ? `${booking.driver.rating} ★ · ` : 'New driver · '}{booking.driver.totalTrips} trips{booking.driver.experienceYears ? ` · ${booking.driver.experienceYears} yrs` : ''}
              </div>
            </div>
            {booking.driver.phone && <a className="btn btn-icon" href={`tel:${booking.driver.phone}`} aria-label="Call driver"><Phone size={17} /></a>}
          </section>
        )}

        {isActive && <MapView center={[markers[0].lat, markers[0].lng]} zoom={13} markers={markers} fitMarkers height={280} />}

        <section className="card stack">
          <dl className="facts">
            <div><dt>Pickup</dt><dd>{booking.pickup?.address}</dd></div>
            {booking.drop?.address && <div><dt>Drop</dt><dd>{booking.drop.address}</dd></div>}
            <div><dt>Car</dt><dd>{booking.carSnapshot?.name}</dd></div>
            <div><dt>Payment</dt><dd>{words(booking.paymentMethod)}</dd></div>
          </dl>
          <hr className="divider" />
          <h2>{booking.status === 'completed' ? 'Final fare' : 'Estimated fare'}</h2>
          <FareLines fare={fare} />
        </section>

        {owes && (
          <section className="card row-between no-print">
            <div><strong>{rupees(booking.fareFinal.total)} to pay</strong><div className="muted small">Pay online, or give cash to your driver</div></div>
            <button className="btn btn-primary" disabled={busy} onClick={pay}>Pay now</button>
          </section>
        )}

        {booking.status === 'completed' && !rated && <RateCard bookingId={id} onDone={() => setRated(true)} />}

        <div className="row no-print">
          {booking.status === 'completed' && <button className="btn" onClick={() => setDialog('invoice')}>Invoice</button>}
          {canCancel && <button className="btn" onClick={() => setDialog('cancel')}>Cancel booking</button>}
          {isActive && <button className="btn btn-danger" onClick={() => setDialog('sos')}><ShieldAlert size={16} aria-hidden /> SOS</button>}
          <Link className="btn btn-ghost" to={`/support?booking=${id}`}>Get help</Link>
        </div>
      </div>

      {dialog === 'invoice' && <Invoice bookingId={id} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && (
        <PromptModal
          title="Cancel this booking?"
          label={driverAssigned ? 'Why are you cancelling? A fee may apply now that a driver is assigned.' : 'Why are you cancelling?'}
          confirmLabel="Cancel booking"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => { await api.post(`/customer/bookings/${id}/cancel`, { reason }); await reload({ quiet: true }); reloadMe(); return true; }}
        />
      )}
      {dialog === 'sos' && (
        <Modal title="Send an SOS?" onClose={() => setDialog(null)}>
          <div className="stack">
            <p>Our safety team will see your trip and location straight away. In immediate danger, call 112.</p>
            <div className="row-end">
              <button className="btn" onClick={() => setDialog(null)}>Back</button>
              <a className="btn" href="tel:112">Call 112</a>
              <button className="btn btn-danger" disabled={busy} onClick={sos}>Send SOS</button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
