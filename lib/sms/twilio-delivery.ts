import { createHash, createHmac } from "node:crypto";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import type { PhoneDelivery } from "@prisma/client";
import { prisma } from "@/lib/db";
import { open } from "@/lib/crypto";
import { sealBytes } from "@/lib/servers/seal-bytes";
import type { AuthSettingsValues } from "@/lib/provision/render";
import { internationalPhone, sendTwilioOtp, type TwilioCredentials } from "./twilio";

interface Payload {
  phone: string;
  otp: string;
  creds: TwilioCredentials;
  callbackBase: string;
}
const ACTIVE_PRIMARY = ["primary_sending", "primary_accepted", "primary_unknown"];
const ACCEPTED = ["primary_accepted", "primary_delivered", "primary_unknown", "fallback_accepted", "fallback_delivered", "fallback_unknown"];
const callbackUrl = (p: Payload, id: string, leg: "primary" | "fallback") => `${p.callbackBase}/${id}/${leg}`;

/** Durable claims prevent duplicate sends across processes and hook/callback retries. */
export async function deliverTwilioOtp(input: {
  instanceId: string; webhookId: string; rawBody: string; hookSecret: string;
  phone: string; otp: string; settings: AuthSettingsValues; panelUrl: string; deadlineMs?: number;
}): Promise<boolean> {
  const { settings } = input;
  const deadlineMs = input.deadlineMs ?? Date.now() + 4000;
  const phone = internationalPhone(input.phone);
  if (!phone) return false;
  const id = createHash("sha256").update(`${input.instanceId}:${input.webhookId}`).digest("hex");
  const digest = (value: string) => createHmac("sha256", input.hookSecret).update(value).digest("hex");
  const recipientHash = digest(phone);
  const requestHash = digest(input.rawBody);
  const payload: Payload = {
    phone, otp: input.otp,
    creds: {
      accountSid: settings.smsTwilioAccountSid,
      authToken: settings.smsTwilioAuthToken,
      messageServiceSid: settings.smsTwilioMessageServiceSid,
      whatsappSender: settings.smsTwilioWhatsappSender,
      contentSid: settings.smsTwilioContentSid,
      smsTemplate: settings.smsTemplate,
    },
    callbackBase: `${input.panelUrl.replace(/\/+$/, "")}/api/db-instances/${input.instanceId}/twilio-status`,
  };
  const claimed = await prisma.$transaction(async (tx) => {
    // Serialize new codes for one recipient, without holding the lock during HTTP.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.instanceId}), hashtext(${recipientHash}))`;
    const existing = await tx.phoneDelivery.findUnique({ where: { id } });
    if (existing) return { row: existing, fresh: false };
    await tx.phoneDelivery.updateMany({
      where: { dbInstanceId: input.instanceId, recipientHash, payloadEnc: { not: null } },
      data: { payloadEnc: null, state: "superseded" },
    });
    const row = await tx.phoneDelivery.create({ data: {
      id, dbInstanceId: input.instanceId, recipientHash, requestHash,
      channel: settings.smsTwilioDeliveryChannel,
      fallbackEnabled: settings.smsTwilioDeliveryChannel === "whatsapp" && settings.smsTwilioSmsFallback,
      state: "primary_sending", payloadEnc: sealBytes(JSON.stringify(payload)),
      expiresAt: new Date(Date.now() + settings.smsOtpExp * 1000),
    } });
    return { row, fresh: true };
  }, { timeout: 2000, maxWait: 1000 });
  const row = claimed.row;
  if (!claimed.fresh) return row.requestHash === requestHash && ACCEPTED.includes(row.state);

  const result = await sendTwilioOtp(payload.creds, settings.smsTwilioDeliveryChannel, phone, input.otp,
    callbackUrl(payload, id, "primary"), row.expiresAt, deadlineMs);
  if (result.ok) {
    await prisma.phoneDelivery.updateMany({
      where: { id, state: "primary_sending", payloadEnc: { not: null } },
      data: { primarySid: result.sid, state: ["delivered", "read"].includes(result.status) ? "primary_delivered" : "primary_accepted",
        ...(["delivered", "read"].includes(result.status) ? { payloadEnc: null } : {}) },
    });
    // A signed failure callback may have completed fallback before the POST returned.
    const current = await prisma.phoneDelivery.findUnique({ where: { id } });
    return !!current && (ACCEPTED.includes(current.state) || current.state === "fallback_sending");
  }
  if (result.uncertain) {
    await prisma.phoneDelivery.updateMany({
      where: { id, state: "primary_sending" }, data: { state: "primary_unknown" },
    });
    // Commit the OTP: Twilio may have accepted the send even though its response was lost.
    // A later signed failure callback can safely trigger fallback. Never retry this POST.
    return true;
  }
  console.error(`[twilio-delivery] id=${id} primary rejected code=${result.code}`);
  if (row.fallbackEnabled) return sendFallback(row, payload, deadlineMs);
  await prisma.phoneDelivery.updateMany({
    where: { id, state: { in: ACTIVE_PRIMARY } }, data: { state: "primary_failed", payloadEnc: null },
  });
  return false;
}

