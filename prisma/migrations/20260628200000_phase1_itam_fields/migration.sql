-- Phase 1: ITAM field expansion
-- 1. Backfill → swap DeviceStatus enum → re-tag assigned rows → add columns → partial unique index
--
-- Order is critical:
--   Step 1 must run BEFORE the enum swap (needs 'active' to still exist in the old enum).
--   Step 3 must run AFTER the enum swap (needs 'assigned' to exist in the new enum).

-- ---------------------------------------------------------------------------
-- Step 1: Mark devices that have an open assignment so we can re-tag them
--         after the enum swap.  We temporarily set status = 'active' (it will
--         be converted to 'in_stock' in Step 2's USING clause, which we then
--         overwrite in Step 3).
--         Devices that DO have an open assignment also get the 'active' tag —
--         we identify them by re-running the subquery in Step 3.
--         (No-op: all active devices currently have status = 'active'.)
-- ---------------------------------------------------------------------------

-- No-op placeholder — all rows are already 'active'. Step 3 handles tagging.

-- ---------------------------------------------------------------------------
-- Step 2: Replace DeviceStatus enum.
--         Postgres cannot drop enum values (ALTER TYPE ... DROP VALUE is not
--         supported). The rename → create new → USING cast → drop old pattern
--         is the only safe approach.
-- ---------------------------------------------------------------------------

-- Drop default before rename — it references the old type and Postgres cannot
-- cast it automatically once the type is renamed.
ALTER TABLE "devices" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "DeviceStatus" RENAME TO "DeviceStatus_old";

CREATE TYPE "DeviceStatus" AS ENUM ('in_stock', 'assigned', 'under_repair', 'decommissioned');

ALTER TABLE "devices"
  ALTER COLUMN "status" TYPE "DeviceStatus"
  USING CASE "status"::text
    WHEN 'active'         THEN 'in_stock'::"DeviceStatus"
    WHEN 'decommissioned' THEN 'decommissioned'::"DeviceStatus"
    ELSE 'in_stock'::"DeviceStatus"   -- safety fallback
  END;

DROP TYPE "DeviceStatus_old";

-- Restore default using the new type.
ALTER TABLE "devices" ALTER COLUMN "status" SET DEFAULT 'in_stock'::"DeviceStatus";

-- ---------------------------------------------------------------------------
-- Step 3: Re-tag devices that have an open assignment → 'assigned'
--         (they were cast to 'in_stock' in Step 2).
-- ---------------------------------------------------------------------------

UPDATE "devices" d
   SET "status" = 'assigned'
 WHERE EXISTS (
   SELECT 1 FROM "device_assignments" da
    WHERE da.device_id = d.id
      AND da.returned_at IS NULL
 );

-- ---------------------------------------------------------------------------
-- Step 4: Add new columns
-- ---------------------------------------------------------------------------

ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "asset_tag"         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "location"          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "department"        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "supplier"          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "purchase_price"    DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS "warranty_start"    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "warranty_end"      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "warranty_provider" VARCHAR(200);

-- ---------------------------------------------------------------------------
-- Step 5: Partial unique index on (org_id, asset_tag) WHERE NOT NULL
--         Standard @@unique would reject multiple NULLs in the same org.
--         A partial index correctly allows many devices without an asset tag.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "devices_org_asset_tag_key"
  ON "devices" ("org_id", "asset_tag")
  WHERE "asset_tag" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 6: Additional indexes for common query patterns
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "devices_org_id_status_idx"
  ON "devices" ("org_id", "status");

CREATE INDEX IF NOT EXISTS "devices_warranty_end_idx"
  ON "devices" ("warranty_end")
  WHERE "warranty_end" IS NOT NULL;
