# Stage 1 migration runbook

The API no longer runs schema changes or seed functions during ordinary startup.

## Existing local database

1. Stop writes to the local application.
2. Create and verify a PostgreSQL backup using the store's normal backup location.
3. Check for duplicate picking tasks before migration:

   ```sql
   SELECT order_id, COUNT(*)
   FROM pick_tasks
   GROUP BY order_id
   HAVING COUNT(*) > 1;
   ```

   Resolve duplicates by an explicit business decision. The migration does not delete them and the unique index intentionally makes the migration fail if they remain.

4. Check existing invalid stock without modifying it:

   ```sql
   SELECT *
   FROM warehouse_stock
   WHERE quantity < 0 OR reserved_quantity < 0 OR reserved_quantity > quantity;
   ```

5. Run `npm run db:migrate` with the local copy's `DATABASE_URL`.
6. Call `GET /api/admin/warehouse/consistency` as an administrator with warehouse permission.
7. Investigate every row where `consistent=false`. Do not automatically manufacture historical movements.

The migration imports legacy reservation ownership only when a positive reserve can be derived from existing `stock_movements` for an active picking task. It does not change physical stock or reserved totals. Missing history remains explicitly reported as incomplete.

## Empty development database

Run `npm run db:baseline` once, followed by `npm run db:migrate`. Baseline bootstrap refuses to run when the legacy `users` table already exists.

## Rollback

There is no automatic destructive down migration. Once new accounting operations have been posted, dropping their tables would destroy audit history. The safe rollback is:

1. stop application writes;
2. return the application code to the prior version;
3. restore the verified pre-migration database backup;
4. verify order, stock, and reservation totals before reopening access.

If the migration itself fails, its transaction rolls back and `schema_migrations` is not advanced.
