-- Apple as a fourth OAuth provider under Auth Settings > Providers.
-- Same column shape as google/github/azure; defaults keep every existing row
-- with the provider disabled and no credentials until an operator sets them.
ALTER TABLE "instance_auth_settings" ADD COLUMN "apple_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instance_auth_settings" ADD COLUMN "apple_client_id" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "apple_secret_enc" BYTEA;
