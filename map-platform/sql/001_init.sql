CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS public.delivery_zones (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.warehouses (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.delivery_zone_tariffs (
  zone_name TEXT PRIMARY KEY,
  base_fee NUMERIC(12,2) NOT NULL DEFAULT 1.50,
  per_km_fee NUMERIC(12,2) NOT NULL DEFAULT 0.35,
  min_fee NUMERIC(12,2) NOT NULL DEFAULT 1.50,
  max_fee NUMERIC(12,2) NOT NULL DEFAULT 25.00,
  eta_base_min INTEGER NOT NULL DEFAULT 20,
  eta_per_km_min NUMERIC(12,2) NOT NULL DEFAULT 5.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_geom ON public.delivery_zones USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_warehouses_geom ON public.warehouses USING GIST (geom);

INSERT INTO public.delivery_zones (name, geom)
SELECT 'Душанбе', ST_GeomFromText('POLYGON((68.718 38.607,68.792 38.628,68.86 38.596,68.884 38.542,68.835 38.5,68.748 38.506,68.704 38.548,68.718 38.607))', 4326)
WHERE NOT EXISTS (SELECT 1 FROM public.delivery_zones WHERE name = 'Душанбе');

INSERT INTO public.delivery_zone_tariffs (zone_name, base_fee, per_km_fee, min_fee, max_fee, eta_base_min, eta_per_km_min, is_active)
SELECT 'Душанбе', 1.50, 0.35, 1.50, 25.00, 20, 5.00, TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.delivery_zone_tariffs WHERE zone_name = 'Душанбе');

INSERT INTO public.warehouses (name, geom)
SELECT 'Склад Душанбе', ST_SetSRID(ST_MakePoint(68.7878, 38.5702), 4326)
WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Склад Душанбе');

INSERT INTO public.warehouses (name, geom)
SELECT 'Склад Худжанд', ST_SetSRID(ST_MakePoint(69.6203, 40.2891), 4326)
WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Склад Худжанд');

INSERT INTO public.warehouses (name, geom)
SELECT 'Склад Хистеварз', ST_SetSRID(ST_MakePoint(69.8174, 40.1992), 4326)
WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Склад Хистеварз');
