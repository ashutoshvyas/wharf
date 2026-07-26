import { describe, expect, it } from "vitest";
import type { Server } from "@prisma/client";
import { serializeServer } from "./serialize";

function fullRow(): Server & { _count: { websites: number; dbInstances: number } } {
  return {
    id: "srv-1",
    name: "web-1",
    host: "203.0.113.10",
    sshPort: 22,
    sshUser: "root",
    authMethod: "password",
    sshPasswordEnc: Buffer.from("sealed-ssh-password"),
    sshPrivateKeyEnc: Buffer.from("sealed-private-key"),
    linkedPanelUrl: "https://panel.example.com",
    panelUserEnc: Buffer.from("sealed-panel-user"),
    panelPassEnc: Buffer.from("sealed-panel-pass"),
    bootstrapped: true,
    reachable: true,
    hostKeyFingerprint: "SHA256:abcdef",
    tags: ["prod"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    _count: { websites: 3, dbInstances: 2 },
  };
}

describe("serializeServer", () => {
  it("emits zero encrypted/secret keys for a fully-populated row", () => {
    const out = serializeServer(fullRow());
    const keys = Object.keys(out);
    for (const key of keys) {
      expect(key).not.toMatch(/enc/i);
      expect(key).not.toMatch(/password|privatekey|panelpass|paneluser/i);
    }
    const json = JSON.stringify(out);
    expect(json).not.toContain("sealed-");
  });

  it("exposes exactly the allowlisted fields", () => {
    const out = serializeServer(fullRow());
    expect(Object.keys(out).sort()).toEqual(
      [
        "authMethod",
        "bootstrapped",
        "counts",
        "createdAt",
        "hasPanelCredential",
        "host",
        "hostKeyFingerprint",
        "id",
        "linkedPanelUrl",
        "name",
        "reachable",
        "sshPort",
        "sshUser",
        "tags",
        "updatedAt",
      ].sort(),
    );
  });

  it("derives hasPanelCredential from the encrypted columns", () => {
    expect(serializeServer(fullRow()).hasPanelCredential).toBe(true);
    const bare = { ...fullRow(), panelUserEnc: null, panelPassEnc: null };
    expect(serializeServer(bare).hasPanelCredential).toBe(false);
  });

  it("includes counts only when _count is present", () => {
    const withCounts = serializeServer(fullRow());
    expect(withCounts.counts).toEqual({ websites: 3, dbInstances: 2 });
    const { _count: _drop, ...row } = fullRow();
    void _drop;
    const without = serializeServer(row as Server);
    expect(without.counts).toBeUndefined();
  });
});
