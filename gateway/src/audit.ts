/**
 * Terminal session auditing.
 *
 * Writes to the insert-only `audit_log` table with the same field/naming
 * conventions as the panel's lib/audit.ts:
 *   action '<entity>.<verb>' → terminal.open / terminal.close
 *   targetType 'server', targetId = serverId
 *
 * Metadata only — keystrokes and terminal output are NEVER recorded (spec §4;
 * architecture §6 "metadata-only auditing"). Writes are fire-and-forget: an
 * audit insert failure must never tear down a live terminal, but it is logged.
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "./db.js";
import { logger } from "./logger.js";

export type CloseReason = "normal" | "idle" | "absolute" | "ssh_error" | "auth" | "limit";

export interface SessionIdentity {
  sessionId: string;
  serverId: string;
  userId: string;
  userEmail: string;
}

function write(
  identity: SessionIdentity,
  action: "terminal.open" | "terminal.close",
  metadata: Record<string, unknown>,
): void {
  getPrisma()
    .auditLog.create({
      data: {
        userId: identity.userId,
        userEmail: identity.userEmail,
        action,
        targetType: "server",
        targetId: identity.serverId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      logger.error(
        { action, sessionId: identity.sessionId, err: err instanceof Error ? err.message : String(err) },
        "audit write failed",
      );
    });
}

/** Recorded once per session, when the SSH shell is established (ready). */
export function auditTerminalOpen(identity: SessionIdentity): void {
  write(identity, "terminal.open", {
    sessionId: identity.sessionId,
    serverId: identity.serverId,
  });
}

/**
 * Recorded exactly once per connection on teardown — the bridge guards this
 * with a `closed` flag so double-teardown paths (ws close + ssh close) cannot
 * produce duplicate rows.
 */
export function auditTerminalClose(
  identity: SessionIdentity,
  durationSec: number,
  reason: CloseReason,
): void {
  write(identity, "terminal.close", {
    sessionId: identity.sessionId,
    durationSec,
    reason,
  });
}
