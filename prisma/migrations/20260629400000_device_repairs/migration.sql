-- CreateTable
CREATE TABLE "device_repairs" (
    "id"                    TEXT NOT NULL,
    "org_id"                TEXT NOT NULL,
    "device_id"             TEXT NOT NULL,
    "logged_by_id"          TEXT,
    "issue"                 TEXT NOT NULL,
    "notes"                 TEXT,
    "vendor"                VARCHAR(200),
    "technician_name"       VARCHAR(200),
    "cost"                  DECIMAL(12,2),
    "sent_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimated_return_at"   TIMESTAMP(3),
    "returned_at"           TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_repairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_repairs_device_id_idx" ON "device_repairs"("device_id");
CREATE INDEX "device_repairs_org_id_idx"    ON "device_repairs"("org_id");

-- AddForeignKey
ALTER TABLE "device_repairs" ADD CONSTRAINT "device_repairs_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_repairs" ADD CONSTRAINT "device_repairs_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "device_repairs" ADD CONSTRAINT "device_repairs_logged_by_id_fkey"
    FOREIGN KEY ("logged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
