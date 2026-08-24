-- Existing pooler connections are plaintext today, so preserve that policy
-- for rows created before this feature. New rows use the safer `require`
-- default declared after the backfill.
CREATE TYPE "InstanceSslMode" AS ENUM ('require', 'disable');

ALTER TABLE "db_instances"
ADD COLUMN "ssl_mode" "InstanceSslMode" NOT NULL DEFAULT 'disable';

ALTER TABLE "db_instances"
ALTER COLUMN "ssl_mode" SET DEFAULT 'require';
