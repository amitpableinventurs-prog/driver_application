import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LocateFixed } from 'lucide-react';
import { ErrorBox, FareLines, Field, Spinner, rupees, useAction, useDebounced, useFetch, useToast } from '@shared/ui.jsx';
import { MapView } from '@shared/map.jsx';
import { api } from '../client.js';
import { useAccount } from '../account.js';
import { CarForm } from './Garage.jsx';

const TYPES = [
  { key: 'hourly', title: 'Hourly', hint: 'Errands, meetings, a night out' },
  { key: 'oneway', title: 'One way', hint: 'Drive my car to a place' },
  { key: 'outstation', title: 'Outstation', hint: 'Trips out of the city' },
  { key: 'monthly', title: 'Monthly', hint: 'A regular driver for a month' },
];
const PAYMENTS = [['cash', 'Cash'], ['wallet', 'Wallet'], ['online', 'Pay online after trip']];
const EMPTY_PLACE = { address: '', lat: null, lng: null };

const localNow = (minutesAhead) => {
  const date = new Date(Date.now() + minutesAhead * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const complete = (place) => place.address.trim().length >= 3 && place.lat !== null;

function PlacePicker({ label, value, onChange, saved, city, active, onActivate }) {
  const toast = useToast();
  const locate = () => {
    if (!navigator.geolocation) { toast('Location is not available on this device', 'bad'); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => onChange({ ...value, lat: coords.latitude, lng: coords.longitude, address: value.address || 'Current location' }),
      () => toast('Allow location access, or tap the map instead', 'bad'),
    );
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Field label={label}>
        <div className="place-row">
          <input placeholder="House, street, area" value={value.address} onFocus={onActivate} onChange={(e) => onChange({ ...value, address: e.target.value })} />
          <button type="button" className="btn btn-icon" onClick={locate} aria-label={`Use my location for ${label.toLowerCase()}`}><LocateFixed size={17} /></button>
        </div>
      </Field>
      {saved.length > 0 && (
        <div className="pick-tabs">
          {saved.map((place) => (
            <button type="button" key={place._id} className="chip" onClick={() => onChange({ address: place.address, lat: place.lat, lng: place.lng })}>{place.label}</button>
          ))}
        </div>
      )}
      <span className="field-hint">
        {value.lat === null ? `Tap the map to pin the exact ${label.toLowerCase()} point` : `Pinned${active ? '. Tap the map to move it.' : ''}`}
        {!city && ' (select a city first)'}
      </span>
    </div>
  );
}

export default function Book() {
  const navigate = useNavigate();
  const { me, reloadMe } = useAccount();
  const [run, busy] = useAction();
  const data = useFetch(async () => {
    const [cities, cars, addresses, banners, active, coupons] = await Promise.all([
      api.get('/common/cities'),
      api.get('/customer/cars'),
      api.get('/customer/addresses'),
      api.get('/common/banners', { audience: 'customer' }),
      api.get('/customer/bookings', { scope: 'active', limit: 1 }),
      api.get('/customer/coupons'),
    ]);
    return { cities, cars, addresses, banners, active: active.items[0], coupons };
  }, []);

  const [form, setForm] = useState({
    type: 'hourly', cityId: '', carId: '', when: 'now', scheduledAt: localNow(120), hours: 4, days: 2, hoursPerDay: 8,
    paymentMethod: 'cash', couponCode: '', notes: '',
  });
  const [pickup, setPickup] = useState(EMPTY_PLACE);
  const [drop, setDrop] = useState(EMPTY_PLACE);
  const [pinning, setPinning] = useState('pickup');
  const [estimate, setEstimate] = useState({ state: 'idle' });
  const [addingCar, setAddingCar] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!data.data) return;
    setForm((current) => ({
      ...current,
      cityId: current.cityId || data.data.cities[0]?._id || '',
      carId: current.carId || data.data.cars[0]?._id || '',
    }));
  }, [data.data]);

  const city = data.data?.cities.find((item) => item._id === form.cityId);
  const needsDrop = form.type === 'oneway' || form.type === 'outstation';
  const scheduled = form.when === 'later' || form.type === 'monthly';

  const payload = useMemo(() => {
    const body = { type: form.type, cityId: form.cityId, pickup };
    if (needsDrop) body.drop = drop;
    if (scheduled) body.scheduledAt = new Date(form.scheduledAt).toISOString();
    if (form.type === 'hourly') body.hours = Number(form.hours);
    if (form.type === 'outstation') body.days = Number(form.days);
    if (form.type === 'monthly') body.hoursPerDay = Number(form.hoursPerDay);
    if (form.couponCode.trim()) body.couponCode = form.couponCode.trim();
    return body;
  }, [form, pickup, drop, needsDrop, scheduled]);

  const ready = Boolean(form.cityId) && complete(pickup) && (!needsDrop || complete(drop));
  const debouncedKey = useDebounced(JSON.stringify(payload), 450);

  useEffect(() => {
    if (!ready) { setEstimate({ state: 'idle' }); return undefined; }
    let stale = false;
    setEstimate((current) => ({ ...current, state: 'loading' }));
    api.post('/customer/estimate', JSON.parse(debouncedKey))
      .then((result) => { if (!stale) setEstimate({ state: 'ready', ...result }); })
      .catch((error) => { if (!stale) setEstimate({ state: 'error', error }); });
    return () => { stale = true; };
  }, [debouncedKey, ready]);

  const markers = useMemo(() => [
    pickup.lat !== null && { id: 'p', lat: pickup.lat, lng: pickup.lng, kind: 'pickup', label: 'P' },
    needsDrop && drop.lat !== null && { id: 'd', lat: drop.lat, lng: drop.lng, kind: 'drop', label: 'D' },
  ].filter(Boolean), [pickup, drop, needsDrop]);

  if (data.loading && !data.data) return <main className="page"><Spinner /></main>;
  if (data.error && !data.data) return <main className="page"><ErrorBox error={data.error} onRetry={data.reload} /></main>;

  const { cities, cars, addresses, banners, active, coupons } = data.data;
  const center = city?.center?.coordinates ? [city.center.coordinates[1], city.center.coordinates[0]] : [22.7196, 75.8577];
  const banner = banners[0];
  const walletShort = form.paymentMethod === 'wallet' && estimate.state === 'ready' && me.walletBalance < estimate.fare.total;

  const onPick = ({ lat, lng }) => {
    const update = (setter) => setter((place) => ({ ...place, lat, lng, address: place.address || `Pinned point ${lat.toFixed(4)}, ${lng.toFixed(4)}` }));
    if (pinning === 'drop' && needsDrop) update(setDrop); else update(setPickup);
  };

  const submit = async (event) => {
    event.preventDefault();
    const body = { ...payload, carId: form.carId, paymentMethod: form.paymentMethod };
    if (form.notes.trim()) body.notes = form.notes.trim();
    const booking = await run(() => api.post('/customer/bookings', body));
    if (booking) { reloadMe(); navigate(`/trips/${booking._id}`); }
  };

  return (
    <main className="page">
      <section className="hero-banner">
        <div>
          <h1>{banner?.title || 'Your car, our driver'}</h1>
          <p>{banner?.subtitle || 'Verified drivers by the hour, day or month'}</p>
        </div>
      </section>

      {active && (
        <Link to={`/trips/${active._id}`} className="card row-between no-print" style={{ marginBottom: 14, textDecoration: 'none', color: 'inherit', borderColor: 'var(--brand)' }}>
          <span><strong>{active.bookingNo}</strong> is in progress</span>
          <span className="btn btn-primary">Open trip</span>
        </Link>
      )}

      <form className="book-layout" onSubmit={submit}>
        <div className="stack">
          <section className="card stack">
            <h2>What do you need?</h2>
            <div className="types">
              {TYPES.map((type) => {
                const available = !city || city.bookingTypes.includes(type.key);
                return (
                  <button type="button" key={type.key} className="type-card" aria-pressed={form.type === type.key} disabled={!available} onClick={() => set('type', type.key)}>
                    <strong>{type.title}</strong><span>{available ? type.hint : 'Not in this city'}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid-2">
              <Field label="City">
                <select required value={form.cityId} onChange={(e) => set('cityId', e.target.value)}>
                  {cities.map((item) => <option key={item._id} value={item._id}>{item.name}</option>)}
                </select>
              </Field>
              {form.type === 'hourly' && (
                <Field label="How many hours?">
                  <select value={form.hours} onChange={(e) => set('hours', e.target.value)}>
                    {[2, 3, 4, 5, 6, 8, 10, 12].map((value) => <option key={value} value={value}>{value} hours</option>)}
                  </select>
                </Field>
              )}
              {form.type === 'outstation' && <Field label="Number of days"><input type="number" min="1" max="30" required value={form.days} onChange={(e) => set('days', e.target.value)} /></Field>}
              {form.type === 'monthly' && <Field label="Hours per day"><input type="number" min="1" max="14" required value={form.hoursPerDay} onChange={(e) => set('hoursPerDay', e.target.value)} /></Field>}
            </div>
          </section>

          <section className="card stack">
            <h2>Where?</h2>
            <PlacePicker label="Pickup" value={pickup} onChange={setPickup} saved={addresses} city={city} active={pinning === 'pickup'} onActivate={() => setPinning('pickup')} />
            {needsDrop && <PlacePicker label="Drop" value={drop} onChange={setDrop} saved={addresses} city={city} active={pinning === 'drop'} onActivate={() => setPinning('drop')} />}
            {needsDrop && (
              <div className="seg" role="group" aria-label="Which point the map sets">
                <button type="button" aria-pressed={pinning === 'pickup'} onClick={() => setPinning('pickup')}>Pin pickup</button>
                <button type="button" aria-pressed={pinning === 'drop'} onClick={() => setPinning('drop')}>Pin drop</button>
              </div>
            )}
            <MapView center={center} zoom={12} markers={markers} onPick={onPick} height={280} />
          </section>

          <section className="card stack">
            <h2>When?</h2>
            {form.type !== 'monthly' && (
              <div className="seg" role="group" aria-label="Booking time">
                <button type="button" aria-pressed={form.when === 'now'} onClick={() => set('when', 'now')}>Now</button>
                <button type="button" aria-pressed={form.when === 'later'} onClick={() => set('when', 'later')}>Later</button>
              </div>
            )}
            {scheduled && <Field label={form.type === 'monthly' ? 'Start date and time' : 'Date and time'}><input type="datetime-local" required min={localNow(30)} value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} /></Field>}
          </section>

          <section className="card stack">
            <div className="row-between"><h2>Which car?</h2><button type="button" className="btn" onClick={() => setAddingCar(true)}>Add a car</button></div>
            {cars.length === 0 ? <p className="muted">Add your car so we can send a driver who knows how to drive it.</p> : (
              <Field label="Your car">
                <select required value={form.carId} onChange={(e) => set('carId', e.target.value)}>
                  {cars.map((car) => <option key={car._id} value={car._id}>{car.name} · {car.registrationNumber} · {car.transmission}</option>)}
                </select>
              </Field>
            )}
            <Field label="Note for the driver (optional)"><textarea rows={2} maxLength={500} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          </section>
        </div>

        <aside className="book-side stack">
          <section className="card stack">
            <h2>Fare estimate</h2>
            {estimate.state === 'idle' && <p className="muted">Add your {needsDrop ? 'pickup and drop' : 'pickup'} to see the fare.</p>}
            {estimate.state === 'loading' && !estimate.fare && <Spinner label="Calculating" />}
            {estimate.state === 'error' && <p role="alert" style={{ color: 'var(--bad)' }}>{estimate.error.message}</p>}
            {estimate.fare && estimate.state !== 'error' && (
              <>
                <FareLines fare={estimate.fare} />
                {estimate.estimatedKm > 0 && <p className="small muted">About {estimate.estimatedKm} km. The final fare depends on actual time and distance.</p>}
              </>
            )}
            <Field label="Coupon">
              <input value={form.couponCode} placeholder={coupons[0]?.code ? `Try ${coupons[0].code}` : ''} onChange={(e) => set('couponCode', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Payment" hint={form.paymentMethod === 'wallet' ? `Balance ${rupees(me.walletBalance)}` : undefined}>
              <select value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)}>
                {PAYMENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            {walletShort && <p className="small" style={{ color: 'var(--bad)' }}>Your wallet is short. <Link to="/wallet">Add money</Link></p>}
            <button className="btn btn-primary btn-block btn-lg" disabled={busy || !ready || !form.carId || estimate.state !== 'ready' || walletShort}>
              {scheduled ? 'Schedule driver' : 'Book driver now'}
            </button>
          </section>
        </aside>
      </form>

      {addingCar && (
        <CarForm onClose={() => setAddingCar(false)} onSaved={(car) => { data.reload({ quiet: true }); set('carId', car._id); }} />
      )}
    </main>
  );
}
