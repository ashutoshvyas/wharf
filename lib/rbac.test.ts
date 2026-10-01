import { describe, expect, it } from "vitest";
import { can, ForbiddenError, requireRole, type Action, type Role } from "./rbac";

function sessionFor(role: Role) {
  return { user: { role } };
}

describe("can() — role matrix spot checks", () => {
  describe("viewer is read-only everywhere", () => {
    const reads: Action[] = [
      "servers.read",
      "websites.read",
      "instances.read",
      "audit.read",
    ];
    it.each(reads)("viewer can %s", (action) => {
      expect(can("viewer", action)).toBe(true);
    });

    const writes: Action[] = [
      "servers.write",
      "server.bootstrap",
      "server.delete",
      "server.check",
      "terminal",
      "websites.write",
      "instance.provision",
      "instance.stopstart",
      "instance.retry",
      "instance.remove",
      "instance.restore",
      "instance.ssl-mode.write",
      "instance.network-access.write",
      "instance.auth-settings.write",
      "secrets.reveal",
      "users",
    ];
    it.each(writes)("viewer cannot %s", (action) => {
      expect(can("viewer", action)).toBe(false);
    });
  });

  describe("operator: day-to-day, no server admin / removal / users", () => {
    const allowed: Action[] = [
      "servers.read",
      "server.check",
      "terminal",
      "websites.read",
      "websites.write",
      "instances.read",
      "instance.provision",
      "instance.stopstart",
      "instance.retry",
      "secrets.reveal",
      "audit.read",
    ];
    it.each(allowed)("operator can %s", (action) => {
      expect(can("operator", action)).toBe(true);
    });

    const denied: Action[] = [
      "servers.write",
      "server.bootstrap",
      "server.delete",
      "instance.remove",
      "instance.restore",
      "instance.ssl-mode.write",
      "instance.network-access.write",
      "instance.auth-settings.write",
      "users",
    ];
    it.each(denied)("operator cannot %s", (action) => {
      expect(can("operator", action)).toBe(false);
    });
  });

  describe("admin can do everything", () => {
    const everything: Action[] = [
      "servers.read",
      "servers.write",
      "server.bootstrap",
      "server.delete",
      "server.check",
      "terminal",
      "websites.read",
      "websites.write",
      "instances.read",
      "instance.provision",
      "instance.stopstart",
      "instance.retry",
      "instance.remove",
      "instance.restore",
      "instance.ssl-mode.write",
      "instance.network-access.write",
      "instance.auth-settings.write",
      "secrets.reveal",
      "audit.read",
      "users",
    ];
    it.each(everything)("admin can %s", (action) => {
      expect(can("admin", action)).toBe(true);
    });
  });

  it("returns false for undefined/null role", () => {
    expect(can(undefined, "servers.read")).toBe(false);
    expect(can(null, "servers.read")).toBe(false);
  });
});

describe("requireRole()", () => {
  it("returns the role when permitted", () => {
    expect(requireRole(sessionFor("admin"), "users")).toBe("admin");
    expect(requireRole(sessionFor("operator"), "instance.provision")).toBe(
      "operator",
    );
    expect(requireRole(sessionFor("viewer"), "audit.read")).toBe("viewer");
  });

  it("throws ForbiddenError with status 403 for a denied action", () => {
    expect(() => requireRole(sessionFor("viewer"), "terminal")).toThrowError(
      ForbiddenError,
    );
    try {
      requireRole(sessionFor("operator"), "instance.remove");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).status).toBe(403);
      expect((err as ForbiddenError).message).toContain("instance.remove");
    }
  });

  it("throws ForbiddenError for null/missing sessions", () => {
    expect(() => requireRole(null, "servers.read")).toThrowError(ForbiddenError);
    expect(() => requireRole(undefined, "servers.read")).toThrowError(
      ForbiddenError,
    );
    expect(() => requireRole({}, "servers.read")).toThrowError(ForbiddenError);
  });
});
