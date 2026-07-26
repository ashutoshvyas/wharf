/**
 * GET /api/db-instances/:id/email-template/:flow/edit —
 * AUTHENTICATED, distinct from the sibling public serving route one
 * directory up (fetched by GoTrue itself, no session). This one is fetched
 * by the Manage-page form when an operator selects a flow, to load its full
 * stored HTML body into the editor — the main auth-settings GET only
 * returns `hasBody`/`subject` per flow to keep that payload small.
 *
 * Gated `secrets.reveal`, the same tier as the rest of Auth settings —
 * template markup isn't a secret, but editing it is an admin/operator
 * action like everything else on this page.
 *
 * 400  :flow is not one of the 6 known values
 * 404  unknown/soft-deleted instance, or no template stored for this flow
 */
import { NextResponse } from "next/server";
import { apiError, requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { EMAIL_TEMPLATE_FLOWS, type EmailTemplateFlow } from "@/lib/provision/render";

type Ctx = { params: Promise<{ id: string; flow: string }> };

function isKnownFlow(value: string): value is EmailTemplateFlow {
  return (EMAIL_TEMPLATE_FLOWS as readonly string[]).includes(value);
}

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  await requireApiRole("secrets.reveal");
  const { id, flow } = await params;
  if (!isKnownFlow(flow)) {
    return apiError(400, `Unknown email template flow "${flow}".`);
  }

  const instance = await prisma.dbInstance.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!instance) return apiError(404, "Database instance not found");

  const template = await prisma.instanceEmailTemplate.findUnique({
    where: { dbInstanceId_flow: { dbInstanceId: id, flow } },
    select: { subject: true, bodyHtml: true },
  });

  return NextResponse.json(
    { flow, subject: template?.subject ?? "", bodyHtml: template?.bodyHtml ?? "" },
    { headers: { "Cache-Control": "no-store" } },
  );
});
