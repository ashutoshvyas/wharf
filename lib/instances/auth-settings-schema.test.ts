import { describe, expect, it } from "vitest";
import { authSettingsUpdateSchema } from "./auth-settings-schema";

describe("authSettingsUpdateSchema", () => {
  it("accepts a fully empty patch", () => {
    expect(authSettingsUpdateSchema.parse({})).toEqual({});
  });

  it("strips empty-string secret fields (keep existing)", () => {
    const out = authSettingsUpdateSchema.parse({
      googleEnabled: true,
      smtpPass: "",
      googleSecret: "",
      githubSecret: "",
      azureSecret: "",
      appleSecret: "",
    });
    expect(out).toEqual({ googleEnabled: true });
    expect("smtpPass" in out).toBe(false);
    expect("googleSecret" in out).toBe(false);
  });

  it("keeps non-empty secrets", () => {
    const out = authSettingsUpdateSchema.parse({
      googleSecret: "real-secret",
      smtpPass: "real-pass",
    });
    expect(out.googleSecret).toBe("real-secret");
    expect(out.smtpPass).toBe("real-pass");
  });

  it.each([
    "additionalRedirectUrls",
    "smtpHost",
    "smtpUser",
    "smtpSenderName",
    "smtpAdminEmail",
    "googleClientId",
    "githubClientId",
    "azureClientId",
    "appleClientId",
  ])("rejects a line break in %s (.env injection guard)", (field) => {
    expect(
      authSettingsUpdateSchema.safeParse({ [field]: "line1\nEVIL=1" }).success,
    ).toBe(false);
    expect(
      authSettingsUpdateSchema.safeParse({ [field]: "line1\rEVIL=1" }).success,
    ).toBe(false);
  });

  // Apple's "secret" is an ES256 JWT the developer signs themselves, not a
  // short opaque string — three base64url segments run well past the 1024
  // every other provider's secret is capped at.
  it("accepts an Apple client secret longer than the other providers' 1024 cap", () => {
    const jwt = `${"a".repeat(400)}.${"b".repeat(900)}.${"c".repeat(300)}`;
    expect(jwt.length).toBeGreaterThan(1024);
    const out = authSettingsUpdateSchema.parse({ appleEnabled: true, appleSecret: jwt });
    expect(out.appleSecret).toBe(jwt);
    expect(authSettingsUpdateSchema.safeParse({ googleSecret: jwt }).success).toBe(false);
  });

  it("validates jwtExpirySeconds bounds", () => {
    expect(authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 60 }).success).toBe(false);
    expect(
      authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 1_000_000 }).success,
    ).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 3600 }).success).toBe(
      true,
    );
  });

  it("validates smtpPort bounds", () => {
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 0 }).success).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 70_000 }).success).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 587 }).success).toBe(true);
  });

  describe("emailTemplates", () => {
    it("accepts a well-formed entry with subject and multi-line bodyHtml", () => {
      const out = authSettingsUpdateSchema.parse({
        emailTemplates: [
          { flow: "confirmation", subject: "Confirm your signup", bodyHtml: "<p>line1\nline2</p>" },
        ],
      });
      expect(out.emailTemplates).toEqual([
        { flow: "confirmation", subject: "Confirm your signup", bodyHtml: "<p>line1\nline2</p>" },
      ]);
    });

    it("rejects a line break in subject (.env injection guard, unlike bodyHtml)", () => {
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "confirmation", subject: "line1\nEVIL=1" }],
        }).success,
      ).toBe(false);
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "confirmation", subject: "line1\rEVIL=1" }],
        }).success,
      ).toBe(false);
    });

    it("allows multi-line bodyHtml — it's served over its own route, never written into .env", () => {
      const html = "<html>\n<body>\n<p>{{ .ConfirmationURL }}</p>\n</body>\n</html>";
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "recovery", bodyHtml: html }],
        }).success,
      ).toBe(true);
    });

    it("rejects an unknown flow", () => {
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "not-a-real-flow", subject: "x" }],
        }).success,
      ).toBe(false);
    });

    it("rejects a duplicate flow within the same array", () => {
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [
            { flow: "invite", subject: "a" },
            { flow: "invite", subject: "b" },
          ],
        }).success,
      ).toBe(false);
    });

    it("allows an entry that omits subject or bodyHtml (per-field keep-existing)", () => {
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "magic_link", subject: "Only subject" }],
        }).success,
      ).toBe(true);
      expect(
        authSettingsUpdateSchema.safeParse({
          emailTemplates: [{ flow: "magic_link", bodyHtml: "<p>Only body</p>" }],
        }).success,
      ).toBe(true);
    });
  });
});
