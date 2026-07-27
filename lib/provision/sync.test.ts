import { beforeEach, describe, expect, it, vi } from "vitest";

/** SSH surface — sync reaches the server only through lib/ssh. */
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
const syncSourceUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      update: (...a: unknown[]) => instanceUpdate(...a),
      findFirst: (...a: unknown[]) => instanceFindFirst(...a),
    },
    instanceSyncSource: {
      update: (...a: unknown[]) => syncSourceUpdate(...a),
    },
  },
}));

const auditMock = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

/** Every sealed column decrypts to a value we can grep the transcript for. */
const SOURCE_PASSWORD = "s0urce-p4ssw0rd";
const SOURCE_SERVICE_KEY = "src-service-role-key";
const TARGET_PASSWORD = "target-pg-password";
const TARGET_SERVICE_KEY = "dst-service-role-key";
vi.mock("@/lib/crypto", () => ({
  open: (buf: Buffer) => {
    const tag = buf.toString();
    if (tag === "src-pw") return SOURCE_PASSWORD;
    if (tag === "src-key") return SOURCE_SERVICE_KEY;
    if (tag === "dst-key") return TARGET_SERVICE_KEY;
    return TARGET_PASSWORD;
  },
}));

import {
  buildConnInfo,
  describeSource,
  encodeObjectPath,
  parseObjectList,
  renderStorageScript,
  startSync,
  testSyncSource,
} from "./sync";
import { syncJobId } from "./job-ids";
import { subscribe } from "@/lib/jobs/stream";
import { tryAcquireServerLock } from "@/lib/jobs/lock";

