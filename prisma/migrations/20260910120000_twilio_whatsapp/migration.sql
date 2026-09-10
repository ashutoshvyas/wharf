-- Existing instances retain SMS delivery and no fallback.
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "sms_twilio_delivery_channel" TEXT NOT NULL DEFAULT 'sms',
  ADD COLUMN "sms_twilio_whatsapp_sender" TEXT,
  ADD COLUMN "sms_twilio_content_sid" TEXT,
  ADD COLUMN "sms_twilio_sms_fallback" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "phone_deliveries" (
  "id" TEXT PRIMARY KEY,
  "db_instance_id" TEXT NOT NULL REFERENCES "db_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipient_hash" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "fallback_enabled" BOOLEAN NOT NULL,
  "state" TEXT NOT NULL,
  "primary_sid" TEXT,
  "fallback_sid" TEXT,
  "payload_enc" BYTEA,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "phone_deliveries_db_instance_id_recipient_hash_idx" ON "phone_deliveries"("db_instance_id", "recipient_hash");
CREATE INDEX "phone_deliveries_expires_at_idx" ON "phone_deliveries"("expires_at");
CREATE INDEX "phone_deliveries_created_at_idx" ON "phone_deliveries"("created_at");
