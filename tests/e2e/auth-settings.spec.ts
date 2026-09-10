/** Regression checks against real sessions, HTTP handlers and PostgreSQL.
 * No SSH or outbound provider requests: writes stop at validation/RBAC.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { test, expect, ensureUsers, cleanup, login, prisma, E2E_MARKER } from "./fixtures";

let instanceId: string;
const secret = "regression-secret-never-return-in-json";
function encrypted(value: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(process.env.WHARF_MASTER_KEY!, "base64"), iv);
  return new Uint8Array(Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]));
}

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
  const server = await prisma.server.create({ data: {
    name: `${E2E_MARKER}-auth-host`, host: "127.0.0.1", sshPort: 1,
    sshUser: "unused", authMethod: "password", tags: [],
  } });
  const instance = await prisma.dbInstance.create({ data: {
    serverId: server.id, name: "Existing auth regression", slug: `${E2E_MARKER}-auth`,
    composeProjectName: "regression", remotePath: "/unused", status: "stopped",
    apiSubdomain: "api.example.test", studioSubdomain: "studio.example.test",
    jwtSecretEnc: encrypted(secret),
    authSettings: { create: {
      smsProvider: "msg91", smsMsg91AuthKeyEnc: encrypted(secret),
      smsMsg91TemplateId: "existing-template", googleEnabled: true,
      googleClientId: "existing-google-client", googleSecretEnc: encrypted(secret),
      smtpHost: "smtp.example.test", smtpPassEnc: encrypted(secret),
      enablePhoneSignup: true, enablePhoneAutoconfirm: false,
      enableEmailAutoconfirm: false, jwtExpirySeconds: 7200,
    } },
    emailTemplates: { create: { flow: "recovery", subject: "Reset password", bodyHtml: "<p>Recover {{ .ConfirmationURL }}</p>" } },
  } });
  instanceId = instance.id;
});
test.afterAll(async () => {
  if (instanceId) await prisma.dbInstance.delete({ where: { id: instanceId } });
  await cleanup();
});

test("existing MSG91, SMTP, OAuth and session settings retain values without exposing secrets", async ({ page }) => {
  await login(page, "admin");
  const response = await page.request.get(`/api/db-instances/${instanceId}/auth-settings`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    smsProvider: "msg91", smsMsg91AuthKeyConfigured: true, smsMsg91TemplateId: "existing-template",
    smtpHost: "smtp.example.test", smtpPassConfigured: true,
    googleEnabled: true, googleClientId: "existing-google-client", googleSecretConfigured: true,
    enablePhoneSignup: true, enablePhoneAutoconfirm: false, enableEmailAutoconfirm: false,
    jwtExpirySeconds: 7200, smsTwilioDeliveryChannel: "sms", smsTwilioSmsFallback: false,
  });
  expect(body.emailTemplates).toHaveLength(6);
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(JSON.stringify(body)).not.toContain("SecretEnc");
});

for (const role of ["operator", "viewer"] as const) {
  test(`${role} cannot change existing authentication settings`, async ({ page }) => {
    await login(page, role);
    const url = `/api/db-instances/${instanceId}/auth-settings`;
    expect((await page.request.get(url)).status()).toBe(role === "operator" ? 200 : 403);
    expect((await page.request.patch(url, { data: { disableSignup: true } })).status()).toBe(403);
    expect((await prisma.instanceAuthSettings.findUniqueOrThrow({ where: { dbInstanceId: instanceId } })).disableSignup).toBe(false);
  });
}

test("invalid existing settings fail before persistence or server access", async ({ page }) => {
  await login(page, "admin");
  const before = await prisma.instanceAuthSettings.findUniqueOrThrow({ where: { dbInstanceId: instanceId } });
  for (const data of [{ smtpHost: "smtp.example.test\nINJECT=1" }, { jwtExpirySeconds: -1 }, { googleEnabled: "yes" }]) {
    expect((await page.request.patch(`/api/db-instances/${instanceId}/auth-settings`, { data })).status()).toBe(400);
  }
  expect(await prisma.instanceAuthSettings.findUniqueOrThrow({ where: { dbInstanceId: instanceId } })).toEqual(before);
});

test("recovery email templates remain public and missing templates return 404", async ({ request }) => {
  const response = await request.get(`/api/db-instances/${instanceId}/email-template/recovery`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(await response.text()).toBe("<p>Recover {{ .ConfirmationURL }}</p>");
  expect((await request.get(`/api/db-instances/${instanceId}/email-template/confirmation`)).status()).toBe(404);
  expect((await request.get(`/api/db-instances/${instanceId}/auth-settings`, { maxRedirects: 0 })).status()).not.toBe(200);
});

test("unsigned MSG91 hooks and forged Twilio callbacks cannot send messages", async ({ request }) => {
  expect((await request.post(`/api/db-instances/${instanceId}/sms-hook`, {
    data: { user: { phone: "919999999999" }, sms: { otp: "123456" } },
  })).status()).toBe(401);
  // Unknown delivery IDs are acknowledged without doing work. For signature
  // enforcement, exercise an actual active delivery containing credentials.
  await prisma.phoneDelivery.create({ data: {
    id: "a".repeat(64), dbInstanceId: instanceId, recipientHash: "test", requestHash: "test",
    channel: "whatsapp", fallbackEnabled: true, state: "primary_accepted",
    payloadEnc: encrypted(JSON.stringify({ phone: "+919999999999", otp: "123456",
      callbackBase: `http://127.0.0.1:3210/api/db-instances/${instanceId}/twilio-status`,
      creds: { authToken: secret, accountSid: "AC" + "b".repeat(32) } })),
    expiresAt: new Date(Date.now() + 300_000),
  } });
  expect((await request.post(`/api/db-instances/${instanceId}/twilio-status/${"a".repeat(64)}/primary`, {
    headers: { "x-twilio-signature": "forged-signature" },
    form: { MessageStatus: "undelivered" },
  })).status()).toBe(401);
  const deliveries = await prisma.phoneDelivery.findMany({ where: { dbInstanceId: instanceId } });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.state).toBe("primary_accepted");
  expect(deliveries[0]!.fallbackSid).toBeNull();
});
