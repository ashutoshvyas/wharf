import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";

const execMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
}));

const ensurePoolerSecretsMock = vi.fn();
vi.mock("@/lib/bootstrap/pooler-secrets", () => ({
  ensurePoolerSecrets: (...a: unknown[]) => ensurePoolerSecretsMock(...a),
}));

import { deregisterPoolerTenant, registerPoolerTenant } from "./pooler";

const CONN = { conn: true } as never;
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 22, stdout: "", stderr });
const API_JWT_SECRET = "s".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
  ensurePoolerSecretsMock.mockResolvedValue({ apiJwtSecret: API_JWT_SECRET });
  execMock.mockResolvedValue(ok());
});

describe("registerPoolerTenant", () => {
  it("PUTs the tenant with db_host set to the project's pooler alias, bearer-authenticated", async () => {
    await registerPoolerTenant(CONN, {
      serverId: "srv-1",
      project: "sb_4f2a",
      pgPassword: "PgPass123",
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    const [conn, cmd] = execMock.mock.calls[0] as [unknown, string];
    expect(conn).toBe(CONN);
    expect(cmd).toContain("curl -fsS -X PUT");
    expect(cmd).toContain("http://127.0.0.1:4000/api/tenants/sb_4f2a");

    const bearer = /Authorization: Bearer ([\w.-]+)/.exec(cmd)?.[1];
    expect(bearer).toBeTruthy();
    const { payload } = await jwtVerify(bearer!, new TextEncoder().encode(API_JWT_SECRET));
    expect(payload.role).toBe("service_role");

    const body = /-d '(\{.*\})'/.exec(cmd)?.[1];
    expect(JSON.parse(body!)).toEqual({
      tenant: {
        db_host: "sb_4f2a-db",
        db_port: 5432,
        db_database: "postgres",
        default_pool_size: 15,
        default_max_clients: 200,
        users: [
          {
            db_user: "postgres",
            db_password: "PgPass123",
            pool_size: 15,
            mode_type: "transaction",
            is_manager: true,
          },
        ],
      },
    });
  });

  it("throws with the curl failure surfaced when registration fails", async () => {
    execMock.mockResolvedValue(fail("connection refused"));
    await expect(
      registerPoolerTenant(CONN, { serverId: "srv-1", project: "sb_4f2a", pgPassword: "x" }),
    ).rejects.toThrow(/Supavisor tenant registration failed.*connection refused/s);
  });
});

describe("deregisterPoolerTenant", () => {
  it("DELETEs the tenant, bearer-authenticated", async () => {
    await deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a");
    const [, cmd] = execMock.mock.calls[0] as [unknown, string];
    expect(cmd).toContain("curl -fsS -X DELETE");
    expect(cmd).toContain("http://127.0.0.1:4000/api/tenants/sb_4f2a");
  });

  it("throws with the curl failure surfaced when deregistration fails", async () => {
    execMock.mockResolvedValue(fail("404 not found"));
    await expect(deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a")).rejects.toThrow(
      /Supavisor tenant deregistration failed.*404 not found/s,
    );
  });
});
