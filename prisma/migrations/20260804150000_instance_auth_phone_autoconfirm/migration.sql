-- GOTRUE_SMS_AUTOCONFIRM, until now hardcoded to true in .env.template with no
-- placeholder — so no operator could change it.
--
-- true marks a phone confirmed at signup without sending or verifying an OTP;
-- false is the branch that actually sends the confirmation SMS. Defaulting to
-- true preserves exactly what every existing instance already renders. Turning
-- it off requires an SMS provider, which the template does not render yet.
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "enable_phone_autoconfirm" BOOLEAN NOT NULL DEFAULT true;
