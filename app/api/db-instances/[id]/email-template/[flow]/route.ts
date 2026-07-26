/**
 * GET /api/db-instances/:id/email-template/:flow — PUBLIC,
 * unauthenticated (see middleware.ts's PUBLIC_PATHS). Fetched by GoTrue
 * itself via GOTRUE_MAILER_TEMPLATES_<FLOW>, which must be a real HTTP(S)
 * URL — GoTrue has no way to present a session cookie or API key, so this
 * route cannot require auth the way every other route in this app does.
 *
 * Deliberately returns ONLY the stored template HTML for one flow, nothing
 * else about the instance — this is the one API route in the app with no
 * auth check, so its response shape must stay minimal by construction, not
 * just by convention. Relies on the instance id being an unguessable UUID
 * (same trust model as every other unauthenticated-by-necessity endpoint);
 * no separate token, since this serves template markup, not a secret.
 *
 * 400  :flow is not one of the 6 known values
 * 404  unknown/soft-deleted instance, or no custom template stored for
 *      this flow (GoTrue's own fetch-failure fallback behavior treats this
 *      the same as an empty template: falls back to its built-in default)
 */
import { apiError, withErrorHandling } from "@/lib/api-helpers";
import { prisma } from "@/lib/db";
import { EMAIL_TEMPLATE_FLOWS, type EmailTemplateFlow } from "@/lib/provision/render";

type Ctx = { params: Promise<{ id: string; flow: string }> };

function isKnownFlow(value: string): value is EmailTemplateFlow {
  return (EMAIL_TEMPLATE_FLOWS as readonly string[]).includes(value);
}

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx): Promise<Response> => {
  const { id, flow } = await params;
  if (!isKnownFlow(flow)) {
    return apiError(400, `Unknown email template flow "${flow}".`);
  }

  const template = await prisma.instanceEmailTemplate.findUnique({
    where: { dbInstanceId_flow: { dbInstanceId: id, flow } },
    select: { bodyHtml: true, dbInstance: { select: { deletedAt: true } } },
  });
  if (!template || template.dbInstance.deletedAt || !template.bodyHtml) {
    return apiError(404, "No custom template stored for this instance/flow.");
  }

  return new Response(template.bodyHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
