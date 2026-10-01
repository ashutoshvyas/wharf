ALTER TABLE "servers" ADD COLUMN "pooler_firewall_managed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "db_instances"
  ADD COLUMN "network_access" JSONB,
  ADD COLUMN "network_access_applied_at" TIMESTAMP(3),
  ADD COLUMN "network_access_error" TEXT;

-- Existing and newly-read legacy rows use the same availability-first default.
UPDATE "db_instances"
SET "network_access" = '{"mode":"all"}'::jsonb
WHERE "network_access" IS NULL;
