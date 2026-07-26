import { beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";

/** SSH surface — restore reaches the server only through lib/ssh. */
const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: (...a: unknown[]) => sftpWriteMock(...a),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const instanceUpdate = vi.fn();
const instanceFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      update: (...a: unknown[]) => instanceUpdate(...a),
      findFirst: (...a: unknown[]) => instanceFindFirst(...a),
    },
  },
}));

const auditMock = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted-pg-password" }));

import { extractDumpBuffer, startRestore } from "./restore";
import { restoreJobId } from "./job-ids";
import { subscribe } from "@/lib/jobs/stream";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const CTX = { userId: "u1", userEmail: "admin@wharf.example.com" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const ROW = {
  id: "inst-1",
  name: "clienta-prod",
  slug: "clienta",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  status: "running",
  pgPasswordEnc: Buffer.from("sealed"),
};

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

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
  instanceFindFirst.mockResolvedValue({ ...ROW });
  instanceUpdate.mockResolvedValue({ ...ROW });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  execMock.mockResolvedValue(ok());
  sftpWriteMock.mockResolvedValue(undefined);
});

describe("extractDumpBuffer", () => {
  it("passes through a bare .backup file unchanged", () => {
    const buf = Buffer.from("raw dump bytes");
    const result = extractDumpBuffer(buf, "mydump.backup");
    expect(result.extension).toBe(".backup");
    expect(result.buffer).toBe(buf);
  });

  it("accepts .dump and .sql the same way", () => {
    expect(extractDumpBuffer(Buffer.from("x"), "x.dump").extension).toBe(".dump");
    expect(extractDumpBuffer(Buffer.from("x"), "x.sql").extension).toBe(".sql");
  });

  it("extracts the single entry from a .zip", () => {
    const zip = zipOf({ "backup/dump.backup": "the dump bytes" });
    const result = extractDumpBuffer(zip, "export.zip");
    expect(result.extension).toBe(".backup");
    expect(result.buffer.toString()).toBe("the dump bytes");
  });

  it("rejects a .zip with zero dump-like entries", () => {
    const zip = zipOf({});
    expect(() => extractDumpBuffer(zip, "export.zip")).toThrow(/exactly one backup file/);
  });

  it("rejects a .zip with multiple entries", () => {
    const zip = zipOf({ "a.backup": "1", "b.backup": "2" });
    expect(() => extractDumpBuffer(zip, "export.zip")).toThrow(/exactly one backup file/);
  });

  it("rejects a .zip whose entry has a disallowed extension", () => {
    const zip = zipOf({ "readme.txt": "not a dump" });
    expect(() => extractDumpBuffer(zip, "export.zip")).toThrow(/not a \.backup\/\.dump\/\.sql/);
  });

  it("rejects a top-level file with a disallowed extension", () => {
    expect(() => extractDumpBuffer(Buffer.from("x"), "notes.txt")).toThrow(
      /must be a \.zip, \.backup, \.dump, or \.sql file/,
    );
  });
});

describe("startRestore — validation", () => {
  it("refuses an unknown instance", async () => {
    instanceFindFirst.mockResolvedValue(null);
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("x"),
      filename: "x.backup",
    });
    expect(res).toEqual({ invalid: expect.stringContaining("was not found") });
  });

  it("refuses a confirmName mismatch", async () => {
    const res = await startRestore("inst-1", CTX, "wrong-name", {
      buffer: Buffer.from("x"),
      filename: "x.backup",
    });
    expect(res).toEqual({ invalid: expect.stringContaining("Confirmation does not match") });
  });

  it("refuses anything but a running instance", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, status: "stopped" });
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("x"),
      filename: "x.backup",
    });
    expect(res).toEqual({
      invalid: expect.stringContaining("only available for a running instance"),
    });
  });

  it("refuses an oversized upload", async () => {
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.alloc(3 * 1024 * 1024 * 1024),
      filename: "x.backup",
    });
    expect(res).toEqual({ invalid: expect.stringContaining("too large") });
  });

  it("refuses an instance with no stored Postgres password", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, pgPasswordEnc: null });
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("x"),
      filename: "x.backup",
    });
    expect(res).toEqual({ invalid: expect.stringContaining("no stored Postgres password") });
  });

  it("refuses a bad backup file before ever touching the server", async () => {
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("x"),
      filename: "notes.txt",
    });
    expect(res).toEqual({ invalid: expect.stringContaining("must be a .zip") });
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("returns the lock holder instead of restoring concurrently", async () => {
    const release = tryAcquireServerLock("srv-1", "provision")!;
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("x"),
      filename: "x.backup",
    });
    expect(res).toEqual({ busy: "provision" });
    release();
  });
});

