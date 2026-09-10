import { apiError, withErrorHandling } from "@/lib/api-helpers";
import { handleTwilioStatus } from "@/lib/sms/twilio-delivery";

type Ctx = { params: Promise<{ id: string; deliveryId: string; leg: string }> };
export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const { id, deliveryId, leg } = await params;
  if (!/^[a-f0-9]{64}$/.test(deliveryId) || (leg !== "primary" && leg !== "fallback")) return apiError(404, "Not found.");
  const text = await req.text();
  if (text.length > 32_768) return apiError(413, "Request too large.");
  const fields = new URLSearchParams(text);
  const values: Record<string, string> = {};
  for (const [key, value] of fields) {
    if (Object.hasOwn(values, key)) return apiError(400, "Duplicate parameter.");
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  const valid = await handleTwilioStatus(id, deliveryId, leg, req.headers.get("x-twilio-signature") ?? "", values);
  return valid ? new Response(null, { status: 204 }) : apiError(401, "Unauthorized.");
});
