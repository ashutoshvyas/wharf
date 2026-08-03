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
/** A real custom-format (`pg_dump -Fc`) archive always starts with this magic. */
const customFormatDump = (rest = "dump bytes") => Buffer.concat([Buffer.from("PGDMP"), Buffer.from(rest)]);

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

    const uploadBuffer = customFormatDump();
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: uploadBuffer,
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

    // sftpWrite carried the uploaded bytes, not the client filename — plus the
    // post-load schema-privilege re-assert script (no WHARF-managed roles were
    // found in this default mock, so reassertInstanceRoles itself wrote none).
    expect(sftpWriteMock).toHaveBeenCalledTimes(2);
    const [, uploadPath, uploadedBuffer] = sftpWriteMock.mock.calls[0]!;
    expect(uploadPath).toMatch(/^\/opt\/db-instances\/sb_4f2a\/restore\/upload-\d+\.backup$/);
    expect((uploadedBuffer as Buffer).equals(uploadBuffer)).toBe(true);

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

  it("treats a non-zero pg_restore exit as a warning, not a failure, when tables DID land", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_restore")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "WARNING: errors ignored on restore" });
      }
      if (cmd.includes("pg_tables") && cmd.includes("count(*)")) return Promise.resolve(ok("12"));
      return Promise.resolve(ok());
    });
    const res = await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: customFormatDump(),
      filename: "mydump.backup",
    });
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(restoreJobId("inst-1"));
    expect(status).toBe("ok");
    expect(lines.some((l) => l.includes("commonly just cross-environment"))).toBe(true);
    expect(lines.some((l) => l.includes("12 table(s) now in public"))).toBe(true);
  });

  it("detects a plain-text SQL dump uploaded with a misleading .backup extension", async () => {
    // The exact bug reported in the field: pg_dump's default format is plain
    // SQL unless -Fc/-Fd/-Ft was explicitly requested, so a ".backup"-named
    // upload is very commonly plain SQL in practice — trusting the extension
    // alone previously sent every such file to pg_restore, which refuses to
    // even open it ("input file appears to be a text format dump").
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });
    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: Buffer.from("-- PostgreSQL database dump\nselect 1;\n"),
      filename: "mydump.backup",
    });
    const { lines } = await watchJob(restoreJobId("inst-1"));
    expect(calls.some((c) => c.includes("psql -U postgres -d postgres -f"))).toBe(true);
    expect(calls.some((c) => c.includes("pg_restore"))).toBe(false);
    expect(
      lines.some(
        (l) => l.includes("has a .backup extension but is actually a") && l.includes("psql"),
      ),
    ).toBe(true);
  });

  // The exact failure seen in the field: pg_restore/psql errored on every
  // statement for lack of privileges (or a totally unparsable upload), was
  // tolerated as cross-environment noise, and left an empty `public` behind
  // while the job reported success — restore.ts previously had no version of
  // the check sync.ts already does for its own live-source restores.
  it("fails when the load errored and no tables landed, instead of reporting success", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_tables") && cmd.includes("count(*)")) return Promise.resolve(ok("0"));
      if (cmd.includes("pg_restore")) {
        return Promise.resolve(fail("ERROR: permission denied for schema public"));
      }
      return Promise.resolve(ok());
    });

    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: customFormatDump(),
      filename: "mydump.backup",
    });
    const { status, lines } = await watchJob(restoreJobId("inst-1"));

    expect(status).toBe("error");
    expect(lines.join("\n")).toContain("nothing was restored");
    // The row must not be left "running" after a restore that changed nothing.
    expect(
      instanceUpdate.mock.calls.some(
        (c) => (c[0] as { data?: { status?: string } }).data?.status === "running",
      ),
    ).toBe(false);
  });

  // The field bug this fixes: an uploaded dump's tables land owned by
  // whichever role connected to load them (supabase_admin), not this
  // instance's own `postgres` — so PostgREST/Studio hold no privileges on
  // them at all, even though the data itself restored correctly.
  it("re-asserts ownership and privileges on public after loading the dump", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });

    await startRestore("inst-1", CTX, "clienta-prod", {
      buffer: customFormatDump(),
      filename: "mydump.backup",
    });
    const { lines } = await watchJob(restoreJobId("inst-1"));

    const write = sftpWriteMock.mock.calls.find((w) =>
      String(w[1]).includes("privileges-"),
    ) as [unknown, string, string, number];
    expect(write).toBeDefined();
    expect(write[2]).toContain("schemaname = 'public'");
    expect(write[3]).toBe(0o600);

    const restoreAt = calls.findIndex((c) => c.includes("pg_restore"));
    const privAt = calls.findIndex((c) => c.includes("wharf-privileges-"));
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeLessThan(privAt);
    expect(lines.join("\n")).toContain("re-asserted ownership and privileges");
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
