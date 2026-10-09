/**
 * Instance Auth settings — the self-hosted-configurable subset of
 * GoTrue's Auth config (OAuth providers, SMTP, sign-up/session toggles),
 * surfaced on the panel because self-hosted Supabase Studio's own equivalent
 * pages are gated behind Supabase Cloud's platform-only management API and
 * never render (confirmed against a live upstream Studio issue).
 *
 * Applying a change re-renders and re-uploads the instance's own
 * docker-compose.yml/.env (lib/provision/render.ts), then restarts ONLY its
 * `auth` container — `docker compose up -d auth` only recreates the named
 * service, leaving db/kong/studio untouched even though they're interpolated
 * from the same .env file. The `cd` into remotePath is required: unlike
 * `stop`/`start`/`ps`, which resolve the project from running container
 * labels, `up` has to read docker-compose.yml off disk, and `-p` alone
 * doesn't tell Compose where to find it. Synchronous, lock-holding shape,
 * mirroring pipeline.ts's stopInstance/startInstance — not the async
 * job-stream pattern used by provision/restore/remove, since this completes
 * in a few seconds rather than minutes.
 */
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import {
  renderInstanceCompose,
  type AuthSettingsValues,
  type EmailTemplateValues,
} from "./render";
import { STORED_SETTINGS_INCLUDE, storedRenderSettings } from "./stored-settings";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

// Re-exported: the auth-settings route reads stored settings through here.
export { decryptAuthSettings, toEmailTemplateValues } from "./stored-settings";

export type ApplyAuthSettingsResult = { ok: true } | { busy: string };

/**
 * Re-render and re-upload this instance's docker-compose.yml/.env with the
 * given settings, then restart only its `auth` container to pick them up.
 *
 * Throws (rather than returning an error variant) for anything other than a
 * held lock — matching stopInstance/startInstance's convention, where the
 * caller's route maps a "busy" substring in the thrown message to 409 and
 * everything else to 500. The optional persistence callback runs under the
 * lock after rendering but before any SSH writes, so new hook configuration
 * is available when Auth restarts and a busy conflict leaves no saved changes.
 *
 * Everything else (the analytics toggle, and the email templates when
 * `emailTemplates` is omitted) is rendered from what is stored, so this never
 * resets settings it was not asked to change.
 */
export async function applyAuthSettings(
  instanceId: string,
  settings: AuthSettingsValues,
  emailTemplates?: EmailTemplateValues[],
  persist?: () => Promise<void>,
): Promise<ApplyAuthSettingsResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
    include: STORED_SETTINGS_INCLUDE,
  });
  if (!instance) {
    throw new Error(`Instance ${instanceId} was not found.`);
  }
  if (
    !instance.pgPasswordEnc ||
    !instance.jwtSecretEnc ||
    !instance.anonKeyEnc ||
    !instance.serviceRoleKeyEnc
  ) {
    throw new Error("This instance has no stored secrets yet — it never finished provisioning.");
  }

  const release = tryAcquireServerLock(instance.serverId, "auth-settings");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  try {
    const domain = process.env.INSTANCE_DOMAIN ?? "";
    const { composeYaml, envFile } = await renderInstanceCompose({
      slug: instance.slug,
      project: instance.composeProjectName,
      domain,
      secrets: {
        pgPassword: open(instance.pgPasswordEnc),
        jwtSecret: open(instance.jwtSecretEnc),
        anonKey: open(instance.anonKeyEnc),
        serviceRoleKey: open(instance.serviceRoleKeyEnc),
      },
      remotePath: instance.remotePath,
      ...storedRenderSettings(instance),
      authSettings: settings,
      ...(emailTemplates ? { emailTemplates } : {}),
    });

    // Persist hook credentials while holding the server lock, before Auth can call back.
    await persist?.();

    await withConnection(instance.serverId, async (conn: SshConnection) => {
      await sftpWrite(conn, `${instance.remotePath}/docker-compose.yml`, composeYaml);
      await sftpWrite(conn, `${instance.remotePath}/.env`, envFile, 0o600);
      const res = await exec(
        conn,
        `cd ${instance.remotePath} && docker compose -p ${instance.composeProjectName} up -d auth`,
        { timeoutMs: 120_000 },
      );
      if (res.code !== 0) {
        throw new Error(
          `docker compose up -d auth failed (code ${res.code}): ${res.stderr.trim()}`,
        );
      }
    });

    return { ok: true };
  } finally {
    release();
  }
}