const CTX = { userId: "u1", userEmail: "admin@wharf.example.com" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const SOURCE = {
  kind: "supabase" as const,
  pgHost: "db.abcdefghijklm.supabase.co",
  pgPort: 5432,
  pgDatabase: "postgres",
  pgUser: "postgres",
  pgPasswordEnc: Buffer.from("src-pw"),
  pgSslMode: "require",
  projectUrl: "https://abcdefghijklm.supabase.co",
  serviceRoleKeyEnc: Buffer.from("src-key"),
  includeAuthUsers: true,
  includeStorageObjects: false,
  extraSchemas: [] as string[],
};

const ROW = {
  id: "inst-1",
  name: "clienta-prod",
  slug: "clienta",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  apiSubdomain: "clienta.wharf.example.com",
  status: "running",
  pgPasswordEnc: Buffer.from("dst-pw"),
  serviceRoleKeyEnc: Buffer.from("dst-key"),
  syncSource: SOURCE,
};

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

/** The phase markers, in the order they were emitted. */
function phases(lines: string[]): string[] {
  return lines
    .map((l) => /^(?:step|ok|err)\|([›✓✗])\s*([a-z-]+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}${m[2]}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  instanceFindFirst.mockResolvedValue({ ...ROW });
  instanceUpdate.mockResolvedValue({ ...ROW });
  syncSourceUpdate.mockResolvedValue({});
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  execMock.mockResolvedValue(ok());
  sftpWriteMock.mockResolvedValue(undefined);
});

describe("buildConnInfo", () => {
  it("carries no password and percent-encodes the components", () => {
    const uri = buildConnInfo({
      host: "db.example.com",
      port: 6543,
      database: "post gres",
      user: "postgres.abc",
      sslMode: "verify-full",
    });
    expect(uri).toBe(
      "postgresql://postgres.abc@db.example.com:6543/post%20gres?sslmode=verify-full",
    );
    expect(uri).not.toContain("@db.example.com:6543/post gres");
  });

  it("leaves the userinfo section password-free", () => {
    const uri = buildConnInfo({
      host: "h",
      port: 5432,
      database: "d",
      user: "u",
      sslMode: "require",
    });
    // userinfo is everything between "://" and "@" — a password would show up
    // there as `user:password`.
    const userinfo = uri.slice("postgresql://".length, uri.indexOf("@"));
    expect(userinfo).toBe("u");
  });
});

describe("describeSource", () => {
  it("names the source without its credentials", () => {
    const text = describeSource({
      kind: "supabase",
      host: "h",
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: SOURCE_PASSWORD,
      sslMode: "require",
      projectUrl: null,
      serviceRoleKey: SOURCE_SERVICE_KEY,
      includeAuthUsers: true,
      includeStorageObjects: false,
      extraSchemas: [],
    });
    expect(text).toBe("postgres@h:5432/postgres (sslmode=require)");
    expect(text).not.toContain(SOURCE_PASSWORD);
    expect(text).not.toContain(SOURCE_SERVICE_KEY);
  });
});

describe("encodeObjectPath", () => {
  it("encodes each segment but keeps the separators", () => {
    expect(encodeObjectPath("folder name/a+b/c d.png")).toBe(
      "folder%20name/a%2Bb/c%20d.png",
    );
  });
});

describe("parseObjectList", () => {
  it("parses tab-separated rows", () => {
    const { entries, skipped } = parseObjectList(
      "avatars\tuser/1.png\timage/png\npublic\tdoc.pdf\tapplication/pdf\n",
    );
    expect(skipped).toBe(0);
    expect(entries).toEqual([
      { bucket: "avatars", path: "user/1.png", contentType: "image/png" },
      { bucket: "public", path: "doc.pdf", contentType: "application/pdf" },
    ]);
  });

  it("drops rows whose object name broke the field layout", () => {
    const { entries, skipped } = parseObjectList("avatars\tgood.png\timage/png\nbroken-row\n");
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("falls back to a generic content type", () => {
    const { entries } = parseObjectList("b\tobj\t\n");
    expect(entries[0]!.contentType).toBe("application/octet-stream");
  });
});

describe("renderStorageScript", () => {
  it("reads credentials from the sourced env file, never from argv", () => {
    const script = renderStorageScript();
    expect(script).toContain('. "$1"');
    expect(script).toContain('Authorization: Bearer $SRC_TOKEN');
    expect(script).toContain('Authorization: Bearer $DST_TOKEN');
    // A per-object failure is counted, not fatal.
    expect(script).toContain("FAIL download");
    expect(script).toContain("FAIL upload");
    expect(script).toContain("DONE ok=$ok failed=$failed");
  });
});

describe("startSync — validation", () => {
  it("refuses an unknown instance", async () => {
    instanceFindFirst.mockResolvedValue(null);
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({
      invalid: expect.stringContaining("was not found"),
    });
  });

  it("refuses a confirmName mismatch", async () => {
    expect(await startSync("inst-1", CTX, "wrong-name")).toEqual({
      invalid: expect.stringContaining("Confirmation does not match"),
    });
  });

  it("refuses anything but a running instance", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, status: "stopped" });
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({
      invalid: expect.stringContaining("only available for a running instance"),
    });
  });

  it("refuses an instance with no configured source", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, syncSource: null });
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({
      invalid: expect.stringContaining("No sync source is configured"),
    });
  });

  it("refuses storage copying without the source's project URL and key", async () => {
    instanceFindFirst.mockResolvedValue({
      ...ROW,
      syncSource: { ...SOURCE, includeStorageObjects: true, serviceRoleKeyEnc: null },
    });
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({
      invalid: expect.stringContaining("service_role key"),
    });
  });

  it("refuses storage copying when the instance itself has no service_role key", async () => {
    instanceFindFirst.mockResolvedValue({
      ...ROW,
      serviceRoleKeyEnc: null,
      syncSource: { ...SOURCE, includeStorageObjects: true },
    });
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({
      invalid: expect.stringContaining("no stored service_role key"),
    });
  });

  it("never touches the server on a validation failure", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, syncSource: null });
    await startSync("inst-1", CTX, "clienta-prod");
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("returns the lock holder instead of syncing concurrently", async () => {
    const release = tryAcquireServerLock("srv-1", "provision")!;
    expect(await startSync("inst-1", CTX, "clienta-prod")).toEqual({ busy: "provision" });
    release();
  });
});

