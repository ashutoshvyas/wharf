-- The two per-provider GoTrue flags Supabase Studio exposes alongside the
-- credentials themselves (GOTRUE_EXTERNAL_<PROVIDER>_SKIP_NONCE_CHECK and
-- _EMAIL_OPTIONAL, both real config fields in supabase/auth v2.189.0).
--
-- Only the pairing Studio actually offers: skip-nonce is an OIDC ID-token
-- concern, so it applies to Google but not to Apple's web flow; email-optional
-- applies to both. Defaults keep every existing row on the previous behavior
-- (nonce enforced, an email required).
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "google_skip_nonce_check" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "google_email_optional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "apple_email_optional" BOOLEAN NOT NULL DEFAULT false;
