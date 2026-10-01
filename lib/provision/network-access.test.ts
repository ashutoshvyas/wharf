import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), serverFind: vi.fn(), serverUpdate: vi.fn(),
  transaction: vi.fn(), connect: vi.fn(), register: vi.fn(), snapshot: vi.fn(), firewall: vi.fn(), decrypt: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: {
  dbInstance: { findFirst: mocks.findFirst, findMany: mocks.findMany, update: mocks.update },
  server: { findUnique: mocks.serverFind, update: mocks.serverUpdate }, $transaction: mocks.transaction,
} }));
vi.mock("@/lib/ssh", () => ({ withConnection: mocks.connect }));
vi.mock("@/lib/crypto", () => ({ open: mocks.decrypt }));
vi.mock("@/lib/bootstrap/network-firewall", () => ({ installNetworkFirewall: mocks.firewall }));
vi.mock("./pooler", async (original) => ({ ...await original<object>(), registerPoolerTenant: mocks.register, readPoolerNetworkState: mocks.snapshot }));

import { getInstanceNetworkAccess, updateInstanceNetworkAccess, enableServerNetworkAccess } from "./network-access";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const CONNECTION = {};
const BASELINE = { mode: "restricted" as const, allowedCidrs: ["198.51.100.10/32"] };
const ROW = {
  id: "inst-1", name: "Production", serverId: "srv-1", composeProjectName: "sb_4f2a", sslMode: "require",
  networkAccess: null, networkAccessAppliedAt: null, networkAccessError: null, status: "running", pgPasswordEnc: Buffer.from("sealed"),
  server: { id: "srv-1", name: "Database host", poolerFirewallManaged: false },
};
const SIBLING = { ...ROW, id: "inst-2", name: "Staging", composeProjectName: "sb_5f2a", networkAccess: { mode: "blocked" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findFirst.mockResolvedValue({ ...ROW });
  mocks.findMany.mockResolvedValue([{ ...ROW }, { ...SIBLING }]);
  mocks.serverFind.mockResolvedValue(ROW.server);
  mocks.serverUpdate.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
  mocks.transaction.mockImplementation((operations) => Promise.all(operations));
  mocks.connect.mockImplementation(async (_id, callback) => callback(CONNECTION));
  mocks.decrypt.mockReturnValue("test-password");
  mocks.register.mockResolvedValue(undefined);
  mocks.firewall.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue([{ external_id: ROW.composeProjectName, allow_list: BASELINE.allowedCidrs }]);
});

