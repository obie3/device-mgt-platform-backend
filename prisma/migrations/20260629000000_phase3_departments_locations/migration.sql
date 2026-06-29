-- Phase 3: Department FK model + Location FK model + Device cost_center
-- Backfills existing string data into the new tables then swaps columns.
-- Run AFTER applying previous migrations and regenerating the Prisma client.

-- ---------------------------------------------------------------------------
-- 1. Create departments table
-- ---------------------------------------------------------------------------
CREATE TABLE "departments" (
  "id"         TEXT         NOT NULL,
  "org_id"     TEXT         NOT NULL,
  "name"       VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "departments_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "departments_org_id_name_key" UNIQUE ("org_id", "name")
);

CREATE INDEX "departments_org_id_idx" ON "departments"("org_id");

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Create locations table
-- ---------------------------------------------------------------------------
CREATE TABLE "locations" (
  "id"         TEXT         NOT NULL,
  "org_id"     TEXT         NOT NULL,
  "name"       VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "locations_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "locations_org_id_name_key" UNIQUE ("org_id", "name")
);

CREATE INDEX "locations_org_id_idx" ON "locations"("org_id");

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Backfill departments from existing Device.department strings
-- ---------------------------------------------------------------------------
INSERT INTO "departments" ("id", "org_id", "name", "created_at", "updated_at")
SELECT
  lower(replace(gen_random_uuid()::text, '-', '')),
  "org_id",
  "department",
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT "org_id", "department"
  FROM   "devices"
  WHERE  "department" IS NOT NULL AND trim("department") <> ''
) AS distinct_depts
ON CONFLICT ("org_id", "name") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Add department_id to devices + populate from matched name
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" ADD COLUMN "department_id" TEXT;

UPDATE "devices" d
SET    "department_id" = dept."id"
FROM   "departments" dept
WHERE  dept."org_id" = d."org_id"
  AND  dept."name"   = d."department";

-- ---------------------------------------------------------------------------
-- 5. Backfill locations from existing Device.location strings
-- ---------------------------------------------------------------------------
INSERT INTO "locations" ("id", "org_id", "name", "created_at", "updated_at")
SELECT
  lower(replace(gen_random_uuid()::text, '-', '')),
  "org_id",
  "location",
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT "org_id", "location"
  FROM   "devices"
  WHERE  "location" IS NOT NULL AND trim("location") <> ''
) AS distinct_locs
ON CONFLICT ("org_id", "name") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Add location_id to devices + populate from matched name
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" ADD COLUMN "location_id" TEXT;

UPDATE "devices" d
SET    "location_id" = loc."id"
FROM   "locations" loc
WHERE  loc."org_id" = d."org_id"
  AND  loc."name"   = d."location";

-- ---------------------------------------------------------------------------
-- 7. Drop old string columns
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" DROP COLUMN "department";
ALTER TABLE "devices" DROP COLUMN "location";

-- ---------------------------------------------------------------------------
-- 8. Add cost_center column
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" ADD COLUMN "cost_center" VARCHAR(100);

-- ---------------------------------------------------------------------------
-- 9. FK constraints + indexes on devices
-- ---------------------------------------------------------------------------
ALTER TABLE "devices"
  ADD CONSTRAINT "devices_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "devices_department_id_idx" ON "devices"("department_id");
CREATE INDEX "devices_location_id_idx"   ON "devices"("location_id");
