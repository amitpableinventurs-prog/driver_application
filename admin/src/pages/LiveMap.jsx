import { useEffect, useMemo, useState } from 'react';
import { ErrorBox, Spinner, dateTime, useFetch } from '@shared/ui.jsx';
import { MapView } from '@shared/map.jsx';
import { useRealtime } from '@shared/realtime.js';
import { api } from '../client.js';

const toMarker = (driver) => ({
  id: driver._id,
  lat: driver.location.coordinates[1],
  lng: driver.location.coordinates[0],
  kind: driver.activeBooking ? 'busy' : 'driver',
  popup: `${driver.name || 'Driver'} · ${driver.phone}`,
});

export default function LiveMap() {
  const { data, loading, error, reload } = useFetch(() => api.get('/admin/drivers/live'), []);
  const [drivers, setDrivers] = useState([]);

  useEffect(() => { if (data) setDrivers(data); }, [data]);
  useEffect(() => {
    const timer = setInterval(() => reload({ quiet: true }), 30000);
    return () => clearInterval(timer);
  }, [reload]);

  useRealtime(api, {
    'driver:location': (event) => setDrivers((list) => list.map((driver) => (
      driver._id === event.driverId
        ? { ...driver, location: { type: 'Point', coordinates: [event.lng, event.lat] }, locationUpdatedAt: event.at }
        : driver
    ))),
  });

  const markers = useMemo(() => drivers.map(toMarker), [drivers]);
  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;

  const busy = drivers.filter((driver) => driver.activeBooking).length;
  const center = markers.length ? [markers[0].lat, markers[0].lng] : [22.7196, 75.8577];

  return (
    <>
      <div className="page-head">
        <div><h1>Live map</h1><p>{drivers.length} drivers online: {drivers.length - busy} free, {busy} on a booking</p></div>
        <div className="row small">
          <span className="row"><span className="map-pin map-pin-driver" style={{ width: 16, height: 16 }} /> Free</span>
          <span className="row"><span className="map-pin map-pin-busy" style={{ width: 16, height: 16 }} /> On a booking</span>
        </div>
      </div>
      <MapView center={center} zoom={11} markers={markers} fitMarkers height={560} />
      {drivers.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Last update {dateTime(drivers.reduce((latest, driver) => (driver.locationUpdatedAt > latest ? driver.locationUpdatedAt : latest), ''))}
        </p>
      )}
    </>
  );
}
