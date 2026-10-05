/**
 * The instance DTO defines the API contract
 * (docs/provisioning-contract.md §1). These tests pin the allowlist: exact
 * key set, ISO date strings, and — the security-critical one — that no
 * ciphertext column or secret value can leak through the serializer even when
 * the row carries all four of them.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DbInstance } from "@prisma/client";
import { endJob, startJob } from "@/lib/jobs/stream";
import {
  INSTANCE_INCLUDE,
  serializeInstance,
  type DbInstanceRecord,
} from "./serialize";

/** A fully-populated row, every nullable field set and every secret sealed. */
function fullRow(): DbInstance & { server: { id: string; name: string; host: string } } {
  return {
    id: "inst-1",
    serverId: "srv-1",
    name: "clienta-prod",
    slug: "clienta",
    composeProjectName: "sb_4f2a",
    remotePath: "/opt/db-instances/sb_4f2a",
    apiSubdomain: "clienta.wharf.example.com",
    studioSubdomain: "studio-clienta.wharf.example.com",
    sslMode: "require",
    networkAccess: null,
    networkAccessAppliedAt: null,
    networkAccessError: null,
    pgPasswordEnc: Buffer.from("sealed-pg-password"),
    anonKeyEnc: Buffer.from("sealed-anon-key"),
    serviceRoleKeyEnc: Buffer.from("sealed-service-role-key"),
    jwtSecretEnc: Buffer.from("sealed-jwt-secret"),
    status: "running",
    lastActionLog: "✓ health",
    healthCheckedAt: new Date("2026-07-24T18:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-07-24T17:55:00.000Z"),
    updatedAt: new Date("2026-07-24T18:00:00.000Z"),
    server: { id: "srv-1", name: "db-01", host: "192.0.2.10" },
  };
}

const CONTRACT_KEYS = [
  "id",
  "name",
  "slug",
  "serverId",
  "server",
  "composeProjectName",
  "remotePath",
  "apiSubdomain",
  "studioSubdomain",
  "sslMode",
  "status",
  "lastActionLog",
  "healthCheckedAt",
  "createdAt",
  "updatedAt",
  // Derived, not a column — which engine holds a live job.
  "activeJob",
];

describe("serializeInstance", () => {
  it("emits zero encrypted/secret keys for a fully-populated row", () => {
    const out = serializeInstance(fullRow());
    for (const key of Object.keys(out)) {
      expect(key).not.toMatch(/enc$/i);
      expect(key).not.toMatch(/password|key|secret|token/i);
    }
    const json = JSON.stringify(out);
    expect(json).not.toContain("sealed-");
    expect(json).not.toContain("Enc");
  });

  it("never leaks a secret value even when the row is deeply inspected", () => {
    const out = serializeInstance(fullRow()) as unknown as Record<string, unknown>;
    for (const field of [
      "pgPasswordEnc",
      "anonKeyEnc",
      "serviceRoleKeyEnc",
      "jwtSecretEnc",
    ]) {
      expect(out[field]).toBeUndefined();
    }
    // deletedAt is filtered upstream and deliberately not part of the wire shape.
    expect(out.deletedAt).toBeUndefined();
  });

  it("exposes exactly the contract §1 fields", () => {
    const out = serializeInstance(fullRow());
    expect(Object.keys(out).sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  it("formats every date as an ISO-8601 string", () => {
    const out = serializeInstance(fullRow());
    expect(out.createdAt).toBe("2026-07-24T17:55:00.000Z");
    expect(out.updatedAt).toBe("2026-07-24T18:00:00.000Z");
    expect(out.healthCheckedAt).toBe("2026-07-24T18:00:00.000Z");
  });

  it("passes nullable fields through as null", () => {
    const out = serializeInstance({
      ...fullRow(),
      lastActionLog: null,
      healthCheckedAt: null,
    });
    expect(out.lastActionLog).toBeNull();
    expect(out.healthCheckedAt).toBeNull();
  });

  it("omits `server` when the relation was not included", () => {
    const { server: _drop, ...row } = fullRow();
    void _drop;
    const out = serializeInstance(row as DbInstanceRecord);
    expect("server" in out).toBe(false);
    expect(out.serverId).toBe("srv-1");
  });

  it("embeds public server identity and host without credentials", () => {
    const out = serializeInstance({
      ...fullRow(),
      // Extra relation fields must not survive the allowlist.
      server: { id: "srv-1", name: "db-01", host: "10.0.0.1", sshPasswordEnc: Buffer.from("secret") },
    } as DbInstanceRecord);
    expect(out.server).toEqual({ id: "srv-1", name: "db-01", host: "10.0.0.1" });
  });

  it("preserves the status verbatim (only the engine writes it)", () => {
    for (const status of ["provisioning", "running", "stopped", "error", "removing"]) {
      expect(serializeInstance({ ...fullRow(), status }).status).toBe(status);
    }
  });
});

/**
 * `restoring` no longer identifies which engine is running (restore
 * and sync share it), so the DTO reports the live job id's kind instead.
 */
describe("activeJob", () => {
  afterEach(() => {
    for (const prefix of ["provision", "remove", "restore", "sync", "clone"]) {
      endJob(`${prefix}:inst-1`, "ok");
    }
  });

  it("is null when no job is running for this instance", () => {
    expect(serializeInstance(fullRow()).activeJob).toBeNull();
  });

  it.each([
    ["provision", "provision:inst-1"],
    ["remove", "remove:inst-1"],
    ["restore", "restore:inst-1"],
    ["sync", "sync:inst-1"],
    ["clone", "clone:inst-1"],
  ])("reports a live %s job", (kind, jobId) => {
    startJob(jobId);
    expect(serializeInstance(fullRow()).activeJob).toBe(kind);
  });

  it("ignores a job belonging to a different instance", () => {
    startJob("sync:other-instance");
    expect(serializeInstance(fullRow()).activeJob).toBeNull();
    endJob("sync:other-instance", "ok");
  });

  it("goes back to null once the job ends", () => {
    startJob("sync:inst-1");
    endJob("sync:inst-1", "ok");
    expect(serializeInstance(fullRow()).activeJob).toBeNull();
  });
});

describe("INSTANCE_INCLUDE", () => {
  it("selects only the public identity and host of the related server", () => {
    expect(INSTANCE_INCLUDE).toEqual({
      server: { select: { id: true, name: true, host: true } },
    });
  });

  it("never selects an encrypted column", () => {
    expect(JSON.stringify(INSTANCE_INCLUDE)).not.toMatch(/enc/i);
  });
});
