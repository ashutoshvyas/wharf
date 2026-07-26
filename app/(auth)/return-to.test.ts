import { beforeEach, describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  beforeEach(() => {
    process.env.INSTANCE_DOMAIN = "wharf.example.com";
    process.env.PANEL_URL = "https://panel.wharf.example.com";
  });

  it("passes through a same-origin relative path", () => {
    expect(safeReturnTo("/servers")).toBe("/servers");
  });

  it("passes through an absolute Studio returnTo (a trusted instance host)", () => {
    const value = "https://studio-clienta.wharf.example.com/project/default/editor";
    expect(safeReturnTo(value)).toBe(value);
  });

  it("falls back to /databases for an absolute URL on an untrusted host", () => {
    expect(safeReturnTo("https://evil.example.com/")).toBe("/databases");
  });

  it("falls back to /databases for the panel's own absolute URL", () => {
    expect(safeReturnTo("https://panel.wharf.example.com/databases")).toBe("/databases");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeReturnTo("//evil.example.com")).toBe("/databases");
  });

  it("rejects backslash-prefixed values", () => {
    expect(safeReturnTo("/\\evil.example.com")).toBe("/databases");
  });

  it("falls back to /databases when nothing is provided", () => {
    expect(safeReturnTo(null)).toBe("/databases");
  });

  it("falls back to /databases for a File form-data entry", () => {
    const file = new File(["x"], "x.txt");
    expect(safeReturnTo(file)).toBe("/databases");
  });
});
