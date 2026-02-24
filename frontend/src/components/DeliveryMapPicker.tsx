import { useEffect, useMemo, useRef, useState } from 'react';

type LatLng = { lat: number; lng: number };

type SearchResult = {
  displayName: string;
  lat: number;
  lng: number;
  locality?: string | null;
  street?: string | null;
  houseNumber?: string | null;
};

type Props = {
  locality: string;
  onLocalityChange: (locality: string) => void;
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

function sanitizeHouseInput(raw: string) {
  const value = raw.trim().replace(/^дом\s*/iu, '');
  if (!value) return '';
  const match = value.match(/(\d+[A-Za-zА-Яа-я\-\/]*)/u);
  return match ? match[1] : '';
}

function extractLocality(displayName: string) {
  const parts = displayName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0] || '';
  const second = parts[1] || '';
  if (/\d/.test(first) && second) return second;
  return first;
}

function extractStreet(displayName: string, locality?: string) {
  const parts = displayName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return '';

  const streetPattern = /\b(ул\.?|улица|проспект|пр-т|переулок|пер\.?|бульвар|б-р|шоссе|наб\.?|набережная|road|rd\.?|street|st\.?|avenue|ave\.?)\b/iu;
  const byMarker = parts.find((p) => streetPattern.test(p));
  if (byMarker) return byMarker;

  const localityLower = (locality || '').trim().toLowerCase();
  const filtered = parts.find((p) => p.toLowerCase() !== localityLower && p.length >= 3);
  return filtered || '';
}

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
  locality,
  onLocalityChange,
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
  const [searchError, setSearchError] = useState('');
  const [locating, setLocating] = useState(false);
  const [preciseLocating, setPreciseLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [geoPermission, setGeoPermission] = useState<'unknown' | 'granted' | 'prompt' | 'denied' | 'unsupported'>('unknown');
  const [geoAccuracy, setGeoAccuracy] = useState<number | null>(null);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [autoLocTried, setAutoLocTried] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reverseTimerRef = useRef<number | null>(null);
  const pendingCenterRef = useRef<LatLng | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const autoCityCenterRef = useRef('');

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
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
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
      }
      if (item.locality) {
        onLocalityChange(item.locality);
      } else if (item.displayName && !locality.trim()) {
        const fallbackLocality = extractLocality(item.displayName);
        if (fallbackLocality) onLocalityChange(fallbackLocality);
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

  function buildSmartQuery() {
    return [locality.trim(), address.trim(), houseNumber.trim()].filter(Boolean).join(', ');
  }

  async function searchAddress(customQuery?: string) {
    const q = (customQuery ?? query).trim();
    if (!q) return;

    setSearching(true);
    setSearchError('');
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/geocode/search?${params.toString()}`);
      if (!res.ok) {
        setResults([]);
        setSearchError('Не удалось выполнить поиск адреса.');
        return;
      }
      const data = await res.json() as { results?: SearchResult[] };
      const next = Array.isArray(data.results) ? data.results : [];
      setResults(next);
      if (!next.length) {
        setSearchError('Адрес не найден. Уточните город, улицу или номер дома.');
      }
    } catch {
      setResults([]);
      setSearchError('Сервис поиска недоступен. Попробуйте снова.');
    } finally {
      setSearching(false);
    }
  }

  function searchByFormAddress() {
    const composed = buildSmartQuery();
    if (!composed) {
      setSearchError('Введите город или улицу для поиска.');
      return;
    }
    setQuery(composed);
    void searchAddress(composed);
  }

  function setCenter(lat: number, lng: number, source: 'map' | 'external' = 'external') {
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
  }

  function choose(lat: number, lng: number, pickedAddress?: string, source: 'map' | 'external' = 'external') {
    setCenter(lat, lng, source);

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

  useEffect(() => {
    if (autoLocTried) return;
    if (location) return;
    if (geoPermission === 'denied') return;
    setAutoLocTried(true);
    detectMyLocation();
  }, [autoLocTried, location, geoPermission]);

  useEffect(() => {
    const city = locality.trim();
    if (!city) return;
    if (location) return;
    const cityKey = city.toLowerCase();
    if (autoCityCenterRef.current === cityKey) return;
    autoCityCenterRef.current = cityKey;

    void (async () => {
      try {
        const params = new URLSearchParams({ q: city });
        const res = await fetch(`/api/geocode/search?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json() as { results?: SearchResult[] };
        const first = Array.isArray(data.results) ? data.results[0] : null;
        if (!first) return;
        if (!Number.isFinite(first.lat) || !Number.isFinite(first.lng)) return;
        setCenter(first.lat, first.lng);
      } catch {
        // ignore city fallback errors
      }
    })();
  }, [locality, location]);

  useEffect(() => {
    const q = query.trim();
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }
    if (q.length < 3) {
      setResults([]);
      setSearchError('');
      return;
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchAddress();
    }, 450);
  }, [query]);

  useEffect(() => {
    const composed = buildSmartQuery();
    if (composed.length < 5) return;
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = window.setTimeout(() => {
      setQuery(composed);
      searchAddress(composed);
    }, 700);
  }, [locality, address, houseNumber]);

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
      <label>Город / населенный пункт</label>
      <div className="checkout-search">
        <input
          placeholder="Например: Худжанд"
          value={locality}
          onChange={(e) => onLocalityChange(e.target.value)}
        />
      </div>

      <label>Адрес доставки</label>
      <div className="checkout-search">
        <input
          placeholder="Улица"
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
        />
      </div>

      <div className="checkout-search">
        <input
          placeholder="Номер дома (например: 44, 44А, 12/1)"
          value={houseNumber}
          onChange={(e) => onHouseNumberChange(sanitizeHouseInput(e.target.value))}
        />
      </div>

      <div className="checkout-search">
        <input
          placeholder="Поиск адреса (от 3 символов)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void searchAddress();
            }
          }}
        />
        <button type="button" onClick={searchByFormAddress} disabled={searching}>
          {searching ? 'Ищем...' : 'Найти на карте'}
        </button>
      </div>

      <div className="checkout-search">
        <button type="button" onClick={detectMyLocation} disabled={locating}>
          {locating ? 'Определяем...' : 'Определить автоматически'}
        </button>
        <button type="button" onClick={detectMyLocationPrecise} disabled={preciseLocating}>
          {preciseLocating ? 'Уточняем...' : 'Уточнить точность'}
        </button>
      </div>

      {geoPermission !== 'granted' ? (
        <div className="checkout-search">
          <button type="button" onClick={allowGeolocation}>
            Разрешить геолокацию
          </button>
        </div>
      ) : null}

      {results.length > 0 && (
        <div className="search-results">
          {results.map((item, idx) => (
            <button
              className="search-result"
              type="button"
              key={`${item.lat}-${item.lng}-${idx}`}
              onClick={() => {
                const pickedStreet = item.street || extractStreet(item.displayName, locality);
                if (item.locality) onLocalityChange(item.locality);
                else if (!locality.trim() && item.displayName) onLocalityChange(extractLocality(item.displayName));
                if (item.houseNumber) onHouseNumberChange(sanitizeHouseInput(String(item.houseNumber)));
                choose(item.lat, item.lng, pickedStreet);
              }}
            >
              {item.displayName}
            </button>
          ))}
        </div>
      )}
      {searchError ? <div className="muted" style={{ color: '#d83434' }}>{searchError}</div> : null}

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
      {!locality.trim() ? <div className="muted" style={{ color: '#d83434' }}>Укажите город или населенный пункт.</div> : null}
      {!houseNumber.trim() ? <div className="muted" style={{ color: '#d83434' }}>Укажите номер дома для точного адреса.</div> : null}
      {geoError ? <div className="muted" style={{ color: '#d83434' }}>{geoError}</div> : null}
      <details style={{ marginTop: '10px' }}>
        <summary className="muted">Расширенные настройки точки</summary>
        <div className="checkout-search" style={{ marginTop: '8px' }}>
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
          <button type="button" onClick={applyManualPoint}>Применить</button>
        </div>
      </details>
    </div>
  );
}
