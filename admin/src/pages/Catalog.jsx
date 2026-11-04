import { useState } from 'react';
import {
  Badge, DataTable, Empty, ErrorBox, Field, Pager, Spinner, dateOnly, dateTime, rupees, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { assetUrl } from '@shared/api.js';
import { api } from '../client.js';
import { Resource } from '../components/Resource.jsx';

const active = (row) => <Badge value={row.isActive ? 'active' : 'disabled'} label={row.isActive ? 'Active' : 'Off'} />;

export function Cities() {
  return (
    <Resource
      title="Cities"
      subtitle="Customers can book only in active cities that have a pricing plan"
      path="/admin/cities"
      singular="City"
      deletable={false}
      columns={[
        { label: 'City', render: (c) => <strong>{c.name}</strong> },
        { label: 'State', key: 'state' },
        { label: 'Status', render: active },
      ]}
      fields={[
        { name: 'name', label: 'City', required: true },
        { name: 'state', label: 'State', required: true },
        { name: 'lat', label: 'Latitude', type: 'number', step: 'any', read: (c) => c.center?.coordinates?.[1], hint: 'Map centre for this city' },
        { name: 'lng', label: 'Longitude', type: 'number', step: 'any', read: (c) => c.center?.coordinates?.[0] },
        { name: 'isActive', label: 'Active', type: 'checkbox' },
      ]}
    />
  );
}

export function Pricing() {
  const cities = useFetch(() => api.get('/admin/cities', { limit: 100 }), []);
  if (cities.loading) return <Spinner />;
  if (cities.error) return <ErrorBox error={cities.error} onRetry={cities.reload} />;

  const type = (...names) => (values) => names.includes(values.bookingType);
  const summary = (plan) => ({
    hourly: `${rupees(plan.baseFare)} for ${plan.includedHours}h, then ${rupees(plan.extraHourRate)}/h`,
    oneway: `${rupees(plan.baseFare)} for ${plan.includedKm} km, then ${rupees(plan.perKmRate)}/km`,
    outstation: `${rupees(plan.perDayRate)}/day + ${rupees(plan.foodAllowancePerDay)} food`,
    monthly: `${rupees(plan.monthlyRate)}/month for ${plan.includedHours}h a day`,
  }[plan.bookingType]);

  return (
    <Resource
      title="Pricing"
      subtitle="One plan per city and booking type. Commission and tax are in Settings."
      path="/admin/pricing"
      singular="Plan"
      columns={[
        { label: 'City', render: (p) => <strong>{p.city?.name}</strong> },
        { label: 'Type', render: (p) => words(p.bookingType) },
        { label: 'Rate', render: summary },
        { label: 'Night charge', render: (p) => (p.nightCharge ? rupees(p.nightCharge) : '—') },
        { label: 'Status', render: active },
      ]}
      fields={[
        { name: 'city', label: 'City', type: 'select', required: true, read: (p) => p.city?._id, options: cities.data.items.map((c) => ({ value: c._id, label: c.name })) },
        { name: 'bookingType', label: 'Booking type', type: 'select', required: true, options: ['hourly', 'oneway', 'outstation', 'monthly'] },
        { name: 'baseFare', label: 'Base fare (₹)', type: 'number', min: 0, when: type('hourly', 'oneway', 'outstation') },
        { name: 'includedHours', label: 'Included hours', type: 'number', min: 0, step: 'any', when: type('hourly', 'oneway', 'monthly'), hint: 'Hours per day for monthly plans' },
        { name: 'extraHourRate', label: 'Extra hour rate (₹)', type: 'number', min: 0, when: type('hourly', 'oneway', 'monthly') },
        { name: 'includedKm', label: 'Included km', type: 'number', min: 0, step: 'any', when: type('oneway') },
        { name: 'perKmRate', label: 'Per km rate (₹)', type: 'number', min: 0, when: type('oneway') },
        { name: 'returnAllowance', label: 'Driver return allowance (₹)', type: 'number', min: 0, when: type('oneway') },
        { name: 'perDayRate', label: 'Per day rate (₹)', type: 'number', min: 0, when: type('outstation') },
        { name: 'foodAllowancePerDay', label: 'Food per day (₹)', type: 'number', min: 0, when: type('outstation') },
        { name: 'stayAllowancePerNight', label: 'Stay per night (₹)', type: 'number', min: 0, when: type('outstation') },
        { name: 'monthlyRate', label: 'Monthly rate (₹)', type: 'number', min: 0, when: type('monthly') },
        { name: 'nightCharge', label: 'Night charge (₹)', type: 'number', min: 0, when: type('hourly', 'oneway') },
        { name: 'isActive', label: 'Active', type: 'checkbox' },
      ]}
    />
  );
}

export function Coupons() {
  return (
    <Resource
      title="Coupons"
      path="/admin/coupons"
      singular="Coupon"
      columns={[
        { label: 'Code', render: (c) => <strong>{c.code}</strong> },
        { label: 'Discount', render: (c) => (c.discountType === 'flat' ? rupees(c.value) : `${c.value}%${c.maxDiscount ? ` up to ${rupees(c.maxDiscount)}` : ''}`) },
        { label: 'Min fare', render: (c) => rupees(c.minFare) },
        { label: 'Valid', render: (c) => `${dateOnly(c.validFrom)} to ${dateOnly(c.validTo)}` },
        { label: 'Used', render: (c) => `${c.usedCount}${c.usageLimit ? ` of ${c.usageLimit}` : ''}` },
        { label: 'Status', render: active },
      ]}
      fields={[
        { name: 'code', label: 'Code', required: true },
        { name: 'description', label: 'Description' },
        { name: 'discountType', label: 'Type', type: 'select', required: true, options: ['flat', 'percent'] },
        { name: 'value', label: 'Value', type: 'number', min: 1, required: true, hint: '₹ for flat, % for percent' },
        { name: 'maxDiscount', label: 'Maximum discount (₹)', type: 'number', min: 0, hint: '0 means no cap' },
        { name: 'minFare', label: 'Minimum fare (₹)', type: 'number', min: 0 },
        { name: 'validFrom', label: 'Valid from', type: 'date', required: true },
        { name: 'validTo', label: 'Valid to', type: 'date', required: true, endOfDay: true },
        { name: 'usageLimit', label: 'Total uses', type: 'number', min: 0, hint: '0 means unlimited' },
        { name: 'perUserLimit', label: 'Uses per customer', type: 'number', min: 0, default: 1 },
        { name: 'isActive', label: 'Active', type: 'checkbox' },
      ]}
    />
  );
}

export function Banners() {
  return (
    <Resource
      title="Banners"
      subtitle="Shown on the customer home screen and in the apps"
      path="/admin/banners"
      singular="Banner"
      columns={[
        { label: 'Image', render: (b) => (b.imageUrl ? <img src={assetUrl(b.imageUrl)} alt="" style={{ height: 36, borderRadius: 4 }} /> : '—') },
        { label: 'Title', render: (b) => <strong>{b.title}</strong> },
        { label: 'Audience', render: (b) => words(b.audience) },
        { label: 'Order', key: 'sortOrder' },
        { label: 'Status', render: active },
      ]}
      fields={[
        { name: 'title', label: 'Title', required: true },
        { name: 'subtitle', label: 'Subtitle' },
        { name: 'imageUrl', label: 'Image URL' },
        { name: 'linkUrl', label: 'Link URL' },
        { name: 'audience', label: 'Audience', type: 'select', required: true, default: 'customer', options: ['customer', 'driver', 'all'] },
        { name: 'sortOrder', label: 'Order', type: 'number', default: 0 },
        { name: 'isActive', label: 'Active', type: 'checkbox' },
      ]}
    />
  );
}

export function Pages() {
  return (
    <Resource
      title="Pages"
      subtitle="Terms, privacy, about and FAQ text served to every app"
      path="/admin/pages"
      singular="Page"
      columns={[
        { label: 'Title', render: (p) => <strong>{p.title}</strong> },
        { label: 'Slug', key: 'slug' },
        { label: 'Status', render: (p) => <Badge value={p.isPublished ? 'active' : 'disabled'} label={p.isPublished ? 'Published' : 'Draft'} /> },
        { label: 'Updated', render: (p) => dateTime(p.updatedAt) },
      ]}
      fields={[
        { name: 'title', label: 'Title', required: true },
        { name: 'slug', label: 'Slug', required: true, hint: 'Lowercase, used in the URL' },
        { name: 'content', label: 'Content', type: 'textarea', rows: 12 },
        { name: 'isPublished', label: 'Published', type: 'checkbox' },
      ]}
    />
  );
}

export function Broadcasts() {
  const list = useList((query) => api.get('/admin/broadcasts', query));
  const [form, setForm] = useState({ audience: 'customers', title: '', body: '' });
  const [run, busy] = useAction();

  const send = async (event) => {
    event.preventDefault();
    const sent = await run(() => api.post('/admin/broadcasts', form), `Sent to ${form.audience}`);
    if (sent) { setForm({ ...form, title: '', body: '' }); list.reload({ quiet: true }); }
  };

  const columns = [
    { label: 'Sent', render: (b) => dateTime(b.createdAt) },
    { label: 'Title', render: (b) => <strong>{b.title}</strong> },
    { label: 'Message', key: 'body' },
    { label: 'Audience', render: (b) => words(b.audience) },
    { label: 'Reached', align: 'right', key: 'recipientCount' },
    { label: 'By', render: (b) => b.sentBy?.name },
  ];

  return (
    <>
      <div className="page-head"><div><h1>Broadcasts</h1><p>Send an in-app notification to everyone in an audience</p></div></div>
      <form className="card stack" onSubmit={send} style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <Field label="Audience">
            <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              <option value="customers">All customers</option>
              <option value="drivers">All drivers</option>
              <option value="all">Everyone</option>
            </select>
          </Field>
          <Field label="Title"><input required minLength={2} maxLength={100} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <div className="span-2"><Field label="Message"><textarea rows={3} required minLength={2} maxLength={500} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field></div>
        </div>
        <div className="row-end"><button className="btn btn-primary" disabled={busy}>Send now</button></div>
      </form>
      <section className="card card-flush">
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="Nothing sent yet" />
              : <DataTable columns={columns} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}
