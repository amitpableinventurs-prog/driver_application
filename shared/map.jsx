import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const pin = (kind, label = '') => L.divIcon({
  className: '',
  html: `<span class="map-pin map-pin-${kind}">${label}</span>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

/**
 * Leaflet map with OpenStreetMap tiles, so no API key is needed.
 * markers: [{ id, lat, lng, kind: 'pickup'|'drop'|'driver'|'busy', label, popup }]
 */
export function MapView({ center, zoom = 12, markers = [], onPick, fitMarkers = false, height = 320 }) {
  const holder = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const pickHandler = useRef(onPick);
  pickHandler.current = onPick;

  useEffect(() => {
    map.current = L.map(holder.current, { attributionControl: true }).setView(center, zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    map.current.on('click', (event) => pickHandler.current?.({ lat: event.latlng.lat, lng: event.latlng.lng }));
    return () => { map.current.remove(); map.current = null; };
    // The map is created once; center changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const centerKey = center.join(',');
  useEffect(() => { map.current?.setView(center, map.current.getZoom()); }, [centerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    layer.current.clearLayers();
    markers.forEach((marker) => {
      const item = L.marker([marker.lat, marker.lng], { icon: pin(marker.kind, marker.label) });
      if (marker.popup) item.bindPopup(marker.popup);
      item.addTo(layer.current);
    });
    if (fitMarkers && markers.length > 1) {
      map.current.fitBounds(L.latLngBounds(markers.map((marker) => [marker.lat, marker.lng])).pad(0.3), { animate: false });
    }
  }, [markers, fitMarkers]);

  return <div ref={holder} className="map" style={{ height }} />;
}

export const toLatLng = (place) => (place?.location?.coordinates
  ? { lng: place.location.coordinates[0], lat: place.location.coordinates[1] }
  : null);
