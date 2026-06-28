-- Migration: remove 'inactive' status, add decommission_reason
-- Any existing 'inactive' devices are reset to 'active' (safe default).

-- Step 1: move inactive → active
UPDATE "devices" SET "status" = 'active' WHERE "status" = 'inactive';

-- Step 2: swap the enum (Postgres requires recreating it to remove a value)
-- Drop the column default first — it references the old type by name, so after
-- the RENAME it becomes "DeviceStatus_old"::text and Postgres can no longer
-- cast it automatically when we ALTER COLUMN TYPE.
ALTER TABLE "devices" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "DeviceStatus" RENAME TO "DeviceStatus_old";
CREATE TYPE "DeviceStatus" AS ENUM ('active', 'decommissioned');
ALTER TABLE "devices"
  ALTER COLUMN "status" TYPE "DeviceStatus"
  USING "status"::text::"DeviceStatus";
DROP TYPE "DeviceStatus_old";

-- Restore the default using the new type name.
ALTER TABLE "devices" ALTER COLUMN "status" SET DEFAULT 'active'::"DeviceStatus";

-- Step 3: add decommission reason
ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "decommission_reason" VARCHAR(1000);
