/**
 * Route-level tests for the Servers API (..022): RBAC gates, secret
 * sealing on create, 409 delete guard, panel-credential reveal, keypair
 * generation. lib/auth, lib/db and lib/crypto are mocked (same style as
 * lib/api-helpers.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    server: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  seal: vi.fn((s: string) => Buffer.from(`sealed:${s}`)),
  open: vi.fn((b: Buffer) => Buffer.from(b).toString("utf8").replace(/^sealed:/, "")),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET as listServers, POST as createServer } from "@/app/api/servers/route";
import {
  DELETE as deleteServer,
  GET as getServer,
  PATCH as patchServer,
} from "@/app/api/servers/[id]/route";
import { GET as revealCredential } from "@/app/api/servers/[id]/panel-credential/route";
import { POST as generateKeypair } from "@/app/api/servers/[id]/keypair/route";

const mockAuth = vi.mocked(auth);
const db = vi.mocked(prisma, true);

function session(role: "admin" | "operator" | "viewer") {
  return {
    user: { id: "u1", email: `${role}@example.com`, role },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  };
}

function asRole(role: "admin" | "operator" | "viewer" | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockAuth.mockResolvedValue((role ? session(role) : null) as any);
}

function serverRow(over: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    name: "web-1",
    host: "203.0.113.10",
    sshPort: 22,
    sshUser: "root",
    authMethod: "password",
    sshPasswordEnc: Buffer.from("sealed:pw"),
    sshPrivateKeyEnc: null,
    linkedPanelUrl: null,
    panelUserEnc: Buffer.from("sealed:panel-admin"),
    panelPassEnc: Buffer.from("sealed:panel-secret"),
    bootstrapped: false,
    reachable: true,
    hostKeyFingerprint: null,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { websites: 0, dbInstances: 0 },
    ...over,
  };
}

function jsonReq(method: string, body?: unknown) {
  return new Request("http://test/api/servers", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "srv-1" }) };

const createPayload = {
  name: "web-1",
  host: "203.0.113.10",
  sshUser: "root",
  authMethod: "password",
  sshPassword: "hunter2",
};

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.auditLog.create.mockResolvedValue({} as any);
});

describe("GET /api/servers", () => {
  it("allows viewers and returns serialized rows", async () => {
    asRole("viewer");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.findMany.mockResolvedValue([serverRow()] as any);
    const res = await listServers();
    expect(res.status).toBe(200);
    const [row] = await res.json();
    expect(row.id).toBe("srv-1");
    expect(row.hasPanelCredential).toBe(true);
    expect(JSON.stringify(row)).not.toContain("sealed:");
  });

  it("rejects unauthenticated requests with 403", async () => {
    asRole(null);
    expect((await listServers()).status).toBe(403);
  });
});

describe("POST /api/servers (servers.write = admin only)", () => {
  it("returns 403 for viewer", async () => {
    asRole("viewer");
    const res = await createServer(jsonReq("POST", createPayload));
    expect(res.status).toBe(403);
    expect(db.server.create).not.toHaveBeenCalled();
  });

  it("returns 403 for operator", async () => {
    asRole("operator");
    const res = await createServer(jsonReq("POST", createPayload));
    expect(res.status).toBe(403);
  });

  it("creates with sealed secrets and audits for admin", async () => {
    asRole("admin");
    db.server.create.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async ({ data }: any) => ({
        ...serverRow(),
        ...data,
        _count: { websites: 0, dbInstances: 0 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
    );
    const res = await createServer(jsonReq("POST", createPayload));
    expect(res.status).toBe(201);

    const data = db.server.create.mock.calls[0]![0].data;
    expect(Buffer.from(data.sshPasswordEnc as Buffer).toString()).toBe("sealed:hunter2");
    expect(data).not.toHaveProperty("sshPassword");

    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(body.hasPanelCredential).toBe(false);

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "server.create" }),
      }),
    );
  });

  it("400s on an invalid body", async () => {
    asRole("admin");
    const res = await createServer(jsonReq("POST", { name: "" }));
    expect(res.status).toBe(400);
  });
});

describe("GET/PATCH /api/servers/:id", () => {
  it("404s when the server is missing", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(null);
    expect((await getServer(jsonReq("GET"), ctx)).status).toBe(404);
    expect((await patchServer(jsonReq("PATCH", { name: "x" }), ctx)).status).toBe(404);
  });

  it("PATCH re-seals only provided non-empty secrets", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.findUnique.mockResolvedValue(serverRow() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.update.mockResolvedValue(serverRow({ name: "renamed" }) as any);
    const res = await patchServer(
      jsonReq("PATCH", { name: "renamed", sshPassword: "", panelPass: "new-pp" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const data = db.server.update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("sshPasswordEnc");
    expect(Buffer.from(data.panelPassEnc as Buffer).toString()).toBe("sealed:new-pp");
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "server.update" }),
      }),
    );
  });

  it("PATCH is admin-only", async () => {
    asRole("operator");
    expect((await patchServer(jsonReq("PATCH", { name: "x" }), ctx)).status).toBe(403);
  });
});

describe("DELETE /api/servers/:id (server.delete = admin only)", () => {
  it("returns 403 for operator and viewer", async () => {
    asRole("operator");
    expect((await deleteServer(jsonReq("DELETE"), ctx)).status).toBe(403);
    asRole("viewer");
    expect((await deleteServer(jsonReq("DELETE"), ctx)).status).toBe(403);
    expect(db.server.delete).not.toHaveBeenCalled();
  });

  it("409s with counts while websites/dbInstances reference the server", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ _count: { websites: 2, dbInstances: 1 } }) as any,
    );
    const res = await deleteServer(jsonReq("DELETE"), ctx);
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain('"websites":2');
    expect(error).toContain('"dbInstances":1');
    expect(db.server.delete).not.toHaveBeenCalled();
  });

  it("deletes and audits when unreferenced", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.findUnique.mockResolvedValue(serverRow() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.delete.mockResolvedValue(serverRow() as any);
    const res = await deleteServer(jsonReq("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(db.server.delete).toHaveBeenCalledWith({ where: { id: "srv-1" } });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "server.delete" }),
      }),
    );
  });
});

describe("GET /api/servers/:id/panel-credential (secrets.reveal)", () => {
  it("403s for viewer", async () => {
    asRole("viewer");
    expect((await revealCredential(jsonReq("GET"), ctx)).status).toBe(403);
  });

  it("reveals decrypted credentials for operator, no-store, audited", async () => {
    asRole("operator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.findUnique.mockResolvedValue(serverRow() as any);
    const res = await revealCredential(jsonReq("GET"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      username: "panel-admin",
      password: "panel-secret",
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "server.credential_reveal" }),
      }),
    );
  });

  it("returns nulls when no credential is stored", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ panelUserEnc: null, panelPassEnc: null }) as any,
    );
    const res = await revealCredential(jsonReq("GET"), ctx);
    expect(await res.json()).toEqual({ username: null, password: null });
  });

  it("404s when the server is missing", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(null);
    expect((await revealCredential(jsonReq("GET"), ctx)).status).toBe(404);
  });
});

describe("POST /api/servers/:id/keypair (servers.write)", () => {
  it("403s for operator", async () => {
    asRole("operator");
    expect((await generateKeypair(jsonReq("POST", {}), ctx)).status).toBe(403);
  });

  it("409s when a key exists and confirm is not true", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ sshPrivateKeyEnc: Buffer.from("sealed:old-key") }) as any,
    );
    const res = await generateKeypair(jsonReq("POST", {}), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("confirm:true");
    expect(db.server.update).not.toHaveBeenCalled();
  });

  it("generates, seals the private key, clears password auth, returns the public key once", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.findUnique.mockResolvedValue(serverRow() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.update.mockResolvedValue(serverRow() as any);
    const res = await generateKeypair(jsonReq("POST", {}), ctx);
    expect(res.status).toBe(200);
    const { publicKey } = await res.json();
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ wharf-panel$/);

    const data = db.server.update.mock.calls[0]![0].data;
    expect(data.authMethod).toBe("private_key");
    expect(data.sshPasswordEnc).toBeNull();
    expect(Buffer.from(data.sshPrivateKeyEnc as Buffer).toString()).toMatch(
      /^sealed:-----BEGIN PRIVATE KEY-----/,
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "server.keypair_generate" }),
      }),
    );
  });

  it("replaces an existing key when confirm:true", async () => {
    asRole("admin");
    db.server.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ sshPrivateKeyEnc: Buffer.from("sealed:old-key") }) as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.server.update.mockResolvedValue(serverRow() as any);
    const res = await generateKeypair(jsonReq("POST", { confirm: true }), ctx);
    expect(res.status).toBe(200);
  });
});
