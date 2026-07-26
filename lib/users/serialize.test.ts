import { describe, expect, it } from "vitest";
import type { PanelUser } from "@prisma/client";
import { serializeUser } from "./serialize";
import { createInvite } from "./invite";

function fullRow(over: Partial<PanelUser> = {}): PanelUser {
  return {
    id: "usr-1",
    email: "ada@example.com",
    passwordHash: "$2b$12$Y0uSh0uldNeverSeeThisHashInAnAPIResponseAtAll",
    role: "admin",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...over,
  };
}

describe("serializeUser", () => {
  it("exposes exactly the allowlisted fields", () => {
    expect(Object.keys(serializeUser(fullRow())).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "role",
      "updatedAt",
    ]);
  });

  it("never leaks a bcrypt passwordHash", () => {
    const out = serializeUser(fullRow());
    for (const key of Object.keys(out)) {
      expect(key).not.toMatch(/password|hash|secret/i);
    }
    expect(JSON.stringify(out)).not.toContain("$2b$12$");
    expect(JSON.stringify(out)).not.toContain("Y0uSh0uldNeverSeeThis");
  });

  it("never leaks a pending-invite sentinel either", () => {
    const invite = createInvite();
    const out = serializeUser(fullRow({ passwordHash: invite.passwordHash }));
    const json = JSON.stringify(out);
    expect(json).not.toContain("invite$");
    expect(json).not.toContain(invite.token);
  });

  it("passes through the allowlisted values unchanged", () => {
    const row = fullRow();
    expect(serializeUser(row)).toEqual({
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
});