describe("startRestore — happy path", () => {
  it("uploads, snapshots, restores, cleans up, then marks the instance running", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });

    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("dump bytes"),
      filename: "mydump.backup",
    });
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(restoreJobId("inst-1"));
    expect(status).toBe("ok");

    // Phase markers.
    for (const phase of ["upload", "snapshot", "restore", "cleanup"]) {
      expect(lines.some((l) => l.includes(`› ${phase}`))).toBe(true);
      expect(lines.some((l) => l.includes(`✓ ${phase}`))).toBe(true);
    }

    // sftpWrite carried the uploaded bytes, not the client filename.
    expect(sftpWriteMock).toHaveBeenCalledTimes(1);
    const [, uploadPath, uploadedBuffer] = sftpWriteMock.mock.calls[0]!;
    expect(uploadPath).toMatch(/^\/opt\/db-instances\/sb_4f2a\/restore\/upload-\d+\.backup$/);
    expect((uploadedBuffer as Buffer).toString()).toBe("dump bytes");

    // Command order: mkdir -> pg_dump snapshot -> cp snapshot out -> cp restore in -> pg_restore -> cleanup.
    const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(idx("mkdir -p")).toBeLessThan(idx("pg_dump"));
    expect(idx("pg_dump")).toBeLessThan(idx("cp db:/tmp/wharf-snapshot"));
    expect(idx("cp db:/tmp/wharf-snapshot")).toBeLessThan(
      calls.findIndex((c) => c.includes("cp ") && c.includes("db:/tmp/wharf-restore")),
    );
    expect(calls.findIndex((c) => c.includes("db:/tmp/wharf-restore"))).toBeLessThan(
      idx("pg_restore"),
    );

    // PGPASSWORD is injected via docker compose's own -e flag, never the host shell.
    expect(calls.some((c) => c.includes("exec -T -e PGPASSWORD="))).toBe(true);
    // pg_restore carries the cross-environment-safe flags.
    expect(calls.find((c) => c.includes("pg_restore"))).toContain(
      "--clean --if-exists --no-owner --no-acl",
    );

    // Snapshot kept, upload cleaned up.
    expect(calls.some((c) => c.includes("rm -f") && c.includes("wharf-restore"))).toBe(true);
    expect(calls.some((c) => c.includes("rm -f") && c.includes("restore/upload-"))).toBe(true);
    expect(calls.some((c) => c.includes("rm") && c.includes("backups/pre-restore"))).toBe(false);

    expect(instanceUpdate).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: { status: "restoring" },
    });
    expect(instanceUpdate).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: { status: "running" },
    });

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "instance.restore",
        metadata: expect.objectContaining({
          project: "sb_4f2a",
          sourceFilename: "mydump.backup",
          snapshotPath: expect.stringMatching(
            /^\/opt\/db-instances\/sb_4f2a\/backups\/pre-restore-\d+\.backup$/,
          ),
        }),
      }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("uses psql (not pg_restore) for a .sql upload", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });
    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("select 1;"),
      filename: "plain.sql",
    });
    await watchJob(restoreJobId("inst-1"));
    expect(calls.some((c) => c.includes("psql -U postgres -d postgres -f"))).toBe(true);
    expect(calls.some((c) => c.includes("pg_restore"))).toBe(false);
  });

  it("treats a non-zero pg_restore exit as a warning, not a failure", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_restore")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "WARNING: errors ignored on restore" });
      }
      return Promise.resolve(ok());
    });
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("dump bytes"),
      filename: "mydump.backup",
    });
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(restoreJobId("inst-1"));
    expect(status).toBe("ok");
    expect(lines.some((l) => l.includes("commonly just cross-environment"))).toBe(true);
  });

  it("fails the job when pg_dump (the safety snapshot) fails, before ever touching the restore", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("pg_dump")) return Promise.resolve(fail("connection refused"));
      return Promise.resolve(ok());
    });
    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("dump bytes"),
      filename: "mydump.backup",
    });
    const { status } = await watchJob(restoreJobId("inst-1"));
    expect(status).toBe("error");
    expect(calls.some((c) => c.includes("db:/tmp/wharf-restore"))).toBe(false);

    const errored = instanceUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { status?: string } })?.data?.status === "error",
    );
    expect(errored).toBeTruthy();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "instance.restore.failed" }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("refuses to write outside the instance's own directory on a tampered row", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, remotePath: "/etc" });
    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("dump bytes"),
      filename: "mydump.backup",
    });
    const { status, lines } = await watchJob(restoreJobId("inst-1"));
    expect(status).toBe("error");
    expect(lines.some((l) => l.includes("REFUSING TO RESTORE INTO"))).toBe(true);
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });
});
