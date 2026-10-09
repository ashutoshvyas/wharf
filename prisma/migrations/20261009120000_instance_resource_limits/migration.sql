-- Per-instance CPU/memory budget (systemd slice). Existing rows receive the
-- defaults but resource_limits_applied_at stays NULL: their containers keep
-- running unlimited until an operator applies the budget from the panel.
ALTER TABLE "db_instances"
ADD COLUMN "cpu_limit" DOUBLE PRECISION DEFAULT 1,
ADD COLUMN "memory_limit_mb" INTEGER DEFAULT 3072,
ADD COLUMN "resource_limits_applied_at" TIMESTAMP(3),
ADD COLUMN "resource_limits_error" TEXT;
