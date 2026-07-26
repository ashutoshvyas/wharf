-- CreateTable
CREATE TABLE "instance_auth_settings" (
    "id" TEXT NOT NULL,
    "db_instance_id" TEXT NOT NULL,
    "disable_signup" BOOLEAN NOT NULL DEFAULT false,
    "enable_email_signup" BOOLEAN NOT NULL DEFAULT true,
    "enable_email_autoconfirm" BOOLEAN NOT NULL DEFAULT true,
    "enable_phone_signup" BOOLEAN NOT NULL DEFAULT false,
    "enable_anonymous_users" BOOLEAN NOT NULL DEFAULT false,
    "jwt_expiry_seconds" INTEGER NOT NULL DEFAULT 3600,
    "additional_redirect_urls" TEXT,
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_user" TEXT,
    "smtp_pass_enc" BYTEA,
    "smtp_sender_name" TEXT,
    "smtp_admin_email" TEXT,
    "google_enabled" BOOLEAN NOT NULL DEFAULT false,
    "google_client_id" TEXT,
    "google_secret_enc" BYTEA,
    "github_enabled" BOOLEAN NOT NULL DEFAULT false,
    "github_client_id" TEXT,
    "github_secret_enc" BYTEA,
    "azure_enabled" BOOLEAN NOT NULL DEFAULT false,
    "azure_client_id" TEXT,
    "azure_secret_enc" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_auth_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_auth_settings_db_instance_id_key" ON "instance_auth_settings"("db_instance_id");

-- AddForeignKey
ALTER TABLE "instance_auth_settings" ADD CONSTRAINT "instance_auth_settings_db_instance_id_fkey" FOREIGN KEY ("db_instance_id") REFERENCES "db_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