async function sendFallback(row: PhoneDelivery, payload: Payload, deadlineMs = Date.now() + 4000): Promise<boolean> {
  const claimed = await prisma.phoneDelivery.updateMany({
    where: {
      id: row.id, state: { in: ACTIVE_PRIMARY }, fallbackEnabled: true,
      expiresAt: { gt: new Date() }, payloadEnc: { not: null },
      instance: { deletedAt: null, authSettings: { smsProvider: "twilio", smsTwilioDeliveryChannel: "whatsapp", smsTwilioSmsFallback: true } },
    },
    data: { state: "fallback_sending" },
  });
  if (!claimed.count) {
    const current = await prisma.phoneDelivery.findUnique({ where: { id: row.id } });
    return !!current && ACCEPTED.includes(current.state);
  }
  const result = await sendTwilioOtp(payload.creds, "sms", payload.phone, payload.otp,
    callbackUrl(payload, row.id, "fallback"), row.expiresAt, deadlineMs);
  await prisma.phoneDelivery.updateMany({
    where: { id: row.id, state: "fallback_sending" },
    data: result.ok
      ? { state: ["delivered", "read"].includes(result.status) ? "fallback_delivered" : "fallback_accepted", fallbackSid: result.sid,
          ...(["delivered", "read"].includes(result.status) ? { payloadEnc: null } : {}) }
      : { state: result.uncertain ? "fallback_unknown" : "fallback_failed", ...(result.uncertain ? {} : { payloadEnc: null }) },
  });
  if (!result.ok) console.error(`[twilio-delivery] id=${row.id} fallback result code=${result.code}`);
  return result.ok || result.uncertain;
}

/** Verify against the exact public callback URL and credential used for this send. */
export async function handleTwilioStatus(
  instanceId: string, deliveryId: string, leg: "primary" | "fallback",
  signature: string, params: Record<string, string>,
): Promise<boolean> {
  const row = await prisma.phoneDelivery.findFirst({
    where: { id: deliveryId, dbInstanceId: instanceId, instance: { deletedAt: null } },
  });
  // Expired/tombstoned rows have no actionable payload; acknowledge without side effects.
  if (!row?.payloadEnc) return true;
  const payload = JSON.parse(open(row.payloadEnc)) as Payload;
  if (!signature || !validateRequest(payload.creds.authToken, signature, callbackUrl(payload, row.id, leg), params)) return false;
  if (params.AccountSid !== payload.creds.accountSid || !/^SM[0-9a-fA-F]{32}$/.test(params.MessageSid ?? "")) return false;
  const expectedTo = leg === "primary" && row.channel === "whatsapp" ? `whatsapp:${payload.phone}` : payload.phone;
  if (params.To !== expectedTo) return false;
  if (row.expiresAt <= new Date()) {
    await prisma.phoneDelivery.updateMany({ where: { id: row.id }, data: { payloadEnc: null, state: "expired" } });
    return true;
  }
  const sidField = leg === "primary" ? "primarySid" : "fallbackSid";
  if (row[sidField] && row[sidField] !== params.MessageSid) return false;
  // Bind early callbacks atomically before acting on them.
  const bound = await prisma.phoneDelivery.updateMany({
    where: { id: row.id, OR: [{ [sidField]: null }, { [sidField]: params.MessageSid }], payloadEnc: { not: null } },
    data: { [sidField]: params.MessageSid },
  });
  if (!bound.count) return true;
  const active = leg === "primary" ? ACTIVE_PRIMARY : ["fallback_sending", "fallback_accepted", "fallback_unknown"];
  if (["delivered", "read"].includes(params.MessageStatus ?? "")) {
    await prisma.phoneDelivery.updateMany({
      where: { id: row.id, state: { in: active } }, data: { state: `${leg}_delivered`, payloadEnc: null },
    });
  } else if (["failed", "undelivered", "canceled"].includes(params.MessageStatus ?? "")) {
    if (leg === "primary" && row.channel === "whatsapp" && row.fallbackEnabled) {
      await sendFallback(row, payload);
    } else {
      await prisma.phoneDelivery.updateMany({
        where: { id: row.id, state: { in: active } }, data: { state: `${leg}_failed`, payloadEnc: null },
      });
    }
  }
  return true;
}

/** Remove encrypted payloads after expiry; retain replay tombstones for 24 hours. */
export async function cleanupPhoneDeliveries(): Promise<void> {
  await prisma.phoneDelivery.updateMany({
    where: { expiresAt: { lte: new Date() }, payloadEnc: { not: null } },
    data: { payloadEnc: null, state: "expired" },
  });
  await prisma.phoneDelivery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86400_000) } } });
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined;
export function startPhoneDeliveryCleanup(): void {
  if (cleanupTimer) return;
  let running = false;
  const clean = async () => {
    if (running) return;
    running = true;
    try { await cleanupPhoneDeliveries(); }
    catch { console.error("[phone-delivery] cleanup failed"); }
    finally { running = false; }
  };
  void clean();
  cleanupTimer = setInterval(() => { void clean(); }, 60_000);
  cleanupTimer.unref();
}
