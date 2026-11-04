import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Eye, X } from 'lucide-react';
import {
  Badge, DataTable, Empty, ErrorBox, Pager, PromptModal, Spinner, dateOnly, dateTime, rupees, useAction, useFetch, useList, words,
} from '@shared/ui.jsx';
import { api, openBlob } from '../client.js';
import { WalletModal, TransactionsCard } from '../components/Wallet.jsx';

export function Drivers() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const list = useList((query) => api.get('/admin/drivers', query), { search: '', kycStatus: params.get('kyc') || '', status: '', online: '' });

  const columns = [
    { label: 'Driver', render: (d) => <><strong>{d.name || 'Not set'}</strong><div className="muted small">{d.phone}</div></> },
    { label: 'City', render: (d) => d.city?.name },
    { label: 'KYC', render: (d) => <Badge value={d.kycStatus} /> },
    { label: 'Status', render: (d) => <Badge value={d.status} /> },
    { label: 'Availability', render: (d) => (d.isOnline ? <Badge value="online" label={d.activeBooking ? 'On a booking' : 'Online'} /> : <span className="muted">Offline</span>) },
    { label: 'Rating', align: 'right', render: (d) => (d.ratingCount ? `${d.rating} ★` : '—') },
    { label: 'Trips', align: 'right', render: (d) => d.totalTrips },
    { label: 'Wallet', align: 'right', render: (d) => rupees(d.walletBalance) },
  ];

  return (
    <>
      <div className="page-head"><div><h1>Drivers</h1><p>Review KYC, manage access and wallets</p></div></div>
      <section className="card card-flush">
        <div className="filters">
          <input type="search" placeholder="Name or phone" aria-label="Search drivers" value={list.filters.search} onChange={(e) => list.setFilter('search', e.target.value)} />
          <select aria-label="KYC" value={list.filters.kycStatus} onChange={(e) => list.setFilter('kycStatus', e.target.value)}>
            <option value="">All KYC</option>
            {['not_submitted', 'submitted', 'approved', 'rejected'].map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
          <select aria-label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {['active', 'suspended', 'deleted'].map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select>
          <select aria-label="Availability" value={list.filters.online} onChange={(e) => list.setFilter('online', e.target.value)}>
            <option value="">Online and offline</option>
            <option value="true">Online</option>
            <option value="false">Offline</option>
          </select>
        </div>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title="No drivers match" hint="Drivers sign up from the driver mobile app." />
              : <DataTable columns={columns} rows={list.data.items} onRowClick={(d) => navigate(`/drivers/${d._id}`)} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
    </>
  );
}

function DocumentRow({ driverId, document, onChange }) {
  const [run, busy] = useAction();
  const [rejecting, setRejecting] = useState(false);
  const base = `/admin/drivers/${driverId}/documents/${document._id}`;
  const approve = async () => { if (await run(() => api.patch(base, { status: 'approved' }), 'Document approved')) onChange(); };
  return (
    <div className="doc-row">
      <div>
        <strong>{words(document.type)}</strong>
        <div className="muted small">
          {document.number || 'No number given'}{document.expiryDate ? ` · expires ${dateOnly(document.expiryDate)}` : ''}
        </div>
        {document.rejectionReason && <div className="small" style={{ color: 'var(--bad)' }}>{document.rejectionReason}</div>}
      </div>
      <Badge value={document.status} />
      <div className="row">
        <button className="btn btn-icon" disabled={busy} onClick={() => run(() => openBlob(`${base}/file`))} aria-label={`View ${words(document.type)}`} title="View"><Eye size={16} /></button>
        <button className="btn btn-icon" disabled={busy || document.status === 'approved'} onClick={approve} aria-label={`Approve ${words(document.type)}`} title="Approve"><Check size={16} /></button>
        <button className="btn btn-icon" disabled={busy} onClick={() => setRejecting(true)} aria-label={`Reject ${words(document.type)}`} title="Reject"><X size={16} /></button>
      </div>
      {rejecting && (
        <PromptModal
          title={`Reject ${words(document.type)}`}
          label="Reason (shown to the driver)"
          confirmLabel="Reject document"
          danger
          onClose={() => setRejecting(false)}
          onSubmit={async (rejectionReason) => { await api.patch(base, { status: 'rejected', rejectionReason }); await onChange(); return true; }}
        />
      )}
    </div>
  );
}

export function DriverDetail({ me }) {
  const { id } = useParams();
  const [dialog, setDialog] = useState(null);
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useFetch(() => api.get(`/admin/drivers/${id}`), [id]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;

  const { driver, bookings, transactions, requiredDocuments } = data;
  const approvedTypes = driver.documents.filter((d) => d.status === 'approved').map((d) => d.type);
  const missing = requiredDocuments.filter((type) => !approvedTypes.includes(type));

  const approveKyc = async () => {
    if (await run(() => api.post(`/admin/drivers/${id}/kyc`, { decision: 'approved' }), 'KYC approved. The driver has been notified.')) reload();
  };
  const reactivate = async () => {
    if (await run(() => api.patch(`/admin/drivers/${id}/status`, { status: 'active' }), 'Driver reactivated')) reload();
  };

  return (
    <>
      <Link to="/drivers" className="link-back"><ArrowLeft size={15} aria-hidden /> Drivers</Link>
      <div className="page-head">
        <div className="row"><h1>{driver.name || driver.phone}</h1><Badge value={driver.status} /><Badge value={driver.kycStatus} label={`KYC: ${words(driver.kycStatus)}`} /></div>
        <div className="row">
          {me.permissions.includes('finance') && <button className="btn" onClick={() => setDialog('wallet')}>Adjust wallet</button>}
          {driver.status === 'active' && <button className="btn btn-danger" onClick={() => setDialog('suspend')}>Suspend</button>}
          {driver.status === 'suspended' && <button className="btn btn-primary" disabled={busy} onClick={reactivate}>Reactivate</button>}
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>KYC documents</h2>
              {driver.kycStatus !== 'approved' && (
                <div className="row">
                  <button className="btn" onClick={() => setDialog('rejectKyc')}>Reject KYC</button>
                  <button className="btn btn-primary" disabled={busy || missing.length > 0} title={missing.length ? `Approve first: ${missing.map(words).join(', ')}` : undefined} onClick={approveKyc}>Approve KYC</button>
                </div>
              )}
            </div>
            {driver.kycRejectionReason && <p className="small" style={{ color: 'var(--bad)' }}>Rejected: {driver.kycRejectionReason}</p>}
            {driver.documents.length === 0 ? <Empty title="No documents uploaded yet" />
              : driver.documents.map((document) => <DocumentRow key={document._id} driverId={id} document={document} onChange={reload} />)}
            {missing.length > 0 && driver.documents.length > 0 && <p className="muted small" style={{ marginTop: 10 }}>Still needed for approval: {missing.map(words).join(', ')}</p>}
          </section>
          <section className="card card-flush">
            <div className="card-head" style={{ padding: '16px 18px 0' }}><h2>Recent trips</h2></div>
            {bookings.length === 0 ? <Empty title="No trips yet" /> : (
              <DataTable
                rows={bookings}
                columns={[
                  { label: 'Booking', render: (b) => <Link to={`/bookings/${b._id}`}>{b.bookingNo}</Link> },
                  { label: 'Customer', render: (b) => b.customer?.name },
                  { label: 'When', render: (b) => dateTime(b.scheduledAt) },
                  { label: 'Status', render: (b) => <Badge value={b.status} /> },
                  { label: 'Earning', align: 'right', render: (b) => rupees(b.driverEarning) },
                ]}
              />
            )}
          </section>
          <TransactionsCard transactions={transactions} />
        </div>
        <div className="stack">
          <section className="card">
            <dl className="facts">
              <div><dt>Phone</dt><dd>{driver.phone}</dd></div>
              <div><dt>Email</dt><dd>{driver.email || '—'}</dd></div>
              <div><dt>City</dt><dd>{driver.city?.name || '—'}</dd></div>
              <div><dt>Experience</dt><dd>{driver.experienceYears} years</dd></div>
              <div><dt>Drives</dt><dd>{driver.transmissions.map(words).join(', ')}</dd></div>
              <div><dt>Car types</dt><dd>{driver.carCategories.map(words).join(', ')}</dd></div>
              <div><dt>Languages</dt><dd>{driver.languages.join(', ') || '—'}</dd></div>
              <div><dt>Joined</dt><dd>{dateOnly(driver.createdAt)}</dd></div>
            </dl>
          </section>
          <section className="card">
            <dl className="facts">
              <div><dt>Wallet</dt><dd>{rupees(driver.walletBalance)}</dd></div>
              <div><dt>Rating</dt><dd>{driver.ratingCount ? `${driver.rating} ★ (${driver.ratingCount})` : 'No ratings'}</dd></div>
              <div><dt>Trips</dt><dd>{driver.totalTrips}</dd></div>
              <div><dt>Backed out</dt><dd>{driver.cancelledTrips}</dd></div>
            </dl>
          </section>
          <section className="card">
            <h2 style={{ marginBottom: 10 }}>Bank details</h2>
            {driver.bank?.accountNumber ? (
              <dl className="facts">
                <div><dt>Holder</dt><dd>{driver.bank.accountHolder}</dd></div>
                <div><dt>Account</dt><dd>{driver.bank.accountNumber}</dd></div>
                <div><dt>IFSC</dt><dd>{driver.bank.ifsc}</dd></div>
                {driver.bank.upiId && <div><dt>UPI</dt><dd>{driver.bank.upiId}</dd></div>}
              </dl>
            ) : <p className="muted">Not added yet</p>}
          </section>
        </div>
      </div>

      {dialog === 'wallet' && <WalletModal path={`/admin/drivers/${id}/wallet`} name={driver.name} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'suspend' && (
        <PromptModal
          title={`Suspend ${driver.name || 'driver'}`}
          label="Reason"
          confirmLabel="Suspend driver"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => { await api.patch(`/admin/drivers/${id}/status`, { status: 'suspended', reason }); await reload(); return true; }}
        />
      )}
      {dialog === 'rejectKyc' && (
        <PromptModal
          title="Reject KYC"
          label="Reason (shown to the driver)"
          confirmLabel="Reject KYC"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => { await api.post(`/admin/drivers/${id}/kyc`, { decision: 'rejected', reason }); await reload(); return true; }}
        />
      )}
    </>
  );
}
