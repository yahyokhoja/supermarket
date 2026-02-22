import { useEffect, useMemo, useRef, useState } from 'react';

type LatLng = { lat: number; lng: number };

type SearchResult = {
  displayName: string;
  lat: number;
  lng: number;
  street?: string | null;
  houseNumber?: string | null;
};

type Props = {
  address: string;
  onAddressChange: (address: string) => void;
  houseNumber: string;
  onHouseNumberChange: (house: string) => void;
  location: LatLng | null;
  onLocationChange: (location: LatLng | null) => void;
};

const DEFAULT_CENTER: LatLng = { lat: 55.751244, lng: 37.618423 };
const MESSAGE_TYPE = 'delivery-map-click';
const MESSAGE_SET_CENTER = 'delivery-map-set-center';

function mapFrameHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { margin: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const center = [${DEFAULT_CENTER.lat}, ${DEFAULT_CENTER.lng}];
    const map = L.map('map').setView(center, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    function publishCenter() {
      const c = map.getCenter();
      window.parent.postMessage({ type: '${MESSAGE_TYPE}', lat: c.lat, lng: c.lng }, '*');
    }

    map.on('moveend', publishCenter);
    setTimeout(publishCenter, 0);

    window.addEventListener('message', function(event) {
      const payload = event.data || {};
      if (payload.type !== '${MESSAGE_SET_CENTER}') return;
      if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
      map.setView([payload.lat, payload.lng], map.getZoom(), { animate: true });
    });
  </script>
</body>
</html>`;
}

export default function DeliveryMapPicker({
  address,
  onAddressChange,
  houseNumber,
  onHouseNumberChange,
  location,
  onLocationChange
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [preciseLocating, setPreciseLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [geoPermission, setGeoPermission] = useState<'unknown' | 'granted' | 'prompt' | 'denied' | 'unsupported'>('unknown');
  const [geoAccuracy, setGeoAccuracy] = useState<number | null>(null);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reverseTimerRef = useRef<number | null>(null);
  const pendingCenterRef = useRef<LatLng | null>(null);

  const center = location || DEFAULT_CENTER;
  const frameHtml = useMemo(() => mapFrameHtml(), []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const payload = event.data as { type?: string; lat?: number; lng?: number } | null;
      if (!payload || payload.type !== MESSAGE_TYPE) return;
      if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
      choose(payload.lat, payload.lng, undefined, 'map');
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    return () => {
      if (reverseTimerRef.current) {
        window.clearTimeout(reverseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!('permissions' in navigator) || !navigator.permissions?.query) {
      setGeoPermission('unsupported');
      return;
    }

    let mounted = true;
    let statusRef: PermissionStatus | null = null;

    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        if (!mounted) return;
        statusRef = status;
        setGeoPermission(status.state as 'granted' | 'prompt' | 'denied');
        status.onchange = () => {
          setGeoPermission(status.state as 'granted' | 'prompt' | 'denied');
        };
      })
      .catch(() => {
        setGeoPermission('unsupported');
      });

    return () => {
      mounted = false;
      if (statusRef) statusRef.onchange = null;
    };
  }, []);

  async function reverseGeocode(lat: number, lng: number) {
    try {
      const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
      const res = await fetch(`/api/geocode/reverse?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as { result?: SearchResult | null };
      const item = data?.result;
      if (!item) return;

      if (item.street) {
        onAddressChange(item.street);
      } else if (item.displayName) {
        onAddressChange(item.displayName);
      }

      if (item.houseNumber && !houseNumber.trim()) {
        onHouseNumberChange(String(item.houseNumber));
      }
    } catch {
      // silent fallback: coordinates still set, user can fill address manually
    }
  }

  function scheduleReverseGeocode(lat: number, lng: number) {
    if (reverseTimerRef.current) {
      window.clearTimeout(reverseTimerRef.current);
    }
    reverseTimerRef.current = window.setTimeout(() => {
      reverseGeocode(lat, lng);
    }, 350);
  }

  async function searchAddress() {
    const q = query.trim();
    if (!q) return;

    setSearching(true);
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/geocode/search?${params.toString()}`);
      if (!res.ok) {
        setResults([]);
        return;
      }
      const data = await res.json() as { results?: SearchResult[] };
      setResults(Array.isArray(data.results) ? data.results : []);
    } finally {
      setSearching(false);
    }
  }

  function choose(lat: number, lng: number, pickedAddress?: string, source: 'map' | 'external' = 'external') {
    onLocationChange({ lat, lng });
    setManualLat(lat.toFixed(6));
    setManualLng(lng.toFixed(6));
    setGeoError('');

    if (source === 'external') {
      const target = iframeRef.current?.contentWindow;
      if (target) {
        target.postMessage({ type: MESSAGE_SET_CENTER, lat, lng }, '*');
      } else {
        pendingCenterRef.current = { lat, lng };
      }
    }

    if (pickedAddress) {
      onAddressChange(pickedAddress);
    } else {
      scheduleReverseGeocode(lat, lng);
    }
  }

  function applyManualPoint() {
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setGeoError('Введите корректные координаты: широта [-90..90], долгота [-180..180].');
      return;
    }
    choose(lat, lng);
  }

  function detectMyLocation() {
    if (!navigator.geolocation) {
      setGeoError('Ваш браузер не поддерживает геолокацию.');
      return;
    }

    if (!window.isSecureContext) {
      setGeoError('Геолокация требует защищенный контекст: откройте сайт по HTTPS или localhost.');
      return;
    }

    setLocating(true);
    setGeoError('');

    const tryLocate = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          setGeoAccuracy(Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null);
          choose(lat, lng);
          setLocating(false);
        },
        (error) => {
          if (error.code === 1) setGeoError('Доступ к геолокации запрещен. Разрешите доступ к местоположению в браузере.');
          else if (error.code === 2) setGeoError('Не удалось определить местоположение. Проверьте интернет/GPS.');
          else if (error.code === 3) setGeoError('Превышено время ожидания геолокации.');
          else setGeoError('Ошибка геолокации.');
          setLocating(false);
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    };

    if ('permissions' in navigator && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((result) => {
          if (result.state === 'denied') {
            setGeoPermission('denied');
            setGeoError('Геолокация заблокирована в браузере. Разрешите доступ к местоположению для этого сайта.');
            setLocating(false);
            return;
          }
          tryLocate();
        })
        .catch(() => {
          tryLocate();
        });
      return;
    }

    tryLocate();
  }

  function detectMyLocationPrecise() {
    if (!navigator.geolocation) {
      setGeoError('Ваш браузер не поддерживает геолокацию.');
      return;
    }
    if (!window.isSecureContext) {
      setGeoError('Геолокация требует защищенный контекст: откройте сайт по HTTPS или localhost.');
      return;
    }

    setPreciseLocating(true);
    setGeoError('');

    let best: GeolocationPosition | null = null;
    const start = Date.now();
    const timeoutMs = 12000;

    const watcher = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) {
          best = pos;
          setGeoAccuracy(pos.coords.accuracy);
          choose(pos.coords.latitude, pos.coords.longitude);
        }

        if (pos.coords.accuracy <= 25 || Date.now() - start > timeoutMs) {
          navigator.geolocation.clearWatch(watcher);
          setPreciseLocating(false);
        }
      },
      (error) => {
        navigator.geolocation.clearWatch(watcher);
        if (error.code === 1) setGeoError('Доступ к геолокации запрещен. Разрешите доступ к местоположению в браузере.');
        else if (error.code === 2) setGeoError('Не удалось определить местоположение. Проверьте интернет/GPS.');
        else if (error.code === 3) setGeoError('Превышено время ожидания геолокации.');
        else setGeoError('Ошибка геолокации.');
        setPreciseLocating(false);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );

    window.setTimeout(() => {
      navigator.geolocation.clearWatch(watcher);
      setPreciseLocating(false);
    }, timeoutMs + 1000);
  }

  function allowGeolocation() {
    if (geoPermission === 'denied') {
      setGeoError('Разрешите геолокацию в браузере: иконка замка у адреса сайта -> Местоположение -> Разрешить, затем обновите страницу.');
      return;
    }
    detectMyLocation();
  }

  function handleMapLoad() {
    if (!pendingCenterRef.current) return;
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage(
      { type: MESSAGE_SET_CENTER, lat: pendingCenterRef.current.lat, lng: pendingCenterRef.current.lng },
      '*'
    );
    pendingCenterRef.current = null;
  }

  return (
    <div className="map-picker">
      <label>Адрес доставки</label>
      <div className="checkout-search">
        <input
          placeholder="Введите адрес доставки"
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
        />
      </div>

      <div className="checkout-search">
        <input
          placeholder="Номер дома (обязательно)"
          value={houseNumber}
          onChange={(e) => onHouseNumberChange(e.target.value)}
        />
      </div>

      <div className="checkout-search">
        <input
          placeholder="Поиск адреса"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={searchAddress} disabled={searching}>
          {searching ? 'Поиск...' : 'Найти'}
        </button>
      </div>

      <div className="checkout-search">
        {geoPermission !== 'granted' ? (
          <button type="button" onClick={allowGeolocation}>
            Разрешить геолокацию
          </button>
        ) : null}
      </div>

      <div className="checkout-search">
        <button type="button" onClick={detectMyLocation} disabled={locating}>
          {locating ? 'Определяем...' : 'Мое местоположение'}
        </button>
        <button type="button" onClick={detectMyLocationPrecise} disabled={preciseLocating}>
          {preciseLocating ? 'Уточняем...' : 'Точное местоположение'}
        </button>
      </div>

      <div className="checkout-search">
        <input
          placeholder="Широта"
          value={manualLat}
          onChange={(e) => setManualLat(e.target.value)}
        />
        <input
          placeholder="Долгота"
          value={manualLng}
          onChange={(e) => setManualLng(e.target.value)}
        />
        <button type="button" onClick={applyManualPoint}>Поставить метку</button>
      </div>

      {results.length > 0 && (
        <div className="search-results">
          {results.map((item, idx) => (
            <button
              className="search-result"
              type="button"
              key={`${item.lat}-${item.lng}-${idx}`}
              onClick={() => choose(item.lat, item.lng, item.street || item.displayName)}
            >
              {item.displayName}
            </button>
          ))}
        </div>
      )}

      <div className="map-frame-wrap">
        <iframe
          ref={iframeRef}
          onLoad={handleMapLoad}
          title="Карта доставки"
          className="delivery-map"
          srcDoc={frameHtml}
        />
        <div className="map-center-pin" aria-hidden>+</div>
      </div>

      <div className="muted map-hint">
        Метка фиксирована в центре. Двигайте карту, чтобы выбрать точку. Точка доставки: {location ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}` : 'не выбрана'}.
      </div>
      {geoAccuracy !== null ? <div className="muted">Точность геолокации: около {Math.round(geoAccuracy)} м.</div> : null}
      {!houseNumber.trim() ? <div className="muted" style={{ color: '#d83434' }}>Укажите номер дома для точного адреса.</div> : null}
      {geoError ? <div className="muted" style={{ color: '#d83434' }}>{geoError}</div> : null}
    </div>
  );
}
