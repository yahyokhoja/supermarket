import { useEffect, useMemo, useRef, useState } from 'react';
import { DELIVERY_ZONE_DUSHANBE, WAREHOUSE_POINTS } from '../config/mapLayers';

type LatLng = { lat: number; lng: number };

type SearchResult = {
  displayName: string;
  lat: number;
  lng: number;
  locality?: string | null;
  street?: string | null;
  houseNumber?: string | null;
};
type HouseSuggestion = {
  house: string;
  lat: number;
  lng: number;
  displayName: string;
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

const DEFAULT_CENTER: LatLng = { lat: 38.559772, lng: 68.787038 };
const TAJIKISTAN_HINT = 'Таджикистан';
const YANDEX_MAPS_API_KEY = (import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined)?.trim() || '';
const MAP_PLATFORM_URL = (import.meta.env.VITE_MAP_PLATFORM_URL as string | undefined)?.trim() || 'http://localhost:8090';
const TAJIK_CITY_PRESETS: Array<{ label: string; point: LatLng }> = [
  { label: 'Душанбе', point: { lat: 38.559772, lng: 68.787038 } },
  { label: 'Худжанд', point: { lat: 40.28256, lng: 69.62216 } },
  { label: 'Бохтар', point: { lat: 37.8331, lng: 68.77905 } },
  { label: 'Куляб', point: { lat: 37.91459, lng: 69.78454 } }
];
const MESSAGE_TYPE = 'delivery-map-click';
const MESSAGE_SET_CENTER = 'delivery-map-set-center';

function canUseGeolocationNow() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

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

function extractHouseFromDisplayName(displayName: string) {
  const parts = displayName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const marker = parts.find((p) => /\b(дом|д\.|house|№)\b/iu.test(p));
  const fromMarker = marker ? sanitizeHouseInput(marker) : '';
  if (fromMarker) return fromMarker;
  const shortNumericPart = parts.find((p) => {
    const candidate = sanitizeHouseInput(p);
    return Boolean(candidate) && candidate.length <= 5;
  });
  if (shortNumericPart) return sanitizeHouseInput(shortNumericPart);
  return sanitizeHouseInput(displayName);
}

function pointScore(lat: number, lng: number, item: SearchResult) {
  return Math.abs(item.lat - lat) + Math.abs(item.lng - lng);
}

function mapFrameHtml(yandexApiKey: string, mapPlatformUrl: string) {
  const warehousesJson = JSON.stringify(WAREHOUSE_POINTS);
  const zoneJson = JSON.stringify(DELIVERY_ZONE_DUSHANBE);
  const centerJson = JSON.stringify([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]);
  const apiKeyJson = JSON.stringify(yandexApiKey || '');
  const mapPlatformUrlJson = JSON.stringify(mapPlatformUrl || '');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    html, body, #map { margin: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const center = ${centerJson};
    const warehouses = ${warehousesJson};
    const zonePoints = ${zoneJson};
    const yandexApiKey = ${apiKeyJson};
    const mapPlatformBase = (${mapPlatformUrlJson} || '').replace(/\\/+$/, '');

    function setupLeafletFallback() {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = function() {
        const map = L.map('map').setView(center, 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        let staticOverlayAdded = false;
        function addStaticOverlay() {
          if (staticOverlayAdded) return;
          staticOverlayAdded = true;
          const deliveryZone = L.polygon(zonePoints, {
            color: '#0f8f59',
            fillColor: '#0f8f59',
            fillOpacity: 0.12,
            weight: 2
          }).addTo(map);
          deliveryZone.bindPopup('Зона доставки');

          for (const item of warehouses) {
            const marker = L.circleMarker([item.lat, item.lng], {
              radius: 7,
              color: '#122036',
              fillColor: '#d83434',
              fillOpacity: 0.95,
              weight: 2
            }).addTo(map);
            marker.bindPopup(item.name);
          }
        }

        function addMapPlatformVectorOverlay() {
          if (!mapPlatformBase) {
            addStaticOverlay();
            return;
          }

          const vectorScript = document.createElement('script');
          vectorScript.src = 'https://unpkg.com/leaflet.vectorgrid@1.3.0/dist/Leaflet.VectorGrid.bundled.js';
          vectorScript.onload = function() {
            try {
              if (!L.vectorGrid || !L.vectorGrid.protobuf) {
                addStaticOverlay();
                return;
              }

              const vectorLayer = L.vectorGrid.protobuf(mapPlatformBase + '/maps/delivery/{z}/{x}/{y}.pbf', {
                vectorTileLayerStyles: {
                  delivery_zones: {
                    fill: true,
                    fillColor: '#0f8f59',
                    fillOpacity: 0.12,
                    color: '#0f8f59',
                    weight: 2
                  },
                  warehouses: {
                    radius: 7,
                    fill: true,
                    fillColor: '#d83434',
                    fillOpacity: 0.95,
                    color: '#122036',
                    weight: 2
                  }
                },
                interactive: true,
                maxZoom: 22
              }).addTo(map);

              vectorLayer.on('tileerror', function() {
                addStaticOverlay();
              });
            } catch (_error) {
              addStaticOverlay();
            }
          };
          vectorScript.onerror = addStaticOverlay;
          document.body.appendChild(vectorScript);
        }

        addMapPlatformVectorOverlay();

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
      };
      document.body.appendChild(script);
    }

    function setupYandexMap() {
      const script = document.createElement('script');
      script.src = 'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(yandexApiKey) + '&lang=ru_RU';
      script.onload = function() {
        ymaps.ready(function() {
          const map = new ymaps.Map('map', {
            center: center,
            zoom: 14,
            controls: []
          });

          const zone = new ymaps.Polygon(
            [zonePoints],
            { hintContent: 'Зона доставки' },
            {
              fillColor: 'rgba(15,143,89,0.16)',
              strokeColor: '#0f8f59',
              strokeWidth: 2,
              interactivityModel: 'default#transparent'
            }
          );
          map.geoObjects.add(zone);

          for (const item of warehouses) {
            const placemark = new ymaps.Placemark(
              [item.lat, item.lng],
              { balloonContent: item.name, hintContent: item.name },
              { preset: 'islands#redDotIcon' }
            );
            map.geoObjects.add(placemark);
          }

          function publishCenter() {
            const c = map.getCenter();
            window.parent.postMessage({ type: '${MESSAGE_TYPE}', lat: c[0], lng: c[1] }, '*');
          }

          map.events.add('boundschange', publishCenter);
          setTimeout(publishCenter, 0);

          window.addEventListener('message', function(event) {
            const payload = event.data || {};
            if (payload.type !== '${MESSAGE_SET_CENTER}') return;
            if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
            map.setCenter([payload.lat, payload.lng], map.getZoom(), { duration: 250 });
          });
        });
      };
      script.onerror = setupLeafletFallback;
      document.body.appendChild(script);
    }

    if (yandexApiKey) setupYandexMap();
    else setupLeafletFallback();
  </script>
</body>
</html>`;
}

function withTajikistanHint(rawQuery: string) {
  const q = rawQuery.trim();
  if (!q) return '';
  if (/(таджикистан|tajikistan)/iu.test(q)) return q;
  return `${q}, ${TAJIKISTAN_HINT}`;
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
  const [houseSuggestLoading, setHouseSuggestLoading] = useState(false);
  const [houseSuggestions, setHouseSuggestions] = useState<HouseSuggestion[]>([]);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [preciseLocating, setPreciseLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [geoPermission, setGeoPermission] = useState<'unknown' | 'granted' | 'prompt' | 'denied' | 'unsupported'>('unknown');
  const [geoAccuracy, setGeoAccuracy] = useState<number | null>(null);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [detectedAddress, setDetectedAddress] = useState('');
  const [autoLocTried, setAutoLocTried] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reverseTimerRef = useRef<number | null>(null);
  const pendingCenterRef = useRef<LatLng | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const houseSuggestTimerRef = useRef<number | null>(null);
  const autoCityCenterRef = useRef('');

  const center = location || DEFAULT_CENTER;
  const frameHtml = useMemo(() => mapFrameHtml(YANDEX_MAPS_API_KEY, MAP_PLATFORM_URL), []);

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
      if (houseSuggestTimerRef.current) {
        window.clearTimeout(houseSuggestTimerRef.current);
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

  async function reverseGeocode(lat: number, lng: number, showLoading = false) {
    if (showLoading) {
      setReverseLoading(true);
    }
    try {
      const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
      const res = await fetch(`/api/geocode/reverse?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as { result?: SearchResult | null };
      const item = data?.result;
      if (!item) return;

      const nextLocality = (item.locality || '').trim() || extractLocality(item.displayName || '');
      const nextStreet = (item.street || '').trim() || extractStreet(item.displayName || '', nextLocality || locality);
      let nextHouse = sanitizeHouseInput(String(item.houseNumber || '')) || extractHouseFromDisplayName(item.displayName || '');

      // Fallback: when reverse geocode has no house number, try nearest forward-search candidate on same street.
      if (!nextHouse && nextStreet) {
        const q = withTajikistanHint([nextLocality, nextStreet].filter(Boolean).join(', '));
        const searchParams = new URLSearchParams({ q });
        const searchRes = await fetch(`/api/geocode/search?${searchParams.toString()}`);
        if (searchRes.ok) {
          const searchData = await searchRes.json() as { results?: SearchResult[] };
          const list = Array.isArray(searchData.results) ? searchData.results : [];
          const byStreet = list.filter((r) => {
            const street = (r.street || extractStreet(r.displayName || '', nextLocality)).toLowerCase();
            return Boolean(street) && street.includes(nextStreet.toLowerCase());
          });
          const source = byStreet.length ? byStreet : list;
          const nearest = source
            .map((r) => ({ r, score: pointScore(lat, lng, r) }))
            .sort((a, b) => a.score - b.score)[0]?.r;
          if (nearest) {
            nextHouse = sanitizeHouseInput(String(nearest.houseNumber || '')) || extractHouseFromDisplayName(nearest.displayName || '');
          }
        }
      }

      if (nextLocality) onLocalityChange(nextLocality);
      if (nextStreet) onAddressChange(nextStreet);
      if (nextHouse) onHouseNumberChange(nextHouse);
      if (item.displayName) setDetectedAddress(item.displayName);
    } catch {
      if (showLoading) {
        setGeoError('Не удалось обновить адрес. Попробуйте еще раз.');
      }
    } finally {
      if (showLoading) {
        setReverseLoading(false);
      }
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
    const q = withTajikistanHint(customQuery ?? query);
    if (!q.trim()) return;

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

    if (!canUseGeolocationNow()) {
      const host = typeof window !== 'undefined' ? window.location.host : '';
      setGeoError(`Геолокация требует HTTPS или localhost. Текущий адрес: ${host || 'unknown'}`);
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
        const params = new URLSearchParams({ q: withTajikistanHint(city) });
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
    const city = locality.trim();
    const street = address.trim();
    if (houseSuggestTimerRef.current) {
      window.clearTimeout(houseSuggestTimerRef.current);
    }
    if (city.length < 2 || street.length < 3) {
      setHouseSuggestions([]);
      setHouseSuggestLoading(false);
      return;
    }

    houseSuggestTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setHouseSuggestLoading(true);
        try {
          const params = new URLSearchParams({ q: withTajikistanHint(`${city}, ${street}`) });
          const res = await fetch(`/api/geocode/search?${params.toString()}`);
          if (!res.ok) {
            setHouseSuggestions([]);
            return;
          }
          const data = await res.json() as { results?: SearchResult[] };
          const list = Array.isArray(data.results) ? data.results : [];
          const seen = new Set<string>();
          const suggestions: HouseSuggestion[] = [];
          for (const item of list) {
            const house = sanitizeHouseInput(String(item.houseNumber || '')) || extractHouseFromDisplayName(item.displayName || '');
            if (!house) continue;
            const key = house.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            suggestions.push({
              house,
              lat: item.lat,
              lng: item.lng,
              displayName: item.displayName || ''
            });
          }
          const ranked = location
            ? suggestions
                .map((item) => ({
                  item,
                  score: Math.abs(item.lat - location.lat) + Math.abs(item.lng - location.lng)
                }))
                .sort((a, b) => a.score - b.score)
                .map((entry) => entry.item)
            : suggestions;
          setHouseSuggestions(ranked.slice(0, 8));
        } catch {
          setHouseSuggestions([]);
        } finally {
          setHouseSuggestLoading(false);
        }
      })();
    }, 420);
  }, [locality, address, location]);

  useEffect(() => {
    if (houseNumber.trim()) return;
    if (!houseSuggestions.length) return;
    const nearest = houseSuggestions[0];
    if (!nearest?.house) return;
    onHouseNumberChange(nearest.house);
    if (!detectedAddress && nearest.displayName) {
      setDetectedAddress(nearest.displayName);
    }
  }, [houseSuggestions, houseNumber, detectedAddress, onHouseNumberChange]);

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
    if (!canUseGeolocationNow()) {
      const host = typeof window !== 'undefined' ? window.location.host : '';
      setGeoError(`Геолокация требует HTTPS или localhost. Текущий адрес: ${host || 'unknown'}`);
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

  function handleLocationButton() {
    if (locating || preciseLocating || reverseLoading) return;
    setGeoError('');

    // Если точка уже выбрана – просто обновим адрес по этой точке.
    if (location) {
      void reverseGeocode(location.lat, location.lng, true);
      return;
    }

    if (geoPermission === 'denied') {
      setGeoError('Разрешите геолокацию в браузере: иконка замка у адреса сайта -> Местоположение -> Разрешить, затем обновите страницу.');
      return;
    }

    // Сначала быстрая геолокация; если браузер решит точность низкая, fallback на точную.
    detectMyLocation();
    // Параллельно попробуем более точное позиционирование (не блокирует UI).
    detectMyLocationPrecise();
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
      {houseSuggestLoading ? <div className="muted">Ищем ближайшие номера домов...</div> : null}
      {!houseSuggestLoading && houseSuggestions.length > 0 ? (
        <div className="inline-actions house-suggestions">
          {houseSuggestions.map((item) => (
            <button
              key={`${item.house}-${item.lat}-${item.lng}`}
              type="button"
              onClick={() => {
                onHouseNumberChange(item.house);
                if (item.displayName) setDetectedAddress(item.displayName);
                choose(item.lat, item.lng, address.trim() || undefined);
              }}
            >
              дом {item.house}
            </button>
          ))}
        </div>
      ) : null}

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

      <div className="map-tools">
        <button
          type="button"
          onClick={handleLocationButton}
          disabled={locating || preciseLocating || reverseLoading}
        >
          {locating || preciseLocating || reverseLoading ? 'Определяем...' : 'Местоположение'}
        </button>
      </div>

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
                const pickedHouse =
                  sanitizeHouseInput(String(item.houseNumber || '')) || extractHouseFromDisplayName(item.displayName || '');
                if (pickedHouse) onHouseNumberChange(pickedHouse);
                if (item.displayName) setDetectedAddress(item.displayName);
                choose(item.lat, item.lng, pickedStreet);
              }}
            >
              {item.displayName}
            </button>
          ))}
        </div>
      )}
      {searchError ? <div className="map-error">{searchError}</div> : null}

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

      <div className="map-status">
        <div className="muted map-hint">
          Карта ориентирована на Таджикистан. Метка фиксирована в центре: двигайте карту, чтобы выбрать точку.
        </div>
        <div className="muted">
          Координаты: {location ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}` : 'не выбраны'}
          {geoAccuracy ? ` (точность ~${Math.round(geoAccuracy)} м)` : ''}
        </div>
        {detectedAddress ? <div className="muted">Определенный адрес: {detectedAddress}</div> : null}
      </div>

      {!locality.trim() ? <div className="map-error">Укажите город или населенный пункт.</div> : null}
      {!houseNumber.trim() ? <div className="map-error">Укажите номер дома для точного адреса.</div> : null}
      {geoError ? <div className="map-error">{geoError}</div> : null}
    </div>
  );
}
