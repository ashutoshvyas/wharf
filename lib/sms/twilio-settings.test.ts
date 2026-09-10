import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_SETTINGS } from "@/lib/provision/render";
import { twilioSettingsError } from "./twilio-settings";
const settings = {
  ...DEFAULT_AUTH_SETTINGS,
  smsProvider: "twilio" as const,
  smsTwilioAccountSid: `AC${"a".repeat(32)}`,
  smsTwilioAuthToken: "secret",
  smsTwilioMessageServiceSid: `MG${"b".repeat(32)}`,
};
const url = "https://wharf.example";
describe("Twilio merged settings validation", () => {
  it("does not require WhatsApp fields for SMS or validate inactive providers", () => {
    expect(twilioSettingsError(settings, url)).toBeNull();
    expect(twilioSettingsError({ ...DEFAULT_AUTH_SETTINGS, smsProvider: "msg91" })).toBeNull();
  });
  it("requires secure callback configuration and actual account credentials", () => {
    for (const panelUrl of [undefined, "http://example.com", "https://user:pass@example.com", "https://example.com?x=1", "https://example.com#x"]) {
      expect(twilioSettingsError(settings, panelUrl)).toContain("PANEL_URL");
    }
    expect(twilioSettingsError({ ...settings, smsTwilioAuthToken: "" }, url)).toContain("auth token");
    expect(twilioSettingsError({ ...settings, smsTwilioAccountSid: "AC123" }, url)).toContain("account SID");
  });
  it("requires WhatsApp configuration and an SMS service only if fallback is enabled", () => {
    const wa = { ...settings, smsTwilioDeliveryChannel: "whatsapp" as const, smsTwilioMessageServiceSid: "" };
    expect(twilioSettingsError(wa, url)).toContain("WhatsApp sender");
    wa.smsTwilioWhatsappSender = "+14155551234";
    expect(twilioSettingsError(wa, url)).toContain("template SID");
    wa.smsTwilioContentSid = `HX${"a".repeat(32)}`;
    expect(twilioSettingsError(wa, url)).toBeNull();
    expect(twilioSettingsError({ ...wa, smsTwilioSmsFallback: true }, url)).toContain("Messaging Service");
    expect(twilioSettingsError({ ...settings, smsTwilioSmsFallback: true }, url)).toContain("only available");
  });
  it("refuses SMS templates that lose the code or use unsupported Go expressions", () => {
    for (const smsTemplate of ["Hello", "{{ .Code }} {{ .Phone }}", "{{if .Code}}yes{{end}}", "x".repeat(1600) + "{{.Code}}"])
      expect(twilioSettingsError({ ...settings, smsTemplate }, url)).not.toBeNull();
    expect(twilioSettingsError({ ...settings, smsTemplate: "Code: {{.Code}}" }, url)).toBeNull();
  });
});
