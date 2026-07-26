/**
 * Instance Analytics-buckets toggle — mirrors
 * lib/provision/auth-settings.ts's lock/render/upload/exec shape exactly,
 * adapted for a pure on/off setting instead of a settings bag.
 *
 * Applying a change re-renders and re-uploads the instance's own
 * docker-compose.yml/.env, then runs a BARE `docker compose up -d` (no
 * service names) — unlike auth-settings' scoped `up -d auth`, this is
 * deliberate: Compose only creates/recreates services whose config
 * actually changed (picks up `storage`'s new ICEBERG_* env vars) and starts
 * any newly-profile-included service (MinIO/Lakekeeper, both
 * `profiles: ["analytics"]`), while leaving every already-running,
 * unrelated service (db, kong, studio, auth, ...) untouched.
 *
 * Disabling needs one extra explicit step: Compose does not stop a service
 * just because it left the active profile set on a later `up -d`, so
 * turning analytics off additionally stops the 4 analytics-profile
 * containers by name (stop, not remove — matches this codebase's existing
 * "Stop keeps data volumes intact" philosophy for whole instances).
 */
import { prisma } from "@/lib/db";
import { open } from "@/lib/crypto";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import { renderInstanceCompose } from "./render";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** The 4 services `profiles: ["analytics"]` gates in templates/supabase/docker-compose.yml. */
const ANALYTICS_SERVICES = ["minio", "minio-init", "lakekeeper", "lakekeeper-init"] as const;

export type ApplyAnalyticsSettingsResult = { ok: true } | { busy: string };

/**
 * Re-render and re-upload this instance's docker-compose.yml/.env with the
 * given `enabled` value, then reconcile the running containers.
 *
 * Throws (rather than returning an error variant) for anything other than a
 * held lock — matching applyAuthSettings/stopInstance/startInstance, where
 * the caller's route maps a "busy" substring in the thrown message to 409
 * and everything else to 500. Callers should persist the settings row
 * BEFORE calling this, so an apply failure here doesn't lose the operator's
 * input — only the "did it actually take effect on the server" step failed.
 */
export async function applyAnalyticsSettings(
  instanceId: string,
  enabled: boolean,
): Promise<ApplyAnalyticsSettingsResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
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

  const release = tryAcquireServerLock(instance.serverId, "analytics-settings");
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
      analyticsSettings: { enabled },
    });

    await withConnection(instance.serverId, async (conn: SshConnection) => {
      await sftpWrite(conn, `${instance.remotePath}/docker-compose.yml`, composeYaml);
      await sftpWrite(conn, `${instance.remotePath}/.env`, envFile, 0o600);

      const up = await exec(
        conn,
        `cd ${instance.remotePath} && docker compose -p ${instance.composeProjectName} up -d`,
        { timeoutMs: 120_000 },
      );
      if (up.code !== 0) {
        throw new Error(`docker compose up -d failed (code ${up.code}): ${up.stderr.trim()}`);
      }

      if (!enabled) {
        const stop = await exec(
          conn,
          `docker compose -p ${instance.composeProjectName} stop ${ANALYTICS_SERVICES.join(" ")}`,
          { timeoutMs: 60_000 },
        );
        if (stop.code !== 0) {
          throw new Error(
            `docker compose stop (analytics services) failed (code ${stop.code}): ${stop.stderr.trim()}`,
          );
        }
      }
    });

    return { ok: true };
  } finally {
    release();
  }
}
