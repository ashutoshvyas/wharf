import { beforeEach, describe, expect, it, vi } from "vitest";

/** SSH surface — teardown reaches the server only through lib/ssh. */
const execMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: vi.fn(),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const instanceUpdate = vi.fn();
const instanceFindUnique = vi.fn();
const websiteUpdateMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      update: (...a: unknown[]) => instanceUpdate(...a),
      findUnique: (...a: unknown[]) => instanceFindUnique(...a),
    },
    website: { updateMany: (...a: unknown[]) => websiteUpdateMany(...a) },
  },
}));

const auditMock = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

import { assertSafeRemotePath, startRemove } from "./teardown";
import { removeJobId } from "./job-ids";
import { subscribe } from "@/lib/jobs/stream";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const CTX = { userId: "u1", userEmail: "admin@wharf.example.com" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

const ROW = {
  id: "inst-1",
  name: "clienta-prod",
  slug: "clienta",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  status: "running",
};

const ROW_ERRORED = { ...ROW, status: "error" };

/** Watch a job to completion, collecting its lines. */
function watchJob(jobId: string) {
  return new Promise<{ status: string; lines: string[] }>((resolve) => {
    const lines: string[] = [];
    setTimeout(() => {
      subscribe(
        jobId,
        (ev) => lines.push(`${ev.kind}|${ev.line}`),
        (end) => resolve({ status: end.status, lines }),
      );
    }, 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  instanceFindUnique.mockResolvedValue({ ...ROW });
  instanceUpdate.mockResolvedValue({ ...ROW });
  websiteUpdateMany.mockResolvedValue({ count: 1 });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  // Default: compose down succeeds, no volumes remain, rm succeeds.
  execMock.mockImplementation((_c: unknown, cmd: string) => {
    if (cmd.includes("volume ls")) return Promise.resolve(ok(""));
    return Promise.resolve(ok());
  });
});

describe("assertSafeRemotePath — the rm -rf guard (safety)", () => {
  it("accepts exactly the instance's own directory", () => {
    expect(assertSafeRemotePath("/opt/db-instances/sb_4f2a", "sb_4f2a")).toBe(
      "/opt/db-instances/sb_4f2a",
    );
  });

  it.each([
    ["/", "root"],
    ["/opt", "parent of the instances dir"],
    ["/opt/db-instances", "the instances dir itself"],
    ["/opt/db-instances/sb_OTHER", "another instance"],
    ["/opt/db-instances/sb_4f2a/..", "traversal out"],
    ["/opt/db-instances/sb_4f2a/../../etc", "traversal to /etc"],
    ["/opt/db-instances/sb_4f2a ", "trailing space"],
    ["/opt/db-instances/sb_4f2a/", "trailing slash"],
    ["/var/lib/other", "unrelated absolute path"],
    ["", "empty"],
    ["/opt/db-instances/sb_4f2a; rm -rf /", "command injection"],
    ["/opt/db-instances/$(whoami)", "substitution"],
  ])("refuses %s (%s)", (path) => {
    expect(() => assertSafeRemotePath(path, "sb_4f2a")).toThrow(/REFUSING TO DELETE/);
  });

  it("refuses a path whose project segment does not match the row", () => {
    // A tampered DB row must not be able to point the delete elsewhere.
    expect(() => assertSafeRemotePath("/opt/db-instances/sb_beef", "sb_4f2a")).toThrow(
      /REFUSING TO DELETE/,
    );
  });
});

describe("startRemove (teardown job)", () => {
  it("runs down -v, verifies volumes, removes the dir, then soft-deletes", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("volume ls")) return Promise.resolve(ok(""));
      return Promise.resolve(ok());
    });

    const res = await startRemove("inst-1", CTX);
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(removeJobId("inst-1"));
    expect(status).toBe("ok");

    const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
    const lastIdx = (needle: string) =>
      calls.map((c) => c.includes(needle)).lastIndexOf(true);
    // Volumes are listed once BEFORE down -v (to report what got removed) and
    // again after, to prove they are gone.
    expect(idx("volume ls")).toBeLessThan(idx("down -v"));
    expect(idx("down -v")).toBeLessThan(lastIdx("volume ls"));
    expect(lastIdx("volume ls")).toBeLessThan(idx("rm -rf"));
    expect(calls.find((c) => c.startsWith("rm -rf"))).toBe(
      "rm -rf /opt/db-instances/sb_4f2a",
    );

    // Phase markers per the provisioning contract §5.
    for (const phase of ["stop", "volumes", "files", "metadata"]) {
      expect(lines.some((l) => l.includes(`› ${phase}`))).toBe(true);
      expect(lines.some((l) => l.includes(`✓ ${phase}`))).toBe(true);
    }

    // Soft delete + website unlink + audit.
    const softDelete = instanceUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { deletedAt?: unknown } })?.data?.deletedAt != null,
    );
    expect(softDelete).toBeTruthy();
    expect(websiteUpdateMany).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "instance.remove" }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();

    // Bugfix regression: `slug` carries a hard DB-level unique constraint
    // independent of deletedAt, so leaving it unchanged would keep "clienta"
    // permanently unavailable (nothing else ever clears it). The soft-delete
    // must retire it to a new value so the human-facing name is immediately
    // reusable by a fresh provision.
    const data = softDelete![0] as { data: { slug?: string } };
    expect(data.data.slug).toBeTruthy();
    expect(data.data.slug).not.toBe("clienta");
    expect(data.data.slug).toMatch(/^clienta__removed-\d+$/);
  });

  it("preserves the original slug in the audit trail after retiring it", async () => {
    await startRemove("inst-1", CTX);
    await watchJob(removeJobId("inst-1"));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "instance.remove",
        metadata: expect.objectContaining({ slug: "clienta" }),
      }),
    );
  });

  it("never issues rm when the stored path is tampered", async () => {
    instanceFindUnique.mockResolvedValue({
      ...ROW,
      remotePath: "/etc", // tampered row
    });
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("volume ls")) return Promise.resolve(ok(""));
      return Promise.resolve(ok());
    });

    await startRemove("inst-1", CTX);
    const { status, lines } = await watchJob(removeJobId("inst-1"));

    expect(status).toBe("error");
    expect(calls.some((c) => c.startsWith("rm -rf"))).toBe(false);
    expect(lines.some((l) => l.includes("REFUSING TO DELETE"))).toBe(true);
    // The row must not be soft-deleted when teardown failed.
    const softDelete = instanceUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { deletedAt?: unknown } })?.data?.deletedAt != null,
    );
    expect(softDelete).toBeUndefined();
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("fails the job when volumes survive down -v", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("volume ls")) return Promise.resolve(ok("sb_4f2a_db-data\n"));
      return Promise.resolve(ok());
    });
    await startRemove("inst-1", CTX);
    const { status } = await watchJob(removeJobId("inst-1"));
    expect(status).toBe("error");
  });

  it("returns the lock holder instead of tearing down concurrently", async () => {
    const release = tryAcquireServerLock("srv-1", "provision")!;
    const res = await startRemove("inst-1", CTX);
    expect(res).toEqual({ busy: "provision" });
    release();
  });

  it("records forced:false in the audit trail for a normal removal", async () => {
    await startRemove("inst-1", CTX);
    await watchJob(removeJobId("inst-1"));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "instance.remove",
        metadata: expect.objectContaining({ forced: false }),
      }),
    );
  });
});

