/**
 * GET /api/db-instances/slug-available?slug= — live availability
 * check for the provisioning form. Operator+ (`instance.provision`).
 *
 * Soft-deleted rows STILL hold their slug: the subdomains
 * (`{slug}.{domain}`, `studio-{slug}.{domain}`) and DNS/TLS records linger
 * after a remove, and the column is `@unique` across the whole table. So the
 * lookup deliberately ignores `deletedAt` — reusing a removed slug would
 * collide at insert time and could resurrect a stale certificate.
 *
 * A syntactically invalid slug is reported as unavailable rather than 400:
 * the field is validated as the user types and the caller only renders a
 * yes/no badge. The authoritative check happens again in the pipeline's
 * `validate` phase.
 */
import { NextResponse } from "next/server";
import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { slugSchema } from "@/lib/instances/schema";

export const GET = withErrorHandling(async (req: Request): Promise<Response> => {
  await requireApiRole("instance.provision");

  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slugSchema.safeParse(slug).success) {
    return NextResponse.json({ available: false });
  }

  const taken = await prisma.dbInstance.findFirst({
    where: { slug },
    select: { id: true },
  });
  return NextResponse.json({ available: taken === null });
});