describe("per-database network access", () => {
  it("exposes the allow-all default and pending legacy peers, without credentials", async () => {
    const result = await getInstanceNetworkAccess(ROW.id);
    expect(result).toEqual({ policy: { mode: "all" }, appliedAt: null, applyError: null,
      server: { id: "srv-1", name: "Database host", firewallManaged: false, unconfiguredInstances: [{ id: ROW.id, name: ROW.name }] } });
    expect(JSON.stringify(result)).not.toContain("sealed");
  });
  it("persists intent before remote changes, verifies it, and updates only this database", async () => {
    expect(await updateInstanceNetworkAccess(ROW.id, BASELINE)).toEqual({ ok: true, applied: true });
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({ where: { id: ROW.id }, data: { networkAccess: BASELINE, networkAccessAppliedAt: null } });
    expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.register.mock.invocationCallOrder[0]!);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(CONNECTION, {
      serverId: "srv-1", project: "sb_4f2a", sslMode: "require", pgPassword: "test-password", networkAccess: BASELINE,
    });
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({ data: { networkAccessAppliedAt: expect.any(Date), networkAccessError: null } });
    expect(mocks.firewall).not.toHaveBeenCalled();
    expect(serverLockHolder("srv-1")).toBeNull();
  });
  it("reports failed remote application honestly, retains desired policy and releases the lock", async () => {
    mocks.register.mockRejectedValue(new Error("command containing secret-password"));
    const result = await updateInstanceNetworkAccess(ROW.id, BASELINE);
    expect(result).toMatchObject({ ok: true, applied: false, applyError: expect.stringContaining("previous policy") });
    expect(JSON.stringify(result)).not.toContain("secret-password");
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({ data: { networkAccessError: expect.any(String) } });
    expect(serverLockHolder("srv-1")).toBeNull();
  });
  it("does not claim success if the pooler ignores the allowlist", async () => {
    mocks.snapshot.mockResolvedValue([{ external_id: ROW.composeProjectName, allow_list: ["0.0.0.0/0", "::/0"] }]);
    expect(await updateInstanceNetworkAccess(ROW.id, BASELINE)).toMatchObject({ applied: false });
  });
  it("blocks without requiring or decrypting a database password", async () => {
    mocks.findFirst.mockResolvedValue({ ...ROW, pgPasswordEnc: null });
    mocks.snapshot.mockResolvedValue([]);
    expect(await updateInstanceNetworkAccess(ROW.id, { mode: "blocked" })).toMatchObject({ applied: true });
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("rejects concurrent jobs and rechecks instance existence under the lock", async () => {
    const release = tryAcquireServerLock("srv-1", "restore")!;
    try { expect(await updateInstanceNetworkAccess(ROW.id, BASELINE)).toEqual({ busy: "restore" }); }
    finally { release(); }
    expect(mocks.connect).not.toHaveBeenCalled();
    mocks.findFirst.mockResolvedValueOnce(ROW).mockResolvedValueOnce(null);
    expect(await updateInstanceNetworkAccess(ROW.id, BASELINE)).toEqual({ notFound: true });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("shared-host adoption", () => {
  it("applies a reviewed baseline only to legacy databases, verifies all tenants, then opens the host path", async () => {
    expect(await enableServerNetworkAccess("srv-1", "Database host", BASELINE.allowedCidrs)).toEqual({ ok: true, applied: true });
    expect(mocks.register.mock.calls.map((call) => call[1].networkAccess)).toEqual([BASELINE, { mode: "blocked" }]);
    expect(mocks.register.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.firewall.mock.invocationCallOrder[0]!);
    expect(mocks.firewall.mock.invocationCallOrder[0]!).toBeLessThan(mocks.serverUpdate.mock.invocationCallOrder[0]!);
    expect(mocks.serverUpdate).toHaveBeenCalledWith({ where: { id: "srv-1" }, data: { poolerFirewallManaged: true } });
  });
  it("rejects the wrong server confirmation without contacting it", async () => {
    expect(await enableServerNetworkAccess("srv-1", "wrong", BASELINE.allowedCidrs)).toHaveProperty("invalid");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("never opens the host path with an unknown or orphaned tenant", async () => {
    mocks.snapshot.mockResolvedValue([{ external_id: "not-managed", allow_list: ["0.0.0.0/0"] }]);
    expect(await enableServerNetworkAccess("srv-1", "Database host", BASELINE.allowedCidrs)).toMatchObject({ applied: false, applyError: expect.stringContaining("does not manage") });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.firewall).not.toHaveBeenCalled();
  });
  it("leaves host restrictions in place when a single tenant cannot be protected", async () => {
    mocks.register.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    expect(await enableServerNetworkAccess("srv-1", "Database host", BASELINE.allowedCidrs)).toMatchObject({ applied: false });
    expect(mocks.firewall).not.toHaveBeenCalled();
    expect(mocks.serverUpdate).not.toHaveBeenCalled();
  });
  it("retries host setup without replacing existing individual policies", async () => {
    mocks.findMany.mockResolvedValue([{ ...ROW, networkAccess: { mode: "blocked" } }, SIBLING]);
    mocks.snapshot.mockResolvedValue([]);
    mocks.firewall.mockRejectedValue(new Error("permission denied"));
    expect(await enableServerNetworkAccess("srv-1", "Database host", BASELINE.allowedCidrs)).toMatchObject({ applied: false, applyError: expect.stringContaining("host firewall") });
    expect(mocks.register.mock.calls.map((call) => call[1].networkAccess)).toEqual([{ mode: "blocked" }, { mode: "blocked" }]);
    expect(mocks.serverUpdate).not.toHaveBeenCalled();
    expect(serverLockHolder("srv-1")).toBeNull();
  });
  it("keeps the allow-all default when setup has no baseline", async () => {
    mocks.snapshot.mockResolvedValue([{ external_id: ROW.composeProjectName, allow_list: ["0.0.0.0/0", "::/0"] }]);
    expect(await enableServerNetworkAccess("srv-1", "Database host", [])).toEqual({ ok: true, applied: true });
    expect(mocks.register.mock.calls.map((call) => call[1].networkAccess)).toEqual([{ mode: "all" }, { mode: "blocked" }]);
  });
});