describe("startSync — happy path", () => {
  it("runs every phase in order and returns the instance to running", async () => {
    const res = await startSync("inst-1", CTX, "clienta-prod");
    expect(res).toEqual({ jobId: syncJobId("inst-1") });

    const { status, lines } = await watchJob(syncJobId("inst-1"));
    expect(status).toBe("ok");
    expect(phases(lines)).toEqual([
      "›connect",
      "✓connect",
      "›dump",
      "✓dump",
      "›snapshot",
      "✓snapshot",
      "›restore",
      "✓restore",
      "›storage",
      "✓storage",
      "›cleanup",
      "✓cleanup",
    ]);
    expect(instanceUpdate).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: { status: "restoring" },
    });
    expect(instanceUpdate).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: { status: "running" },
    });
  });

  it("dumps the source and loads it into the target, snapshotting first", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      // The auth-table probe must report the tables as present.
      if (cmd.includes("pg_tables")) {
        return Promise.resolve(ok("auth.users\nauth.identities\nauth.mfa_factors\n"));
      }
      return Promise.resolve(ok());
    });

    await startSync("inst-1", CTX, "clienta-prod");
    await watchJob(syncJobId("inst-1"));

    const transcript = calls.join("\n");
    // The dump runs inside the instance's own db container, against the source.
    expect(transcript).toContain("pg_dump -Fc --no-owner --no-acl");
    expect(transcript).toContain("--schema='public'");
    expect(transcript).toContain(
      "postgresql://postgres@db.abcdefghijklm.supabase.co:5432/postgres?sslmode=require",
    );
    // Identity data is dumped data-only and loaded with triggers disabled.
    expect(transcript).toContain("--data-only");
    expect(transcript).toContain("--disable-triggers");
    expect(transcript).toContain("TRUNCATE TABLE");
    // Safety snapshot of the CURRENT data lands under backups/.
    expect(transcript).toMatch(/cp db:\/tmp\/wharf-snapshot-\d+\.backup .*backups\/pre-sync-/);
    // The main pass replaces the existing objects.
    expect(transcript).toContain("pg_restore -U postgres -d postgres --clean --if-exists");

    const snapshotAt = calls.findIndex((c) => c.includes("pre-sync-"));
    const restoreAt = calls.findIndex((c) => c.includes("--clean --if-exists"));
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeLessThan(restoreAt);
  });

  it("loads identity data BEFORE the main pass (its TRUNCATE cascades)", async () => {
    const calls: string[] = [];
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("pg_tables")) return Promise.resolve(ok("auth.users\nauth.identities\n"));
      return Promise.resolve(ok());
    });

    await startSync("inst-1", CTX, "clienta-prod");
    await watchJob(syncJobId("inst-1"));

    const truncateAt = calls.findIndex((c) => c.includes("TRUNCATE TABLE"));
    const mainAt = calls.findIndex((c) => c.includes("--clean --if-exists"));
    expect(truncateAt).toBeGreaterThanOrEqual(0);
    expect(truncateAt).toBeLessThan(mainAt);
  });

  // Rows saved before the reserved-schema rule existed still carry these.
  it("drops reserved schemas from a stored source instead of copying them", async () => {
    const calls: string[] = [];
    instanceFindFirst.mockResolvedValue({
      ...ROW,
      syncSource: {
        ...SOURCE,
        extraSchemas: ["realtime", "vault", "supabase_migrations", "billing"],
      },
    });
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(cmd.includes("pg_tables") ? ok("auth.users\n") : ok());
    });

    await startSync("inst-1", CTX, "clienta-prod");
    const { lines } = await watchJob(syncJobId("inst-1"));

    const dumpCmd = calls.find((c) => c.includes("pg_dump -Fc --no-owner"))!;
    expect(dumpCmd).toContain("--schema='public'");
    expect(dumpCmd).toContain("--schema='supabase_migrations'");
    expect(dumpCmd).toContain("--schema='billing'");
    expect(dumpCmd).not.toContain("--schema='realtime'");
    expect(dumpCmd).not.toContain("--schema='vault'");
    expect(lines.join("\n")).toContain("ignoring reserved schema(s) realtime, vault");
  });

  it("skips the identity pass when the source has no auth tables", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) =>
      Promise.resolve(cmd.includes("pg_tables") ? ok("") : ok()),
    );
    await startSync("inst-1", CTX, "clienta-prod");
    const { lines } = await watchJob(syncJobId("inst-1"));
    expect(lines.join("\n")).toContain("no auth tables");
  });

  it("reports the storage phase as skipped when object copying is off", async () => {
    await startSync("inst-1", CTX, "clienta-prod");
    const { lines } = await watchJob(syncJobId("inst-1"));
    expect(lines.join("\n")).toContain("storage object copying is off");
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });

  it("audits the sync with the source's identity but none of its secrets", async () => {
    await startSync("inst-1", CTX, "clienta-prod");
    await watchJob(syncJobId("inst-1"));

    const entry = auditMock.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "instance.sync",
    );
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).toContain("db.abcdefghijklm.supabase.co");
    expect(serialized).not.toContain(SOURCE_PASSWORD);
    expect(serialized).not.toContain(SOURCE_SERVICE_KEY);
  });

  it("records the outcome on the source row for the next re-sync", async () => {
    await startSync("inst-1", CTX, "clienta-prod");
    await watchJob(syncJobId("inst-1"));
    expect(syncSourceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dbInstanceId: "inst-1" },
        data: expect.objectContaining({ lastSyncStatus: "ok" }),
      }),
    );
  });

  it("never emits a credential into the job log", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) =>
      Promise.resolve(cmd.includes("pg_tables") ? ok("auth.users\n") : ok()),
    );
    await startSync("inst-1", CTX, "clienta-prod");
    const { lines } = await watchJob(syncJobId("inst-1"));
    const log = lines.join("\n");
    for (const secret of [
      SOURCE_PASSWORD,
      SOURCE_SERVICE_KEY,
      TARGET_PASSWORD,
      TARGET_SERVICE_KEY,
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe("startSync — storage objects", () => {
  const STORAGE_ROW = {
    ...ROW,
    syncSource: { ...SOURCE, includeStorageObjects: true },
  };

  function storageAwareExec(calls: string[]) {
    return (
      _c: unknown,
      cmd: string,
      opts?: { onStdout?: (chunk: string) => void },
    ) => {
      calls.push(cmd);
      if (cmd.includes("pg_tables")) {
        return Promise.resolve(ok("auth.users\nstorage.buckets\nstorage.objects\n"));
      }
      if (cmd.includes("storage.objects o join")) {
        return Promise.resolve(ok("avatars\tuser a/1.png\timage/png\n"));
      }
      if (cmd.includes("sync-storage-")) {
        // The real exec streams stdout as it arrives (lib/ssh.ts) — that is
        // how the copy loop's progress reaches the job log.
        const out = "PROGRESS 1/1\nDONE ok=1 failed=0\n";
        opts?.onStdout?.(out);
        return Promise.resolve(ok(out));
      }
      return Promise.resolve(ok());
    };
  }

  it("uploads a manifest and a 0600 env file, then runs the copy script", async () => {
    const calls: string[] = [];
    instanceFindFirst.mockResolvedValue({ ...STORAGE_ROW });
    execMock.mockImplementation(storageAwareExec(calls));

    await startSync("inst-1", CTX, "clienta-prod");
    const { status, lines } = await watchJob(syncJobId("inst-1"));
    expect(status).toBe("ok");

    const writes = sftpWriteMock.mock.calls as [unknown, string, string, number][];
    const manifest = writes.find((w) => w[1].includes("sync-manifest-"))!;
    // Object paths reach the shell already percent-encoded.
    expect(manifest[2]).toBe("avatars\tuser%20a/1.png\timage/png");
    expect(manifest[3]).toBe(0o600);

    const envWrite = writes.find((w) => w[1].includes("sync-env-"))!;
    expect(envWrite[3]).toBe(0o600);
    expect(envWrite[2]).toContain(`SRC_TOKEN='${SOURCE_SERVICE_KEY}'`);
    expect(envWrite[2]).toContain(`DST_TOKEN='${TARGET_SERVICE_KEY}'`);
    expect(envWrite[2]).toContain("DST_URL='https://clienta.wharf.example.com'");

    // The script is invoked with the env file as its only argument, so the
    // tokens never appear in the command line itself.
    const runCall = calls.find((c) => c.startsWith("sh "))!;
    expect(runCall).toContain("sync-env-");
    expect(runCall).not.toContain(SOURCE_SERVICE_KEY);
    expect(runCall).not.toContain(TARGET_SERVICE_KEY);

    // And the env file is removed even before the cleanup phase.
    expect(calls.filter((c) => c.includes("rm -f") && c.includes("sync-env-")).length)
      .toBeGreaterThanOrEqual(1);

    expect(lines.join("\n")).toContain("DONE ok=1 failed=0");
  });

  it("fails the job when curl is missing rather than silently skipping files", async () => {
    instanceFindFirst.mockResolvedValue({ ...STORAGE_ROW });
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_tables")) return Promise.resolve(ok("storage.objects\n"));
      if (cmd.startsWith("command -v curl")) return Promise.resolve(fail(""));
      return Promise.resolve(ok());
    });

    await startSync("inst-1", CTX, "clienta-prod");
    const { status, lines } = await watchJob(syncJobId("inst-1"));
    expect(status).toBe("error");
    expect(lines.join("\n")).toContain("curl is not installed");
  });
});

