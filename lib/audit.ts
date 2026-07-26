/**
 * Audit service — writes to the insert-only `audit_log` table
 * (UPDATE/DELETE are rejected by a Postgres trigger, migration
 * 20260724000002_audit_immutable).
 *
 * Action naming convention: '<entity>.<verb>'
 * Examples:
 *   server.create, server.bootstrap, server.credential_reveal,
 *   website.update,
 *   instance.provision, instance.remove,
 *   terminal.open, terminal.close,
 *   secret.reveal,
 *   auth.login_failed, auth.lockout,
 *   user.create
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

export interface AuditParams {
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(params: AuditParams) {
  return prisma.auditLog.create({
    data: {
      userId: params.userId ?? null,
      userEmail: params.userEmail ?? null,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId ?? null,
      metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
