# map-platform

Отдельный сервер карты для использования в нескольких проектах.

## Что внутри
- `PostGIS` (хранение геоданных)
- `Tegola` (тайлы векторной карты)
- `Nginx` (единая точка входа)

## Быстрый старт
```bash
cd map-platform
cp .env.example .env
docker compose up -d
```

Проверка:
- Health: `http://localhost:8090/health`
- Capabilities: `http://localhost:8090/capabilities`
- Tiles (пример): `http://localhost:8090/maps/delivery/{z}/{x}/{y}.pbf`

## Где деплоить
Рекомендуемо деплоить отдельно от приложений:
- VPS (Hetzner, DigitalOcean, Selectel)
- Kubernetes (если у вас уже k8s)

Минимум для прод: 2 vCPU / 4 GB RAM / SSD.

## Подключение из приложений
В приложениях используйте один URL тайл-сервера, например:
`https://maps.your-domain.com/maps/delivery/{z}/{x}/{y}.pbf`

## Что дальше
1. Добавить импорт OSM в PostGIS
2. Настроить стиль MapLibre
3. Ограничить доступ (IP/token)
4. Добавить резервное копирование БД