describe("startSync — failure handling", () => {
  it("marks the instance errored and audits the failure when the source refuses", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) =>
      Promise.resolve(cmd.includes("psql") ? fail("password authentication failed") : ok()),
    );

    await startSync("inst-1", CTX, "clienta-prod");
    const { status, lines } = await watchJob(syncJobId("inst-1"));

    expect(status).toBe("error");
    expect(lines.join("\n")).toContain("password authentication failed");
    expect(instanceUpdate).toHaveBeenLastCalledWith({
      where: { id: "inst-1" },
      data: { status: "error", lastActionLog: expect.any(String) },
    });
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { action: string }).action === "instance.sync.failed",
      ),
    ).toBe(true);
  });

  it("releases the server lock after a failure", async () => {
    execMock.mockResolvedValue(fail("nope"));
    await startSync("inst-1", CTX, "clienta-prod");
    await watchJob(syncJobId("inst-1"));

    const release = tryAcquireServerLock("srv-1", "provision");
    expect(release).not.toBeNull();
    release?.();
  });

  it("refuses to write outside the instance's own directory", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, remotePath: "/etc" });
    await startSync("inst-1", CTX, "clienta-prod");
    const { status, lines } = await watchJob(syncJobId("inst-1"));
    expect(status).toBe("error");
    expect(lines.join("\n")).toContain("REFUSING TO SYNC INTO /etc");
  });
});

