-- Add new DeviceType enum values
ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'desktop';
ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'server';
ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'monitor';
ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'printer';
ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'networking';

-- Add manufacturer to devices
ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "manufacturer" VARCHAR(100);

-- Create device_images table
CREATE TABLE IF NOT EXISTS "device_images" (
  "id"            TEXT        NOT NULL,
  "device_id"     TEXT        NOT NULL,
  "filename"      VARCHAR(200) NOT NULL,
  "original_name" VARCHAR(500) NOT NULL,
  "size"          INTEGER     NOT NULL,
  "mime_type"     VARCHAR(50) NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_images_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "device_images_device_id_idx" ON "device_images"("device_id");