describe("startRemove — force (unreachable-server escape hatch)", () => {
  it("refuses force on anything but an errored instance", async () => {
    const res = await startRemove("inst-1", CTX, { force: true });
    expect(res).toEqual({
      invalid: expect.stringContaining("only available for instances in 'error' status"),
    });
    // Must not have started a job or touched the row at all.
    expect(instanceUpdate).not.toHaveBeenCalled();
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("skips SSH entirely and soft-deletes when forced on an errored instance", async () => {
    instanceFindUnique.mockResolvedValue({ ...ROW_ERRORED });

    const res = await startRemove("inst-1", CTX, { force: true });
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(removeJobId("inst-1"));
    expect(status).toBe("ok");

    // No SSH connection was ever attempted.
    expect(withConnectionMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("force remove"))).toBe(true);

    // Only the metadata phase ran — stop/volumes/files never did.
    expect(lines.some((l) => l.includes("› metadata"))).toBe(true);
    expect(lines.some((l) => l.includes("✓ metadata"))).toBe(true);
    for (const phase of ["stop", "volumes", "files"]) {
      expect(lines.some((l) => l.includes(`› ${phase}`))).toBe(false);
    }

    const softDelete = instanceUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { deletedAt?: unknown } })?.data?.deletedAt != null,
    );
    expect(softDelete).toBeTruthy();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "instance.remove",
        metadata: expect.objectContaining({ forced: true }),
      }),
    );
  });

  it("still holds and releases the per-server lock during a forced removal", async () => {
    instanceFindUnique.mockResolvedValue({ ...ROW_ERRORED });
    await startRemove("inst-1", CTX, { force: true });
    await watchJob(removeJobId("inst-1"));
    expect(serverLockHolder("srv-1")).toBeNull();
  });
});
