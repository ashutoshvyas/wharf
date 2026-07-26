import { beforeEach, describe, expect, it } from "vitest";
import { isTrustedInstanceHost } from "./instance-host";

describe("isTrustedInstanceHost", () => {
  beforeEach(() => {
    process.env.INSTANCE_DOMAIN = "wharf.example.com";
    process.env.PANEL_URL = "https://panel.wharf.example.com";
  });

  it("trusts a studio- subdomain under INSTANCE_DOMAIN", () => {
    expect(isTrustedInstanceHost("studio-clienta.wharf.example.com")).toBe(true);
  });

  it("trusts a bare instance API subdomain under INSTANCE_DOMAIN", () => {
    expect(isTrustedInstanceHost("clienta.wharf.example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isTrustedInstanceHost("Studio-Clienta.WHARF.EXAMPLE.COM")).toBe(true);
  });

  it("also trusts the bare apex itself (not a real instance shape, but not the panel either)", () => {
    expect(isTrustedInstanceHost("wharf.example.com")).toBe(true);
  });

  it("refuses the panel's own host", () => {
    expect(isTrustedInstanceHost("panel.wharf.example.com")).toBe(false);
  });

  it("refuses a host outside INSTANCE_DOMAIN entirely", () => {
    expect(isTrustedInstanceHost("evil.example.com")).toBe(false);
  });

  it("refuses a host that merely contains INSTANCE_DOMAIN as a substring", () => {
    expect(isTrustedInstanceHost("wharf.example.com.evil.com")).toBe(false);
  });

  it("refuses everything when INSTANCE_DOMAIN is not configured", () => {
    delete process.env.INSTANCE_DOMAIN;
    expect(isTrustedInstanceHost("studio-clienta.wharf.example.com")).toBe(false);
  });

  it("still refuses the panel host when PANEL_URL is malformed", () => {
    process.env.PANEL_URL = "not a url";
    expect(isTrustedInstanceHost("studio-clienta.wharf.example.com")).toBe(true);
  });
});
