-- Per-instance Site URL and OAuth callback URL. One WHARF server hosts many
-- instances, each backing a different web application, so neither can stay
-- derived from the instance's own Supabase origin.
--
-- Both nullable with no default: NULL (and empty string) mean "derive from the
-- instance's API origin", which is exactly the behavior every existing row had
-- before this migration — https://<api-subdomain> for the site URL and
-- https://<api-subdomain>/auth/v1/callback for the callback.
ALTER TABLE "instance_auth_settings" ADD COLUMN "site_url" TEXT;
ALTER TABLE "instance_auth_settings" ADD COLUMN "oauth_callback_url" TEXT;
