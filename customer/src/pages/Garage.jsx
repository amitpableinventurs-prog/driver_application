import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Empty, ErrorBox, Field, Modal, Spinner, useAction, useFetch, words } from '@shared/ui.jsx';
import { MapView } from '@shared/map.jsx';
import { api } from '../client.js';

export function CarForm({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', registrationNumber: '', transmission: 'manual', category: 'hatchback', fuel: 'petrol' });
  const [run, busy] = useAction();
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const submit = async (event) => {
    event.preventDefault();
    const car = await run(() => api.post('/customer/cars', form), 'Car added');
    if (car) { onSaved(car); onClose(); }
  };
  return (
    <Modal title="Add a car" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Car name"><input required minLength={2} placeholder="Maruti Swift" value={form.name} onChange={set('name')} /></Field>
        <Field label="Registration number"><input required minLength={4} maxLength={15} placeholder="MP09AB1234" value={form.registrationNumber} onChange={set('registrationNumber')} /></Field>
        <div className="grid-3">
          <Field label="Gearbox"><select value={form.transmission} onChange={set('transmission')}><option value="manual">Manual</option><option value="automatic">Automatic</option></select></Field>
          <Field label="Type"><select value={form.category} onChange={set('category')}>{['hatchback', 'sedan', 'suv', 'luxury'].map((value) => <option key={value} value={value}>{words(value)}</option>)}</select></Field>
          <Field label="Fuel"><select value={form.fuel} onChange={set('fuel')}>{['petrol', 'diesel', 'cng', 'ev'].map((value) => <option key={value} value={value}>{value === 'ev' || value === 'cng' ? value.toUpperCase() : words(value)}</option>)}</select></Field>
        </div>
        <div className="row-end"><button type="button" className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy}>Save car</button></div>
      </form>
    </Modal>
  );
}

function AddressForm({ onClose, onSaved }) {
  const [form, setForm] = useState({ label: '', address: '', lat: null, lng: null });
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    if (await run(() => api.post('/customer/addresses', form), 'Address saved')) { onSaved(); onClose(); }
  };
  const markers = form.lat === null ? [] : [{ id: 'a', lat: form.lat, lng: form.lng, kind: 'pickup' }];
  return (
    <Modal title="Save an address" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Label"><input required maxLength={40} placeholder="Home" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
        <Field label="Address"><input required minLength={3} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <div>
          <span className="field-label">Tap the map to pin it</span>
          <MapView center={[22.7196, 75.8577]} zoom={12} markers={markers} height={220} onPick={({ lat, lng }) => setForm((current) => ({ ...current, lat, lng }))} />
        </div>
        <div className="row-end"><button type="button" className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy || form.lat === null}>Save address</button></div>
      </form>
    </Modal>
  );
}

export default function Garage() {
  const data = useFetch(async () => {
    const [cars, addresses] = await Promise.all([api.get('/customer/cars'), api.get('/customer/addresses')]);
    return { cars, addresses };
  }, []);
  const [dialog, setDialog] = useState(null);
  const [run, busy] = useAction();

  if (data.loading && !data.data) return <main className="page"><Spinner /></main>;
  if (data.error && !data.data) return <main className="page"><ErrorBox error={data.error} onRetry={data.reload} /></main>;
  const { cars, addresses } = data.data;
  const reload = () => data.reload({ quiet: true });
  const remove = async (path, message) => { if (await run(() => api.del(path), message)) reload(); };

  return (
    <main className="page page-narrow">
      <Link to="/account" className="row small muted" style={{ marginBottom: 8, textDecoration: 'none' }}><ArrowLeft size={15} aria-hidden /> Account</Link>
      <div className="page-title"><h1>Cars and addresses</h1></div>
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2>My cars</h2><button className="btn" onClick={() => setDialog('car')}>Add a car</button></div>
          {cars.length === 0 ? <Empty title="No cars yet" /> : cars.map((car) => (
            <div className="list-row" key={car._id}>
              <div><strong>{car.name}</strong><div className="muted small">{car.registrationNumber} · {words(car.transmission)} · {words(car.category)}</div></div>
              <button className="btn btn-icon" disabled={busy} aria-label={`Remove ${car.name}`} onClick={() => remove(`/customer/cars/${car._id}`, 'Car removed')}><Trash2 size={15} /></button>
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head"><h2>Saved addresses</h2><button className="btn" onClick={() => setDialog('address')}>Add address</button></div>
          {addresses.length === 0 ? <Empty title="No saved addresses" hint="Saved places appear as one-tap shortcuts when booking." /> : addresses.map((address) => (
            <div className="list-row" key={address._id}>
              <div><strong>{address.label}</strong><div className="muted small">{address.address}</div></div>
              <button className="btn btn-icon" disabled={busy} aria-label={`Remove ${address.label}`} onClick={() => remove(`/customer/addresses/${address._id}`, 'Address removed')}><Trash2 size={15} /></button>
            </div>
          ))}
        </section>
      </div>
      {dialog === 'car' && <CarForm onClose={() => setDialog(null)} onSaved={reload} />}
      {dialog === 'address' && <AddressForm onClose={() => setDialog(null)} onSaved={reload} />}
    </main>
  );
}
