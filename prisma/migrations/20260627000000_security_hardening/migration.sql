-- Security hardening migration
-- Removes check-in infrastructure, fixes multi-tenancy, adds length constraints

-- ─── 1. Remove check-in fields from devices ──────────────────────────────────

DROP INDEX IF EXISTS "devices_serial_idx";
DROP INDEX IF EXISTS "devices_last_seen_idx";

ALTER TABLE "devices" DROP COLUMN IF EXISTS "token_hash";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "hostname";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "last_seen";

-- ─── 2. Remove staleThresholdDays from organizations ─────────────────────────

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "stale_threshold_days";

-- ─── 3. Remove stale_device from AlertType enum ──────────────────────────────
-- PostgreSQL does not support DROP VALUE on an enum. We must:
--   a. Delete all rows using the removed value
--   b. Create a new enum, migrate the column, drop old enum

DELETE FROM "alerts" WHERE "type" = 'stale_device';

ALTER TYPE "AlertType" RENAME TO "AlertType_old";
CREATE TYPE "AlertType" AS ENUM ('unassigned_device');
ALTER TABLE "alerts" ALTER COLUMN "type" TYPE "AlertType" USING "type"::text::"AlertType";
DROP TYPE "AlertType_old";

-- ─── 4. Change User.email from global unique to per-org unique ────────────────

-- Drop the old global unique index
DROP INDEX IF EXISTS "users_email_key";

-- Add the per-org compound unique constraint
-- (If the constraint already exists from a previous migration, this is a no-op)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_org_id_email_key'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_org_id_email_key" UNIQUE ("org_id", "email");
  END IF;
END $$;

-- ─── 5. Add VarChar length constraints ───────────────────────────────────────

-- organizations
ALTER TABLE "organizations" ALTER COLUMN "name" TYPE VARCHAR(200);

-- users
ALTER TABLE "users" ALTER COLUMN "name" TYPE VARCHAR(200);
ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(320);

-- employees
ALTER TABLE "employees" ALTER COLUMN "name" TYPE VARCHAR(200);
ALTER TABLE "employees" ALTER COLUMN "email" TYPE VARCHAR(320);
ALTER TABLE "employees" ALTER COLUMN "department" TYPE VARCHAR(100);

-- devices
ALTER TABLE "devices" ALTER COLUMN "serial" TYPE VARCHAR(100);
ALTER TABLE "devices" ALTER COLUMN "model" TYPE VARCHAR(200);
ALTER TABLE "devices" ALTER COLUMN "notes" TYPE VARCHAR(2000);

-- device_assignments
ALTER TABLE "device_assignments" ALTER COLUMN "condition_notes" TYPE VARCHAR(2000);

-- alerts
ALTER TABLE "alerts" ALTER COLUMN "message" TYPE VARCHAR(500);

-- audit_logs
ALTER TABLE "audit_logs" ALTER COLUMN "action" TYPE VARCHAR(100);
ALTER TABLE "audit_logs" ALTER COLUMN "resource_type" TYPE VARCHAR(50);
