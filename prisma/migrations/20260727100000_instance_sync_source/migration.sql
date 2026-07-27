-- CreateEnum
CREATE TYPE "SyncSourceKind" AS ENUM ('supabase', 'postgres');

-- CreateTable
CREATE TABLE "instance_sync_sources" (
    "id" TEXT NOT NULL,
    "db_instance_id" TEXT NOT NULL,
    "kind" "SyncSourceKind" NOT NULL DEFAULT 'supabase',
    "label" TEXT,
    "pg_host" TEXT NOT NULL,
    "pg_port" INTEGER NOT NULL DEFAULT 5432,
    "pg_database" TEXT NOT NULL DEFAULT 'postgres',
    "pg_user" TEXT NOT NULL,
    "pg_password_enc" BYTEA NOT NULL,
    "pg_ssl_mode" TEXT NOT NULL DEFAULT 'require',
    "project_url" TEXT,
    "service_role_key_enc" BYTEA,
    "include_auth_users" BOOLEAN NOT NULL DEFAULT true,
    "include_storage_objects" BOOLEAN NOT NULL DEFAULT false,
    "extra_schemas" TEXT[],
    "last_synced_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_sync_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_sync_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_sync_sources_db_instance_id_key" ON "instance_sync_sources"("db_instance_id");

-- AddForeignKey
ALTER TABLE "instance_sync_sources" ADD CONSTRAINT "instance_sync_sources_db_instance_id_fkey" FOREIGN KEY ("db_instance_id") REFERENCES "db_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
