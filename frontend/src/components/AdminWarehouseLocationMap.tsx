import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type WarehousePoint = {
  id: number;
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
};

type Props = {
  warehouses: WarehousePoint[];
  selectedWarehouseId: number;
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
};

const DEFAULT_CENTER: [number, number] = [38.559772, 68.787038];
const PICK_ICON = L.divIcon({
  className: 'warehouse-pick-marker',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#0f8f59;border:2px solid #fff;box-shadow:0 0 0 2px #122036;"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7]
});

function MapPickerEvents({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    }
  });
  return null;
}

function MapCenterSync({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom, { animate: true });
  }, [map, center, zoom]);
  return null;
}

export default function AdminWarehouseLocationMap({
  warehouses,
  selectedWarehouseId,
  lat,
  lng,
  onPick
}: Props) {
  const selectedPoint = Number.isFinite(lat) && Number.isFinite(lng) ? [lat as number, lng as number] as [number, number] : null;
  const center = selectedPoint || DEFAULT_CENTER;
  const zoom = selectedPoint ? 14 : 11;
  const warehouseMarkers = useMemo(
    () => warehouses.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng)),
    [warehouses]
  );

  return (
    <MapContainer center={center} zoom={zoom} className="admin-warehouse-map">
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapCenterSync center={center} zoom={zoom} />
      <MapPickerEvents onPick={onPick} />
      {warehouseMarkers.map((item) => {
        const isSelected = Number(item.id) === Number(selectedWarehouseId);
        return (
          <CircleMarker
            key={item.id}
            center={[item.lat as number, item.lng as number]}
            radius={isSelected ? 8 : 6}
            pathOptions={{
              color: '#122036',
              weight: 2,
              fillColor: isSelected ? '#0f8f59' : '#d83434',
              fillOpacity: 0.95
            }}
          />
        );
      })}
      {selectedPoint ? (
        <Marker
          position={selectedPoint}
          icon={PICK_ICON}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const next = (e.target as L.Marker).getLatLng();
              onPick(next.lat, next.lng);
            }
          }}
        />
      ) : null}
    </MapContainer>
  );
}
