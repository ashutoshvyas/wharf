import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: (...a: unknown[]) => sftpWriteMock(...a),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const instanceFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: { findFirst: (...a: unknown[]) => instanceFindFirst(...a) },
  },
}));

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted-value" }));

const renderMock = vi.fn();
vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  return {
    ...actual,
    renderInstanceCompose: (...a: unknown[]) => renderMock(...a),
  };
});

import { applyAuthSettings, decryptAuthSettings, toEmailTemplateValues } from "./auth-settings";
import { DEFAULT_AUTH_SETTINGS, type AuthSettingsValues } from "./render";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const ROW = {
  id: "inst-1",
  serverId: "srv-1",
  slug: "clienta",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  pgPasswordEnc: Buffer.from("sealed-pg"),
  jwtSecretEnc: Buffer.from("sealed-jwt"),
  anonKeyEnc: Buffer.from("sealed-anon"),
  serviceRoleKeyEnc: Buffer.from("sealed-sr"),
};

const SETTINGS: AuthSettingsValues = {
  ...DEFAULT_AUTH_SETTINGS,
  googleEnabled: true,
  googleClientId: "google-id",
  googleSecret: "google-secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTANCE_DOMAIN = "wharf.example.com";
  instanceFindFirst.mockResolvedValue({ ...ROW });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  execMock.mockResolvedValue(ok());
  sftpWriteMock.mockResolvedValue(undefined);
  renderMock.mockResolvedValue({
    composeYaml: "rendered-compose",
    envFile: "rendered-env",
  });
});

