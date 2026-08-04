-- SMS / phone OTP delivery. Until now the whole GOTRUE_SMS_* block
-- was commented out in docker-compose.yml, so phone sign-up could never send
-- a code and enable_phone_autoconfirm=true was the only thing keeping it
-- functional at all.
--
-- sms_provider is "" (none), "twilio" (spoken natively by GoTrue) or "msg91"
-- (not a GoTrue provider — reached through its send-SMS hook pointed back at
-- this panel). All nullable: an instance with no provider configured renders
-- the same disabled state it renders today.
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_provider" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_otp_exp" INTEGER;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_otp_length" INTEGER;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_max_frequency" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_template" TEXT;

ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_twilio_account_sid" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_twilio_auth_token_enc" BYTEA;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_twilio_message_service_sid" TEXT;

ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_msg91_auth_key_enc" BYTEA;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_msg91_template_id" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_msg91_sender_id" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "sms_msg91_otp_variable" TEXT;
