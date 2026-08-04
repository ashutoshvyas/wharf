-- GOTRUE_SECURITY_MANUAL_LINKING_ENABLED — whether GoTrue's manual account
-- linking APIs (linkIdentity/unlinkIdentity) are available to the project.
-- Default false matches GoTrue's own default, so existing rows keep today's
-- behavior until an operator turns it on.
ALTER TABLE "instance_auth_settings"
  ADD COLUMN "manual_linking_enabled" BOOLEAN NOT NULL DEFAULT false;
