import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ErrorBox, Spinner, rupees, useFetch, words } from '@shared/ui.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from '../client.js';

const SERIES = '#008a70';
const axis = { fontSize: 12, fill: '#6d7883' };
const shortDay = (value) => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function Tip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip"><span className="muted">{shortDay(label)}</span><strong>{format(payload[0].value)}</strong></div>;
}

const Tile = ({ label, value, hint, to, alert }) => {
  const body = <><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</>;
  const className = `tile ${alert ? 'tile-alert' : ''}`;
  return to ? <Link className={className} to={to}>{body}</Link> : <div className={className}>{body}</div>;
};

export default function Dashboard() {
  const { data, loading, error, reload } = useFetch(() => api.get('/admin/dashboard'), []);
  useRealtime(api, { 'booking:updated': () => reload({ quiet: true }) });

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const { counts, today, trend, statusMix } = data;
  const maxStatus = Math.max(...statusMix.map((row) => row.count), 1);

  return (
    <>
      <div className="page-head"><div><h1>Dashboard</h1><p>Today across all cities, updating live</p></div></div>

      <div className="tiles">
        <Tile label="Gross fares today" value={rupees(today.gross)} hint={`${today.completed} completed trips`} />
        <Tile label="Commission today" value={rupees(today.commission)} hint={`${rupees(today.driverEarnings)} to drivers`} />
        <Tile label="Active bookings" value={counts.activeBookings} to="/bookings" hint={`${today.bookings} created today`} />
        <Tile label="Drivers online" value={counts.onlineDrivers} to="/live" hint={`${counts.busyDrivers} on a booking`} />
      </div>
      <div className="tiles">
        <Tile label="Open SOS" value={counts.openSos} to="/sos" alert={counts.openSos > 0} />
        <Tile label="KYC waiting" value={counts.pendingKyc} to="/drivers?kyc=submitted" />
        <Tile label="Payouts to process" value={counts.pendingPayouts} to="/payouts" />
        <Tile label="Open tickets" value={counts.openTickets} to="/tickets" />
        <Tile label="Customers" value={counts.customers.toLocaleString('en-IN')} to="/customers" />
        <Tile label="Drivers" value={counts.drivers.toLocaleString('en-IN')} to="/drivers" />
      </div>

      <div className="charts">
        <section className="card chart-card">
          <h2>Bookings per day</h2>
          <p>Last 14 days, all statuses</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={trend} margin={{ top: 6, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#efede6" />
              <XAxis dataKey="date" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={{ stroke: '#e3e1d8' }} minTickGap={24} />
              <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: '#f5f4ef' }} content={<Tip format={(value) => `${value} bookings`} />} />
              <Bar dataKey="bookings" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </section>
        <section className="card chart-card">
          <h2>Gross fares per day</h2>
          <p>Last 14 days, completed trips only</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trend} margin={{ top: 6, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#efede6" />
              <XAxis dataKey="date" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={{ stroke: '#e3e1d8' }} minTickGap={24} />
              <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={(value) => `₹${value.toLocaleString('en-IN')}`} />
              <Tooltip cursor={{ stroke: '#6d7883' }} content={<Tip format={rupees} />} />
              <Area dataKey="gross" type="monotone" stroke={SERIES} strokeWidth={2} fill={SERIES} fillOpacity={0.12} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>All bookings by status</h2></div>
        {statusMix.length === 0 ? <p className="muted">No bookings yet.</p> : (
          <div className="mix">
            {statusMix.map((row) => (
              <div className="mix-row" key={row.status}>
                <span>{words(row.status)}</span>
                <div className="mix-bar" style={{ width: `${(row.count / maxStatus) * 100}%` }} />
                <b>{row.count.toLocaleString('en-IN')}</b>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
