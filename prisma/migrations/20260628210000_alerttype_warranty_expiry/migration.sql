-- Add warranty_expiry to AlertType enum.
-- Postgres cannot ADD VALUE inside a transaction (Prisma always uses transactions),
-- so we use the rename → create → USING cast → drop pattern.
-- There is no DEFAULT on alerts.type so no DROP/SET DEFAULT needed.

ALTER TYPE "AlertType" RENAME TO "AlertType_old";

CREATE TYPE "AlertType" AS ENUM ('unassigned_device', 'warranty_expiry');

ALTER TABLE "alerts"
  ALTER COLUMN "type" TYPE "AlertType"
  USING "type"::text::"AlertType";

DROP TYPE "AlertType_old";
