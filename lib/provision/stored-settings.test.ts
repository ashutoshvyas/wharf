import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceAuthSettings } from "@prisma/client";

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted-secret" }));

import { DEFAULT_AUTH_SETTINGS, renderInstanceCompose, type RenderInstanceInput } from "./render";
import { storedRenderSettings } from "./stored-settings";

const BASE: RenderInstanceInput = {
  slug: "clienta",
  project: "sb_4f2a",
  domain: "wharf.example.com",
  remotePath: "/opt/db-instances/sb_4f2a",
  secrets: {
    pgPassword: "aB3dE6gH9jK2mN5pQ8sT1vW4xY7zA0bC",
    jwtSecret: "d".repeat(80),
    anonKey: "anon",
    serviceRoleKey: "service-role",
  },
};

/** Only the fields under test; decryptAuthSettings falls back for the rest. */
const AUTH_ROW = {
  googleEnabled: true,
  googleClientId: "configured-google-id",
  googleSecretEnc: Buffer.from("sealed"),
  smtpHost: "smtp.example.com",
} as unknown as InstanceAuthSettings;

afterEach(() => {
  delete process.env.PANEL_URL;
});

describe("storedRenderSettings", () => {
  it("reads a never-configured instance as the render defaults", () => {
    process.env.PANEL_URL = "https://panel.example.com";
    expect(storedRenderSettings({ id: "inst-1" })).toEqual({
      authSettings: DEFAULT_AUTH_SETTINGS,
      emailTemplates: [],
      analyticsSettings: { enabled: false },
      instanceId: "inst-1",
      panelUrl: "https://panel.example.com",
    });
  });

  it("renders a never-configured instance byte-identical to a fresh provision", async () => {
    process.env.PANEL_URL = "https://panel.example.com";
    const fresh = await renderInstanceCompose(BASE);
    const stored = await renderInstanceCompose({ ...BASE, ...storedRenderSettings({ id: "inst-1" }) });
    expect(stored).toEqual(fresh);
  });

  it("carries every stored setting, so a re-render cannot reset what it did not change", () => {
    const out = storedRenderSettings({
      id: "inst-1",
      authSettings: AUTH_ROW,
      emailTemplates: [{ flow: "invite", subject: "Join us", bodyHtml: "<p>hi</p>" }],
      analyticsSettings: { enabled: true },
    });
    expect(out.authSettings).toMatchObject({
      googleEnabled: true,
      googleClientId: "configured-google-id",
      googleSecret: "decrypted-secret",
      smtpHost: "smtp.example.com",
    });
    expect(out.emailTemplates).toEqual([{ flow: "invite", subject: "Join us", hasBody: true }]);
    expect(out.analyticsSettings).toEqual({ enabled: true });
  });
});
