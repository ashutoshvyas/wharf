import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: (...a: unknown[]) => sftpWriteMock(...a),
}));

import {
  countFailedStatements,
  looksLikeCustomFormatDump,
  parseTableList,
  reassertSchemaPrivileges,
} from "./restore-core";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

describe("looksLikeCustomFormatDump", () => {
  it("is true for a buffer starting with the PGDMP magic", () => {
    expect(looksLikeCustomFormatDump(Buffer.from("PGDMP\x01\x0dsome archive bytes"))).toBe(true);
  });

  it("is false for a plain-text SQL dump, regardless of its extension", () => {
    expect(
      looksLikeCustomFormatDump(Buffer.from("-- PostgreSQL database dump\nselect 1;\n")),
    ).toBe(false);
  });

  it("is false for an empty buffer", () => {
    expect(looksLikeCustomFormatDump(Buffer.alloc(0))).toBe(false);
  });

  it("is false when the magic appears anywhere but the start", () => {
    expect(looksLikeCustomFormatDump(Buffer.from("xPGDMP"))).toBe(false);
  });
});

describe("countFailedStatements", () => {
  // The distinction that matters: a non-zero exit code alone cannot tell
  // "harmless ownership noise" from "objects were not created".
  it("reads pg_restore's own ignored-error summary", () => {
    const out =
      "pg_restore: error: could not execute query: ERROR:  type extensions.vector does not exist\n" +
      "pg_restore: warning: errors ignored on restore: 4";
    expect(countFailedStatements(out, false)).toBe(4);
  });

  it("is 0 when pg_restore reported no failures at all", () => {
    expect(countFailedStatements("pg_restore: connecting to database\n", false)).toBe(0);
  });

  // The pre-existing test fixture's wording — a warning line with no count.
  it("is 0 for a warning that carries no number", () => {
    expect(countFailedStatements("WARNING: errors ignored on restore", false)).toBe(0);
  });

  it("falls back to counting error lines when there is no summary", () => {
    const out = "pg_restore: error: one\npg_restore: error: two\n";
    expect(countFailedStatements(out, false)).toBe(2);
  });

  it("counts psql's ERROR lines, which have no summary line", () => {
    const out =
      'psql:/tmp/d.sql:12: ERROR:  type "vector" does not exist\n' +
      "ERROR:  relation \"x\" already exists\n" +
      "NOTICE:  something harmless\n";
    expect(countFailedStatements(out, true)).toBe(2);
  });

  it("does not count the word ERROR inside ordinary output", () => {
    expect(countFailedStatements("copying table ERROR_LOG\n", true)).toBe(0);
  });
});

describe("parseTableList", () => {
  it("returns one trimmed name per line, dropping blanks", () => {
    expect(parseTableList("public.a\n public.b \n\n")).toEqual(["public.a", "public.b"]);
  });

  it("is empty for empty output", () => {
    expect(parseTableList("\n  \n")).toEqual([]);
  });
});

describe("reassertSchemaPrivileges", () => {
  const target = { compose: "docker compose -p sb_4f2a", pgEnv: "-e PGPASSWORD=x", user: "supabase_admin" };
  const paths = { remotePath: "/opt/db-instances/sb_4f2a/restore/privileges-1.sql", containerPath: "/tmp/wharf-privileges-1.sql" };

  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockResolvedValue(ok());
    sftpWriteMock.mockResolvedValue(undefined);
  });

  it("does nothing when no schemas were restored", async () => {
    const emit = vi.fn();
    await reassertSchemaPrivileges({} as never, target, [], paths, emit);
    expect(sftpWriteMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("re-owns tables/sequences/views/functions and re-grants the data-access roles", async () => {
    const emit = vi.fn();
    await reassertSchemaPrivileges({} as never, target, ["public"], paths, emit);

    expect(sftpWriteMock).toHaveBeenCalledTimes(1);
    const [, writtenPath, sql, mode] = sftpWriteMock.mock.calls[0]!;
    expect(writtenPath).toBe(paths.remotePath);
    expect(mode).toBe(0o600);

    // Ownership is reassigned via dynamic SQL scoped to the restored schema.
    expect(sql).toContain("pg_tables WHERE schemaname = 'public'");
    expect(sql).toContain("ALTER TABLE %I.%I OWNER TO postgres");
    expect(sql).toContain("ALTER SEQUENCE %I.%I OWNER TO postgres");
    expect(sql).toContain("ALTER VIEW %I.%I OWNER TO postgres");
    expect(sql).toContain("ALTER MATERIALIZED VIEW %I.%I OWNER TO postgres");
    expect(sql).toContain("ALTER ROUTINE %s OWNER TO postgres");

    // Existing objects are re-granted, and the rule is set up for future ones too.
    expect(sql).toContain('GRANT ALL ON ALL TABLES IN SCHEMA "public" TO postgres, anon, authenticated, service_role;');
    expect(sql).toContain('GRANT USAGE ON SCHEMA "public" TO postgres, anon, authenticated, service_role;');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "public" GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;',
    );

    // Loaded into the container as the connecting (superuser) role, not postgres.
    const applyCmd = execMock.mock.calls.find((c) => String(c[1]).includes("-f " + paths.containerPath))![1] as string;
    expect(applyCmd).toContain("-U supabase_admin");

    expect(emit).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("re-asserted ownership and privileges"),
    );
  });

  it("covers every schema passed in, not just the first", async () => {
    const emit = vi.fn();
    await reassertSchemaPrivileges({} as never, target, ["public", "billing"], paths, emit);
    const [, , sql] = sftpWriteMock.mock.calls[0]!;
    expect(sql).toContain('schemaname = \'public\'');
    expect(sql).toContain('schemaname = \'billing\'');
    expect(sql).toContain('SCHEMA "billing"');
  });

  it("safely quotes a schema name containing a double quote", async () => {
    const emit = vi.fn();
    await reassertSchemaPrivileges({} as never, target, ['weird"schema'], paths, emit);
    const [, , sql] = sftpWriteMock.mock.calls[0]!;
    expect(sql).toContain('"weird""schema"');
  });

  it("reports loudly, but does not throw, when applying the script fails", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("-f " + paths.containerPath)) {
        return Promise.resolve(fail('ERROR: permission denied'));
      }
      return Promise.resolve(ok());
    });
    const emit = vi.fn();
    await expect(
      reassertSchemaPrivileges({} as never, target, ["public"], paths, emit),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("could not re-assert ownership/privileges"),
    );
  });

  it("cleans up the temp SQL file from both the container and the host", async () => {
    const emit = vi.fn();
    await reassertSchemaPrivileges({} as never, target, ["public"], paths, emit);
    const cmds = execMock.mock.calls.map((c) => c[1] as string);
    expect(cmds.some((c) => c.includes(`rm -f ${paths.containerPath}`))).toBe(true);
    expect(cmds.some((c) => c.includes(`rm -f`) && c.includes(paths.remotePath))).toBe(true);
  });
});