describe("decryptAuthSettings", () => {
  it("returns the exact render.ts defaults when no row exists", () => {
    expect(decryptAuthSettings(null)).toEqual(DEFAULT_AUTH_SETTINGS);
  });

  it("falls back per-field to defaults for anything the operator never touched", () => {
    const values = decryptAuthSettings({
      id: "s1",
      dbInstanceId: "inst-1",
      disableSignup: true,
      enableEmailSignup: true,
      enableEmailAutoconfirm: true,
      enablePhoneSignup: false,
      enablePhoneAutoconfirm: true,
      enableAnonymousUsers: false,
      manualLinkingEnabled: false,
      jwtExpirySeconds: 3600,
      additionalRedirectUrls: null,
      siteUrl: null,
      oauthCallbackUrl: null,
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPassEnc: null,
      smtpSenderName: null,
      smtpAdminEmail: null,
      googleEnabled: true,
      googleClientId: "configured-google-id",
      googleSecretEnc: Buffer.from("sealed"),
      googleSkipNonceCheck: true,
      googleEmailOptional: false,
      githubEnabled: false,
      githubClientId: null,
      githubSecretEnc: null,
      azureEnabled: false,
      azureClientId: null,
      azureSecretEnc: null,
      appleEnabled: true,
      appleClientId: "com.example.app.web",
      appleSecretEnc: Buffer.from("sealed"),
      appleEmailOptional: true,
      smsProvider: "msg91",
      smsOtpExp: null,
      smsOtpLength: null,
      smsMaxFrequency: null,
      smsTemplate: null,
      smsTwilioAccountSid: null,
      smsTwilioAuthTokenEnc: null,
      smsTwilioMessageServiceSid: null,
      smsTwilioDeliveryChannel: "sms",
      smsTwilioWhatsappSender: null,
      smsTwilioContentSid: null,
      smsTwilioSmsFallback: false,
      smsMsg91AuthKeyEnc: Buffer.from("sealed"),
      smsMsg91TemplateId: "1234",
      smsMsg91SenderId: null,
      smsMsg91OtpVariable: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Explicitly set fields survive.
    expect(values.disableSignup).toBe(true);
    expect(values.googleEnabled).toBe(true);
    expect(values.googleClientId).toBe("configured-google-id");
    expect(values.googleSecret).toBe("decrypted-value");
    // Untouched SMTP fields fall back to the template's own defaults, not "".
    expect(values.smtpHost).toBe(DEFAULT_AUTH_SETTINGS.smtpHost);
    expect(values.smtpPort).toBe(DEFAULT_AUTH_SETTINGS.smtpPort);
    expect(values.smtpPass).toBe(DEFAULT_AUTH_SETTINGS.smtpPass);
    // Untouched provider fields fall back to defaults.
    expect(values.githubEnabled).toBe(false);
    expect(values.githubClientId).toBe(DEFAULT_AUTH_SETTINGS.githubClientId);
    expect(values.azureClientId).toBe(DEFAULT_AUTH_SETTINGS.azureClientId);
    // Apple decrypts the same way as the rest, Services ID and all.
    expect(values.appleEnabled).toBe(true);
    expect(values.appleClientId).toBe("com.example.app.web");
    expect(values.appleSecret).toBe("decrypted-value");
  });
});

describe("applyAuthSettings", () => {
  it("refuses an instance with no stored secrets", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, pgPasswordEnc: null });
    await expect(applyAuthSettings("inst-1", SETTINGS)).rejects.toThrow(
      /no stored secrets/,
    );
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown instance", async () => {
    instanceFindFirst.mockResolvedValue(null);
    await expect(applyAuthSettings("inst-1", SETTINGS)).rejects.toThrow(/was not found/);
  });

  it("returns the lock holder instead of applying concurrently", async () => {
    const release = tryAcquireServerLock("srv-1", "provision")!;
    const res = await applyAuthSettings("inst-1", SETTINGS);
    expect(res).toEqual({ busy: "provision" });
    expect(renderMock).not.toHaveBeenCalled();
    release();
  });

  it("re-renders with the given settings, uploads both files, restarts only auth", async () => {
    const res = await applyAuthSettings("inst-1", SETTINGS);
    expect(res).toEqual({ ok: true });

    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "clienta",
        project: "sb_4f2a",
        remotePath: "/opt/db-instances/sb_4f2a",
        authSettings: SETTINGS,
      }),
    );

    const uploadedPaths = sftpWriteMock.mock.calls.map((c) => c[1] as string);
    expect(uploadedPaths).toContain("/opt/db-instances/sb_4f2a/docker-compose.yml");
    expect(uploadedPaths).toContain("/opt/db-instances/sb_4f2a/.env");

    const composeCall = execMock.mock.calls.find((c) => String(c[1]).includes("docker compose"));
    expect(composeCall?.[1]).toBe(
      "cd /opt/db-instances/sb_4f2a && docker compose -p sb_4f2a up -d auth",
    );
    // Scoped restart: db/kong/studio are never named as services. Matched
    // against the compose fragment alone — the `cd` path legitimately
    // contains "db-instances".
    const composeFragment = String(composeCall?.[1]).split("&&")[1];
    expect(composeFragment).not.toMatch(/\b(db|kong|studio)\b/);

    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("releases the lock and propagates the error when the restart fails", async () => {
    execMock.mockResolvedValue(fail("connection refused"));
    await expect(applyAuthSettings("inst-1", SETTINGS)).rejects.toThrow(
      /docker compose up -d auth failed/,
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("threads emailTemplates through to the render call, and PANEL_URL for the serving URL", async () => {
    process.env.PANEL_URL = "https://wharf.example.com";
    const templates = toEmailTemplateValues([
      { flow: "confirmation", subject: "Confirm", bodyHtml: "<p>hi</p>" },
      { flow: "recovery", subject: "", bodyHtml: null },
    ]);
    await applyAuthSettings("inst-1", SETTINGS, templates);
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-1",
        panelUrl: "https://wharf.example.com",
        emailTemplates: [
          { flow: "confirmation", subject: "Confirm", hasBody: true },
          { flow: "recovery", subject: "", hasBody: false },
        ],
      }),
    );
  });
});

describe("toEmailTemplateValues", () => {
  it("derives hasBody from whether bodyHtml is set, passes subject through as-is", () => {
    expect(
      toEmailTemplateValues([
        { flow: "invite", subject: "You're invited", bodyHtml: "<p>x</p>" },
        { flow: "magic_link", subject: null, bodyHtml: null },
      ]),
    ).toEqual([
      { flow: "invite", subject: "You're invited", hasBody: true },
      { flow: "magic_link", subject: "", hasBody: false },
    ]);
  });
});

describe("hook configuration persistence", () => {
  it("saves hook credentials under the lock before restarting Auth", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    await applyAuthSettings("inst-1", SETTINGS, [], persist);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(sftpWriteMock.mock.invocationCallOrder[0]!);
    expect(persist.mock.invocationCallOrder[0]).toBeGreaterThan(renderMock.mock.invocationCallOrder[0]!);
  });
  it("does not save when the server is busy or proceed to SSH after a database failure", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const release = tryAcquireServerLock("srv-1", "busy");
    expect(typeof release).toBe("function");
    try {
      expect(await applyAuthSettings("inst-1", SETTINGS, [], persist)).toHaveProperty("busy");
      expect(persist).not.toHaveBeenCalled();
    } finally { if (typeof release === "function") release(); }
    await expect(applyAuthSettings("inst-1", SETTINGS, [], persist)).rejects.toThrow("database unavailable");
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });
});
