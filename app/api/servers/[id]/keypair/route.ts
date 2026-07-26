/**
 * /api/servers/:id/keypair — generate an ed25519 SSH keypair.
 * POST: admin (servers.write). The private key is sealed into
 * sshPrivateKeyEnc (authMethod flips to private_key, any stored password is
 * cleared); the OpenSSH public key is returned ONCE for the user to paste
 * into authorized_keys. Replacing an existing key requires {confirm: true}.
 */
import { generateKeyPairSync } from "node:crypto";
import { NextResponse } from "next/server";
import {
  apiError,
  requireApiRole,
  withErrorHandling,
} from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { prisma } from "@/lib/db";
import { toOpenSshPublicKey } from "@/lib/servers/openssh";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(async (req: Request, ctx: Ctx) => {
  const { session } = await requireApiRole("servers.write");
  const { id } = await ctx.params;

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return apiError(404, "Server not found");

  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  if (server.sshPrivateKeyEnc && body?.confirm !== true) {
    return apiError(409, "Existing key — pass confirm:true to replace");
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const openSshPublicKey = toOpenSshPublicKey(publicKey);

  await prisma.server.update({
    where: { id },
    data: {
      sshPrivateKeyEnc: sealBytes(privatePem),
      sshPasswordEnc: null,
      authMethod: "private_key",
    },
  });

  await audit({
    userId: session.user.id,
    userEmail: session.user.email,
    action: "server.keypair_generate",
    targetType: "server",
    targetId: id,
    metadata: { host: server.host },
  });

  return NextResponse.json(
    { publicKey: openSshPublicKey },
    { headers: { "Cache-Control": "no-store" } },
  );
});
