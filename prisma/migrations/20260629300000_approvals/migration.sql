-- Approvals: governance workflow table.
-- Operators submit requests; admins approve or reject them.
-- The payload column stores the parameters needed to execute the action on approval.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "ApprovalType"   AS ENUM ('assignment', 'decommission', 'offboard');
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
CREATE TABLE "approvals" (
  "id"            TEXT             NOT NULL,
  "org_id"        TEXT             NOT NULL,
  "type"          "ApprovalType"   NOT NULL,
  "status"        "ApprovalStatus" NOT NULL DEFAULT 'pending',
  "requested_by"  TEXT             NOT NULL,
  "reviewed_by"   TEXT,
  "device_id"     TEXT,
  "employee_id"   TEXT,
  "payload"       JSONB            NOT NULL DEFAULT '{}',
  "review_note"   VARCHAR(1000),
  "created_at"    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  "resolved_at"   TIMESTAMPTZ,

  CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Device/employee are set to null when the resource is deleted.
-- The approval record is preserved for audit history.
ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX "approvals_org_id_status_idx" ON "approvals"("org_id", "status");
CREATE INDEX "approvals_requested_by_idx"  ON "approvals"("requested_by");
CREATE INDEX "approvals_device_id_idx"     ON "approvals"("device_id");
CREATE INDEX "approvals_employee_id_idx"   ON "approvals"("employee_id");
