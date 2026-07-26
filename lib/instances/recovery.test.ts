/**
 * crash recovery + orphan detection.
 *
 * The sweep is the dangerous half: it rewrites instance status behind the
 * user's back, so these tests pin exactly which rows it may touch (stale AND
 * jobless) and prove a live job is never swept out from under itself.
 * Prisma, the job registry, audit and SSH are all mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/jobs/stream", () => ({ isJobActive: vi.fn(() => false) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ssh", () => ({ withConnection: vi.fn(), exec: vi.fn() }));
// Owned by the parallel provisioning-engine agent; only the job-id helpers
// matter here and their format is pinned by contract §4.
vi.mock("@/lib/provision/pipeline", () => ({
  provisionJobId: (id: string) => `provision:${id}`,
  removeJobId: (id: string) => `remove:${id}`,
}));

import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { isJobActive } from "@/lib/jobs/stream";
import { exec, withConnection } from "@/lib/ssh";
import {
  INTERRUPTED_NOTE,
  STALE_AFTER_MS,
  sweepStaleJobs,
} from "./recovery";
import { findOrphans } from "./orphans";

const db = vi.mocked(prisma, true);
const mockActive = vi.mocked(isJobActive);
const mockAudit = vi.mocked(audit);
const mockWithConnection = vi.mocked(withConnection);
const mockExec = vi.mocked(exec);

function staleRow(over: Record<string, unknown> = {}) {
  return {
    id: "inst-1",
    status: "provisioning",
    lastActionLog: "› prepare",
    ...over,
  };
}

/** Route every withConnection callback at a canned exec result. */
function sshReturns(result: { code: number | null; stdout: string }) {
  mockExec.mockResolvedValue({ ...result, stderr: "" });
  mockWithConnection.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_serverId: string, fn: (conn: any) => Promise<unknown>) => fn({} as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActive.mockReturnValue(false);
  db.dbInstance.update.mockResolvedValue({} as never);
});

