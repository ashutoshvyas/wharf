import { describe, expect, it } from "vitest";
import { networkAccessSchema, readNetworkAccess, enableNetworkAccessSchema } from "./network-access";

describe("database network policies", () => {
  it("normalizes bare IPv4/IPv6 addresses, trims whitespace, and removes duplicates", () => {
    expect(networkAccessSchema.parse({ mode: "restricted", allowedCidrs: [" 198.51.100.10 ", "198.51.100.10/32", "2001:DB8::5", "198.51.100.0/24"] }))
      .toEqual({ mode: "restricted", allowedCidrs: ["198.51.100.10/32", "2001:db8::5/128", "198.51.100.0/24"] });
  });
  it.each(["1.2.3.999", "0.0.0.0/33", "::/129", "example.com", "1.2.3.4;reboot", "$(id)", "fe80::1%eth0", "", "192.168.1.1/garbage"])("rejects invalid range %s", (value) => {
    expect(networkAccessSchema.safeParse({ mode: "restricted", allowedCidrs: [value] }).success).toBe(false);
  });
  it("requires an explicit mode and never interprets an empty allowlist as allow all", () => {
    expect(networkAccessSchema.safeParse({ mode: "restricted", allowedCidrs: [] }).success).toBe(false);
    expect(networkAccessSchema.safeParse({ mode: "all", allowedCidrs: [] }).success).toBe(false);
    expect(networkAccessSchema.parse({ mode: "blocked" })).toEqual({ mode: "blocked" });
    expect(networkAccessSchema.parse({ mode: "all" })).toEqual({ mode: "all" });
  });
  it("bounds rule counts and fails closed for corrupt persisted policy", () => {
    expect(networkAccessSchema.safeParse({ mode: "restricted", allowedCidrs: Array(101).fill("1.2.3.4") }).success).toBe(false);
    expect(readNetworkAccess(null)).toEqual({ mode: "all" });
    expect(() => readNetworkAccess({ mode: "typo" })).toThrow();
  });
  it("allows an empty baseline to preserve the allow-all default", () => {
    expect(enableNetworkAccessSchema.parse({ confirmName: "db-host", baselineAllowedCidrs: [] }))
      .toEqual({ confirmName: "db-host", baselineAllowedCidrs: [] });
    expect(enableNetworkAccessSchema.parse({ confirmName: "db-host", baselineAllowedCidrs: ["198.51.100.10"] }))
      .toEqual({ confirmName: "db-host", baselineAllowedCidrs: ["198.51.100.10/32"] });
  });
});
