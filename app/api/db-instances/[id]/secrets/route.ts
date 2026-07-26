/**
 * GET /api/db-instances/:id/secrets — audited reveal of an
 * instance's key material. Operator+ (`secrets.reveal`).
 *
 * This is the ONLY route that returns decrypted instance secrets (contract
 * §1 / architecture §5): the DTO carries no `*Enc` column and no plaintext.
 * Ciphertext is opened in memory, never logged, and the response is
 * `Cache-Control: no-store`. Every call writes a `secret.reveal` audit row.
 *
 * 200 {apiUrl, studioUrl, anonKey, serviceRoleKey, pgPassword}
 * 404  unknown or soft-deleted instance
 * 409  secrets not stored yet (still provisioning, or provisioning failed
 *      before the finalize step)
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling(
  async (_req: Request, { params }: Ctx): Promise<Response> => {
    const { session } = await requireApiRole("secrets.reveal");
    const { id } = await params;

    const instance = await prisma.dbInstance.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        apiSubdomain: true,
        studioSubdomain: true,
        pgPasswordEnc: true,
        anonKeyEnc: true,
        serviceRoleKeyEnc: true,
      },
    });
    if (!instance) return apiError(404, "Database instance not found");

    if (
      !instance.pgPasswordEnc ||
      !instance.anonKeyEnc ||
      !instance.serviceRoleKeyEnc
    ) {
      return apiError(
        409,
        "Secrets are not available yet — the instance is still provisioning.",
      );
    }

    const payload = {
      apiUrl: `https://${instance.apiSubdomain}`,
      studioUrl: `https://${instance.studioSubdomain}`,
      anonKey: open(instance.anonKeyEnc),
      serviceRoleKey: open(instance.serviceRoleKeyEnc),
      pgPassword: open(instance.pgPasswordEnc),
    };

    await audit({
      userId: session.user.id,
      userEmail: session.user.email,
      action: "secret.reveal",
      targetType: "db_instance",
      targetId: id,
      metadata: { instanceId: id },
    });

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
