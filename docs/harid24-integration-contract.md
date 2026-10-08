# HARID24 integration foundation

This document describes a future integration contract. No HARID24 API connection is implemented in stage 1.

## Ownership and scope

- A connection belongs to one local `company_id` and `store_id` and references one HARID24 `sales_point_id`.
- `harid24_product_links` maps a local product to one external product inside a connection.
- External identifiers are unique inside the connection. Names are never identity keys.
- `field_sources` records whether each synchronized field is controlled by `local`, `harid24`, or `manual` policy.
- Until company/store scopes are propagated through all legacy tables, the existing application is not fully tenant-isolated.

## Catalog import workflow

1. Authenticate the owner and verify access to the requested HARID24 sales point.
2. Download into an import preview without changing local products or stock.
3. Match explicit existing links first. Barcode is only a candidate and must be checked for duplicates, unit, and packaging. Name-only automatic matching is prohibited.
4. Show creates, updates, conflicts, missing fields, and duplicates for confirmation.
5. Apply the confirmed catalog transactionally and save external identifiers.
6. A repeated import updates linked cards and does not create copies.

Catalog import never creates a receipt, initial stock, or invented purchase cost. Opening balances and cost are separate confirmed inventory documents.

## Events and retries

- Local accounting operations may write `integration_outbox` in the same database transaction.
- A future worker claims pending events, retries with backoff, records `attempts` and `last_error`, and marks them sent only after remote acknowledgement.
- Incoming events are registered in `integration_inbox`; `(connection_id, external_event_id)` prevents duplicate processing. A repeated id with a different payload hash is a conflict.
- Reconciliation compares linked catalog fields and available inventory and records discrepancies. It must not silently repair accounting data.

## Future online order lifecycle

1. HARID24 requests a reservation with a stable external idempotency key.
2. Supermarket locks local stock and confirms only after a local reservation commits.
3. Cancellation releases only that order's active reservation.
4. Picking consumes the identified reservation and physical stock atomically.
5. Returns are separate inventory and money operations; they do not reverse history by deleting a sale.
6. If the store connection is stale or unavailable, HARID24 must not promise confirmed availability. The local POS continues on the store LAN independently.

## Not implemented in stage 1

- OAuth/API authentication with HARID24;
- remote catalog download or upload;
- outbox delivery worker and retry scheduler;
- inbox HTTP endpoint;
- automatic reconciliation;
- complete company isolation across legacy users, orders, warehouses, and reports.
