-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('password', 'private_key');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('provisioning', 'running', 'stopped', 'error', 'removing');

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "ssh_port" INTEGER NOT NULL DEFAULT 22,
    "ssh_user" TEXT NOT NULL,
    "auth_method" "AuthMethod" NOT NULL,
    "ssh_password_enc" BYTEA,
    "ssh_private_key_enc" BYTEA,
    "linked_panel_url" TEXT,
    "panel_user_enc" BYTEA,
    "panel_pass_enc" BYTEA,
    "bootstrapped" BOOLEAN NOT NULL DEFAULT false,
    "reachable" BOOLEAN NOT NULL DEFAULT true,
    "host_key_fingerprint" TEXT,
    "tags" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "db_instance_id" TEXT,
    "credential_label" TEXT NOT NULL DEFAULT 'Admin login',
    "access_username" TEXT,
    "access_password_enc" BYTEA,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "db_instances" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "compose_project_name" TEXT NOT NULL,
    "remote_path" TEXT NOT NULL,
    "api_subdomain" TEXT NOT NULL,
    "studio_subdomain" TEXT NOT NULL,
    "pg_password_enc" BYTEA,
    "anon_key_enc" BYTEA,
    "service_role_key_enc" BYTEA,
    "jwt_secret_enc" BYTEA,
    "status" "InstanceStatus" NOT NULL DEFAULT 'provisioning',
    "last_action_log" TEXT,
    "health_checked_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "db_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_email" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "db_instances_slug_key" ON "db_instances"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "db_instances_server_id_remote_path_key" ON "db_instances"("server_id", "remote_path");

-- CreateIndex
CREATE UNIQUE INDEX "panel_users_email_key" ON "panel_users"("email");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_db_instance_id_fkey" FOREIGN KEY ("db_instance_id") REFERENCES "db_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "db_instances" ADD CONSTRAINT "db_instances_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

