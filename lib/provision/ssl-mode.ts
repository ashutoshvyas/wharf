/**
 * Apply an existing instance's client-side TLS policy to its shared
 * Supavisor tenant, then persist the matching mode while the server lock is
 * still held. No instance containers or credentials are changed.
 */
import { refreshPooler, type EmitFn } from "@/lib/bootstrap/steps";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import type { DbInstanceRecord } from "@/lib/instances/serialize";
import { INSTANCE_INCLUDE } from "@/lib/instances/serialize";
import type { InstanceSslMode } from "@/lib/instances/ssl-mode";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { withConnection } from "@/lib/ssh";
import { registerPoolerTenant } from "./pooler";

type SshConnection = Parameters<Parameters<typeof withConnection>[1]>[0];

export type UpdateSslModeResult =
  | { ok: true; instance: DbInstanceRecord }
  | { notFound: true }
  | { busy: string }
  | { invalid: string };

const quietEmit: EmitFn = () => undefined;

/**
 * The Supavisor tenant update is idempotent. For `require`, first converge
 * the shared pooler so older servers gain the certificate mount and TLS
 * listener before the tenant begins rejecting plaintext startup packets.
 *
 * Runtime state is changed before the database row. If persistence fails,
 * best-effort rollback restores the previous tenant policy so connection
 * strings do not advertise a mode that differs from the running pooler.
 */
export async function updateInstanceSslMode(
  instanceId: string,
  sslMode: InstanceSslMode,
): Promise<UpdateSslModeResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
    include: INSTANCE_INCLUDE,
  });
  if (!instance) return { notFound: true };

  if (instance.sslMode === sslMode) return { ok: true, instance };
  if (!instance.pgPasswordEnc) {
    return {
      invalid: "This instance has no stored database password yet — finish or retry provisioning first.",
    };
  }

  const release = tryAcquireServerLock(instance.serverId, "ssl-mode");
  if (!release) {
    return { busy: serverLockHolder(instance.serverId) ?? "another job" };
  }

  const pgPassword = open(instance.pgPasswordEnc);
  try {
    return await withConnection(instance.serverId, async (conn: SshConnection) => {
      if (sslMode === "require") {
        await refreshPooler(conn, quietEmit, instance.serverId);
      }

      await registerPoolerTenant(conn, {
        serverId: instance.serverId,
        project: instance.composeProjectName,
        pgPassword,
        sslMode,
      });

      try {
        const updated = await prisma.dbInstance.update({
          where: { id: instance.id },
          data: { sslMode },
          include: INSTANCE_INCLUDE,
        });
        return { ok: true, instance: updated };
      } catch (persistError) {
        try {
          await registerPoolerTenant(conn, {
            serverId: instance.serverId,
            project: instance.composeProjectName,
            pgPassword,
            sslMode: instance.sslMode,
          });
        } catch (rollbackError) {
          const persistMessage =
            persistError instanceof Error ? persistError.message : String(persistError);
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `SSL mode changed on the pooler but could not be persisted or rolled back: ` +
              `${persistMessage}; rollback failed: ${rollbackMessage}`,
          );
        }
        throw persistError;
      }
    });
  } finally {
    release();
  }
}
