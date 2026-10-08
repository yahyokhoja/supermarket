# Матрица доступа активного контура

| API | Роли | Проверка области | Интеграционная проверка |
|---|---|---|---|
| `/api/admin/network/stores` | owner: запись; owner/admin: чтение | `accessibleStoreIds`; архивный магазин admin не выдаётся | API-сценарий двух магазинов |
| `/api/admin/network/assignments` | owner | роль на сервере; активная уникальная связь | назначение, повтор, отзыв с действующим JWT |
| `/api/admin/network/mapping/*` | owner | legacy-склад, активный target store, блокировка конфликтующих transfer | preview/confirm и идемпотентность |
| `/api/admin/network/stores/:id/products/*` | owner/admin с `manage_products` | актуальное назначение к store | независимые строки `store_product_settings` |
| `/api/admin/warehouse/*` | owner/admin с `manage_warehouse` | warehouse IDs из актуальных store-назначений | scoped warehouse tests |
| `/api/admin/inventory/documents/*` | owner/admin с `manage_warehouse` | оба склада; для записи склад сопоставлен и магазин активен | документные и transfer tests |
| `/api/admin/inventory/reservations/*` | owner/admin с `manage_warehouse` | склад резерва | reservation tests |
| `/api/admin/suppliers` | чтение owner/admin; запись owner | документы поставщика возвращаются только отдельными scoped endpoint | role checks |
| `/api/admin/network/report` | owner/admin с правом отчёта | только разрешённые warehouse IDs | scoped report HTTP-check |
| `/api/admin/audit-logs` | owner | owner-only | role check |
| `/api/admin/legacy-orders/*` | owner | owner-only, только GET | owner 200/admin 403 |
| `/api/auth/register`, `/api/cart*`, `/api/couriers*`, delivery/order mutation | никто | отключены | HTTP 410 tests |

`NULL business_store_id` не даёт admin доступ: такой склад отсутствует в `accessibleWarehouseIds`. Owner может читать его для перехода, но `assertWarehouseOperation` запрещает новые документы и изменения до подтверждённого сопоставления.