describe("sweepStaleJobs", () => {
  it("queries only in-flight statuses older than the 10-minute cutoff", async () => {
    db.dbInstance.findMany.mockResolvedValue([]);
    const before = Date.now();
    await sweepStaleJobs();

    expect(STALE_AFTER_MS).toBe(10 * 60 * 1000);
    const arg = db.dbInstance.findMany.mock.calls[0]![0] as {
      where: { status: { in: string[] }; updatedAt: { lt: Date } };
    };
    expect(arg.where.status.in.sort()).toEqual(["provisioning", "removing"]);
    const cutoff = arg.where.updatedAt.lt.getTime();
    expect(cutoff).toBeLessThanOrEqual(before - STALE_AFTER_MS + 5);
    expect(cutoff).toBeGreaterThan(before - STALE_AFTER_MS - 5_000);
  });

  it("returns 0 and writes nothing when there are no stale rows", async () => {
    db.dbInstance.findMany.mockResolvedValue([]);
    expect(await sweepStaleJobs()).toBe(0);
    expect(db.dbInstance.update).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("marks a stale jobless row as error and appends the interrupted note", async () => {
    db.dbInstance.findMany.mockResolvedValue([staleRow()] as never);

    expect(await sweepStaleJobs()).toBe(1);
    expect(db.dbInstance.update).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: {
        status: "error",
        lastActionLog: "› prepare" + INTERRUPTED_NOTE,
      },
    });
    expect(INTERRUPTED_NOTE).toBe(
      "\n✗ interrupted — panel restarted before this job finished",
    );
  });

  it("appends the note to an empty log when lastActionLog is null", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      staleRow({ lastActionLog: null }),
    ] as never);

    await sweepStaleJobs();
    const data = db.dbInstance.update.mock.calls[0]![0].data as {
      lastActionLog: string;
    };
    expect(data.lastActionLog).toBe(INTERRUPTED_NOTE);
  });

  it("skips a row whose provision job is still live", async () => {
    db.dbInstance.findMany.mockResolvedValue([staleRow()] as never);
    mockActive.mockImplementation((jobId: string) => jobId === "provision:inst-1");

    expect(await sweepStaleJobs()).toBe(0);
    expect(db.dbInstance.update).not.toHaveBeenCalled();
  });

  it("skips a row whose remove job is still live", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      staleRow({ status: "removing" }),
    ] as never);
    mockActive.mockImplementation((jobId: string) => jobId === "remove:inst-1");

    expect(await sweepStaleJobs()).toBe(0);
    expect(db.dbInstance.update).not.toHaveBeenCalled();
  });

  it("sweeps only the jobless rows out of a mixed batch", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      staleRow({ id: "live" }),
      staleRow({ id: "dead-1" }),
      staleRow({ id: "dead-2", status: "removing" }),
    ] as never);
    mockActive.mockImplementation((jobId: string) => jobId === "provision:live");

    expect(await sweepStaleJobs()).toBe(2);
    const sweptIds = db.dbInstance.update.mock.calls.map(
      (c) => (c[0].where as { id: string }).id,
    );
    expect(sweptIds).toEqual(["dead-1", "dead-2"]);
  });

  it("audits instance.job.interrupted with the previous status", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      staleRow({ status: "removing" }),
    ] as never);

    await sweepStaleJobs();
    expect(mockAudit).toHaveBeenCalledWith({
      action: "instance.job.interrupted",
      targetType: "db_instance",
      targetId: "inst-1",
      metadata: { previousStatus: "removing" },
    });
  });

  it("keeps going (and does not throw) when one row fails to update", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      staleRow({ id: "bad" }),
      staleRow({ id: "good" }),
    ] as never);
    db.dbInstance.update
      .mockRejectedValueOnce(new Error("row vanished"))
      .mockResolvedValueOnce({} as never);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await sweepStaleJobs()).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("findOrphans", () => {
  it("reports sb_ projects with no matching row", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      { composeProjectName: "sb_known" },
    ] as never);
    sshReturns({
      code: 0,
      stdout: JSON.stringify([
        { Name: "sb_known", ConfigFiles: "/opt/db-instances/sb_known/docker-compose.yml" },
        { Name: "sb_lost", ConfigFiles: "/opt/db-instances/sb_lost/docker-compose.yml" },
      ]),
    });

    expect(await findOrphans("srv-1")).toEqual([
      { project: "sb_lost", path: "/opt/db-instances/sb_lost/docker-compose.yml" },
    ]);
  });

  it("ignores projects the operator owns (no sb_ prefix)", async () => {
    db.dbInstance.findMany.mockResolvedValue([] as never);
    sshReturns({
      code: 0,
      stdout: JSON.stringify([{ Name: "traefik" }, { Name: "wordpress" }]),
    });

    expect(await findOrphans("srv-1")).toEqual([]);
  });

  it("counts soft-deleted rows as known so a pending purge is not an orphan", async () => {
    db.dbInstance.findMany.mockResolvedValue([
      { composeProjectName: "sb_purging" },
    ] as never);
    sshReturns({ code: 0, stdout: JSON.stringify([{ Name: "sb_purging" }]) });

    expect(await findOrphans("srv-1")).toEqual([]);
    // The lookup must NOT filter on deletedAt.
    expect(db.dbInstance.findMany).toHaveBeenCalledWith({
      where: { serverId: "srv-1" },
      select: { composeProjectName: true },
    });
  });

  it("parses the {Projects:[…]} envelope and newline-delimited JSON", async () => {
    db.dbInstance.findMany.mockResolvedValue([] as never);

    sshReturns({
      code: 0,
      stdout: JSON.stringify({ Projects: [{ name: "sb_a" }] }),
    });
    expect(await findOrphans("srv-1")).toEqual([{ project: "sb_a" }]);

    sshReturns({ code: 0, stdout: '{"Name":"sb_b"}\n{"Name":"sb_c"}\n' });
    expect(await findOrphans("srv-1")).toEqual([
      { project: "sb_b" },
      { project: "sb_c" },
    ]);
  });

  it("returns [] for empty, garbage or non-zero docker output", async () => {
    db.dbInstance.findMany.mockResolvedValue([] as never);

    sshReturns({ code: 0, stdout: "   " });
    expect(await findOrphans("srv-1")).toEqual([]);

    sshReturns({ code: 0, stdout: "not json at all" });
    expect(await findOrphans("srv-1")).toEqual([]);

    sshReturns({ code: 127, stdout: JSON.stringify([{ Name: "sb_lost" }]) });
    expect(await findOrphans("srv-1")).toEqual([]);
  });

  it("skips entries without a usable name and takes the first config file", async () => {
    db.dbInstance.findMany.mockResolvedValue([] as never);
    sshReturns({
      code: 0,
      stdout: JSON.stringify([
        { Status: "running(3)" },
        { Name: "" },
        null,
        { Name: "sb_multi", ConfigFiles: "/a/compose.yml,/b/override.yml" },
      ]),
    });

    expect(await findOrphans("srv-1")).toEqual([
      { project: "sb_multi", path: "/a/compose.yml" },
    ]);
  });

  it("never issues a write or delete command over SSH", async () => {
    db.dbInstance.findMany.mockResolvedValue([] as never);
    sshReturns({ code: 0, stdout: "[]" });

    await findOrphans("srv-1");
    const cmd = mockExec.mock.calls[0]![1];
    expect(cmd).toBe("docker compose ls --format json");
    expect(cmd).not.toMatch(/\b(rm|down|stop|kill|prune|restart)\b/);
  });
});