describe("testSyncSource", () => {
  it("probes without changing anything and reports the source's version", async () => {
    execMock.mockResolvedValue(ok("postgres · PostgreSQL 17.4\n"));
    const res = await testSyncSource("inst-1");
    expect(res).toEqual({ ok: true, detail: "postgres · PostgreSQL 17.4" });
    const cmds = execMock.mock.calls.map((c) => c[1] as string);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("select current_database()");
  });

  it("returns the source's own error text instead of throwing", async () => {
    execMock.mockResolvedValue(fail("could not translate host name"));
    expect(await testSyncSource("inst-1")).toEqual({
      ok: false,
      detail: "could not translate host name",
    });
  });

  it("reports an unreachable managed server as ok:false, never as a throw", async () => {
    withConnectionMock.mockRejectedValue(new Error("connect ETIMEDOUT 203.0.113.7:22"));
    expect(await testSyncSource("inst-1")).toEqual({
      ok: false,
      detail: "connect ETIMEDOUT 203.0.113.7:22",
    });
  });

  it("reports a changed host key the same way", async () => {
    withConnectionMock.mockRejectedValue(new Error("host key changed for srv-1"));
    const res = await testSyncSource("inst-1");
    expect(res).toEqual({ ok: false, detail: expect.stringContaining("host key changed") });
  });

  it("still releases the lock when the connection throws", async () => {
    withConnectionMock.mockRejectedValue(new Error("nope"));
    await testSyncSource("inst-1");
    const release = tryAcquireServerLock("srv-1", "provision");
    expect(release).not.toBeNull();
    release?.();
  });

  it("refuses when no source is configured", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, syncSource: null });
    expect(await testSyncSource("inst-1")).toEqual({
      invalid: expect.stringContaining("No sync source is configured"),
    });
  });

  it("releases the lock so a real sync can follow immediately", async () => {
    await testSyncSource("inst-1");
    const release = tryAcquireServerLock("srv-1", "provision");
    expect(release).not.toBeNull();
    release?.();
  });
});
