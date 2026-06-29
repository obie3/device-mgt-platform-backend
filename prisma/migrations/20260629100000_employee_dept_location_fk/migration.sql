-- Employee: replace free-text department string with departmentId + locationId FKs.
-- Backfills department_id from existing string values (case-insensitive match).
-- Location cannot be backfilled (no prior string column existed).

-- 1. Add nullable FK columns
ALTER TABLE "employees"
  ADD COLUMN "department_id" TEXT,
  ADD COLUMN "location_id"   TEXT;

-- 2. Backfill department_id where the old string matches a departments row
UPDATE "employees" e
SET    "department_id" = d."id"
FROM   "departments" d
WHERE  d."org_id"     = e."org_id"
  AND  LOWER(d."name") = LOWER(e."department")
  AND  e."department"  IS NOT NULL;

-- 3. Drop the old free-text column
ALTER TABLE "employees" DROP COLUMN "department";

-- 4. FK constraints
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Indexes
CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");
CREATE INDEX "employees_location_id_idx"   ON "employees"("location_id");
